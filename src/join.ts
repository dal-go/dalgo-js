import { requireUnannotatedQueryInput } from "./source-rights.js";
import type { SourceIdentity } from "./source-rights.js";
import { canonicalProviderEvidence } from "./provider-reads.js";
import {
  captureSourceLeaf, compositionSize, MAX_COMPOSITION_INPUTS, SOURCE_COMPOSITION_FORMAT,
  snapshotSourceComposition, snapshotSourceLeafAdmission, validateSourceLeafAdmission, validateSourceScanScope,
  type SourceComposition, type SourceCompositionInput, type SourceLeafAdmission, type SourceScanScope,
} from "./source-composition.js";
import { declarationId, validateSourceIdentity } from "./source-declarations.js";
import { containsAggregate, effectiveColumns, expressionText, hasAggregation, hasDistinctAggregate } from "./aggregation.js";
import { evaluateCondition, isMembership, nullTestTruth, toCondition, walkConditionExpressions, type DTQLLeaf, type Truth } from "./condition.js";
import type { QueryExecutor } from "./database.js";
import type { DTQLSchema } from "./dtql.js";
import { Key } from "./key.js";
import type { ExistingRecord } from "./record.js";
import type {
  DTQLComparison,
  DTQLCondition,
  DTQLExpression,
  DTQLQueryFilter,
  JoinedDTQLQuery,
  QueryFieldReference,
  QueryJoinPredicate,
  QueryJoinAlgorithm,
  QueryColumn,
  QueryRelation,
  QueryPage,
  StructuredQuery,
} from "./query.js";

type Data = Record<string, unknown>;
type StoredRow = ExistingRecord<Data>;

interface JoinedRow {
  readonly aliases: ReadonlyMap<string, StoredRow | undefined>;
  readonly root: StoredRow;
}

interface MaterializedRow {
  readonly row: JoinedRow;
  readonly group: readonly JoinedRow[];
}

export type SelectedJoinAlgorithm = "hash" | "nestedLoop";

export interface JoinedQueryExecutionOptions {
  /** Opt in to base-10 decimal text results for streaming SUM, AVG and arithmetic. */
  readonly money?: { readonly minorUnitScale: number; readonly divisionScale: number; readonly rounding: "halfEven" };
  /** Output page size for the lazy flat joined-row stream (default 500). */
  readonly pageSize?: number;
  /** Selects a secured executor for each named database. */
  readonly resolveExecutor?: (relation: QueryRelation) => QueryExecutor;
  /** Paged source transport for the streaming aggregate plan. */
  readonly scanPages?: (relation: QueryRelation, query: StructuredQuery<Data>) => AsyncIterable<QueryPage<Data>>;
  readonly onProgress?: (progress: JoinedQueryProgress) => void;
  readonly maxFetchedRows?: number;
  readonly maxResultRows?: number;
  readonly maxCandidateEvaluations?: number;
  readonly maxRetainedBytes?: number;
  /** The parse-time schema used for source-qualified wildcard expansion. */
  readonly schema?: DTQLSchema;
  /**
   * Maps a DTQL relation to an adapter source. Required when a relation names
   * a schema because the legacy QueryExecutor has no schema namespace.
   */
  readonly resolveSource?: (relation: QueryRelation) => StructuredQuery<Data>["source"];
}

export interface JoinedQueryProgress {
  readonly phase: "download" | "process";
  readonly database?: string;
  readonly rows: number;
}

export interface AdmittedMaterializedJoinInput {
  /** Exact secured executor retained before any source I/O. */
  readonly executor: QueryExecutor;
  readonly source: SourceIdentity;
  readonly semanticRef: string;
  /** Exact independently admitted query, including its source and scan bound. */
  readonly scanQuery: StructuredQuery<Data>;
  readonly scope: SourceScanScope;
  readonly admission: SourceLeafAdmission;
}

export interface SourceCompositionJoinOptions extends Omit<JoinedQueryExecutionOptions, "resolveExecutor" | "scanPages" | "money" | "pageSize"> {
  readonly compositionId: string;
  readonly maxMetadataBytes?: number;
  /** All callbacks run synchronously before the first await or source query. */
  readonly resolveInput: (relation: QueryRelation, relationPath: string) => AdmittedMaterializedJoinInput;
}

interface PreparedCompositionScan extends Omit<AdmittedMaterializedJoinInput, "scanQuery"> {
  readonly execute: QueryExecutor["query"];
  readonly query: StructuredQuery<Data>;
  readonly scanId: string;
  readonly relationPath: string;
}
interface CompositionExecution {
  readonly options: SourceCompositionJoinOptions;
  readonly inputs: SourceCompositionInput[];
  prepared?: ReadonlyMap<QueryRelation, PreparedCompositionScan>;
}

type ExecutionLimits = Required<Omit<JoinedQueryExecutionOptions, "schema" | "resolveSource" | "resolveExecutor" | "scanPages" | "onProgress" | "money" | "pageSize">>;

const defaults: ExecutionLimits = {
  maxFetchedRows: 10_000,
  maxResultRows: 10_000,
  maxCandidateEvaluations: 100_000,
  maxRetainedBytes: 16 * 1024 * 1024,
};

/**
 * Executes a parsed relation tree by scanning each relation once through the
 * existing single-source executor. This deliberately remains a separate entry
 * point: legacy `QueryExecutor.query(StructuredQuery)` never receives joins.
 *
 * Pass the same schema used by `parseDTQL` when the query has wildcard
 * projections. For schema-qualified relations, pass `resolveSource` so the
 * adapter, rather than this generic executor, defines its source namespace.
 */
export async function executeJoinedDTQLQuery(
  executor: QueryExecutor,
  query: JoinedDTQLQuery,
  options: JoinedQueryExecutionOptions = {},
): Promise<QueryPage<Data>> {
  return executeMaterializedJoin(executor, query, options);
}

/**
 * Explicit JS-local, materialized-only rights route. No recursive, streaming,
 * composed-leaf, Go/OVDB, persistence or export capability is implied.
 */
export async function executeSourceComposedJoinedDTQLQuery(
  query: JoinedDTQLQuery,
  options: SourceCompositionJoinOptions,
): Promise<QueryPage<Data>> {
  for (const unsupported of ["scanPages", "money", "pageSize", "resolveExecutor"]) {
    if (unsupported in options) planError(unsupported, "unsupported composed join option");
  }
  // Read and detach caller structures before resolvers or I/O can mutate them.
  const capturedQuery = structuredClone(query);
  if (capturedQuery.money !== undefined) planError("money", "unsupported composed join option");
  const capturedOptions: SourceCompositionJoinOptions = { ...options };
  if (capturedOptions.schema !== undefined) Object.assign(capturedOptions, { schema: structuredClone(capturedOptions.schema) });
  declarationId(capturedOptions.compositionId);
  compositionSize({}, capturedOptions.maxMetadataBytes);
  const composition: CompositionExecution = { options: capturedOptions, inputs: [] };
  const unreachable: QueryExecutor = { query: () => { throw new Error("unadmitted executor"); } };
  return executeMaterializedJoin(unreachable, capturedQuery, capturedOptions, composition);
}

async function executeMaterializedJoin(
  executor: QueryExecutor,
  query: JoinedDTQLQuery,
  options: JoinedQueryExecutionOptions,
  composition?: CompositionExecution,
): Promise<QueryPage<Data>> {
  const money = options.money ?? query.money;
  if (money !== undefined) {
    validateMoney(money);
    if (options.scanPages === undefined || !canStreamJoinedAggregate(query)) planError("money", "exact decimals require the streaming aggregate plan");
  }
  if (options.scanPages !== undefined && canStreamJoinedAggregate(query)) return executeStreamingJoinedAggregateQuery(query, { ...options, ...(money === undefined ? {} : { money }) });
  const limits: ExecutionLimits = {
    maxFetchedRows: options.maxFetchedRows ?? defaults.maxFetchedRows,
    maxResultRows: options.maxResultRows ?? defaults.maxResultRows,
    maxCandidateEvaluations: options.maxCandidateEvaluations ?? defaults.maxCandidateEvaluations,
    maxRetainedBytes: options.maxRetainedBytes ?? defaults.maxRetainedBytes,
  };
  validateLimits(limits);
  validateRelationShape(query.from, new WeakSet(), "from");
  const from = snapshotRelationHints(query.from);
  const aliases = new Map<string, QueryRelation>();
  const nodes: QueryRelation[] = [];
  collectRelations(from, aliases, nodes, new WeakSet(), "from");
  validateExecutionScopes(from, new Set(), "from");
  const expandedQuery = expandQueryColumns(query, aliases, options.schema);
  validateClauseSources(expandedQuery, aliases);
  const effectiveQuery = withDerivedColumns(expandedQuery);
  const keyReferences = collectKeyReferences(from, aliases);
  if (composition !== undefined) {
    composition.prepared = prepareCompositionScans(from, nodes, limits, composition.options);
    for (const scan of composition.prepared.values()) await validateSourceLeafAdmission(scan.admission);
  }
  const cached = await scanRelations(executor, nodes, keyReferences, limits, options.resolveSource, options.resolveExecutor, options.onProgress, composition);
  const relationAliases = aliasesFor(from);
  let rows = await evaluateRelation(from, new Map(), cached, limits, { candidates: 0 }, undefined, "from");
  rows = rows.filter((row) => effectiveQuery.filters.every((filter) => matchesWhere(row, filter)));
  options.onProgress?.({ phase: "process", rows: rows.length });

  const materialized = materialize(rows, effectiveQuery, limits);
  const ordered = stableOrder(materialized, effectiveQuery);
  const start = effectiveQuery.offset ?? 0;
  const end = effectiveQuery.limit === undefined ? undefined : start + effectiveQuery.limit;
  const toRecord = (item: MaterializedRow): ExistingRecord<Data> => ({ key: item.row.root.key, exists: true as const, data: project(item, effectiveQuery, relationAliases) });
  // Go finishes every group before it applies OFFSET and LIMIT, so an error in a group's output is not hidden by paging.
  const page = hasAggregation(effectiveQuery) ? ordered.map(toRecord).slice(start, end) : ordered.slice(start, end).map(toRecord);
  return { records: page, ...(composition === undefined ? {} : { sourceComposition: finishComposition(composition) }) };
}

function finishComposition(composition: CompositionExecution, snapshot = true): SourceComposition {
  const envelope: SourceComposition = {
    format: SOURCE_COMPOSITION_FORMAT, operation: "join", compositionId: composition.options.compositionId, inputs: composition.inputs,
  };
  compositionSize(envelope, composition.options.maxMetadataBytes);
  return snapshot ? snapshotSourceComposition(envelope) : envelope;
}

function prepareCompositionScans(
  from: QueryRelation,
  nodes: readonly QueryRelation[],
  limits: ExecutionLimits,
  options: SourceCompositionJoinOptions,
): ReadonlyMap<QueryRelation, PreparedCompositionScan> {
  if (nodes.length > MAX_COMPOSITION_INPUTS) planError("from", "composition input bound exceeded");
  const paths = new Map<QueryRelation, string>();
  const visit = (relation: QueryRelation, path: string): void => {
    paths.set(relation, path);
    relation.joins.forEach((join, index) => { visit(join.from, `${path}.joins[${index.toString()}].from`); });
  };
  visit(from, "from");
  const scans = new Map<QueryRelation, PreparedCompositionScan>();
  const preflights: unknown[] = [];
  for (const [index, relation] of nodes.entries()) {
    const path = paths.get(relation);
    if (path === undefined) throw new Error("missing relation path");
    // Give callbacks detached ASTs; capture resolved source before the callback.
    const source = structuredClone(relationSource(structuredClone(relation), options.resolveSource));
    const raw = options.resolveInput(structuredClone(relation), path);
    const executor = raw.executor;
    const execute = executor.query;
    const captured = structuredClone({ source: raw.source, semanticRef: raw.semanticRef, scanQuery: raw.scanQuery, scope: raw.scope, admission: raw.admission });
    preflights.push(captured);
    compositionSize(preflights, options.maxMetadataBytes);
    validateSourceIdentity(captured.source); declarationId(captured.semanticRef); validateSourceScanScope(captured.scope);
    if (typeof execute !== "function") planError(path, "missing admitted executor");
    const admission = snapshotSourceLeafAdmission(captured.admission);
    const scope = captured.scope;
    if (scope.requestedLimit > limits.maxFetchedRows) planError(path, "scan bound exceeds fetched-row budget");
    if (scope.kind === "bounded") {
      if (relation.scan?.limit !== scope.requestedLimit) planError(path, "bounded semantics require explicit relation scan");
      if (scope.ordering !== ((relation.scan.orderBy.length === 0) ? "unspecified" : "specified")) planError(path, "bounded ordering mismatch");
    } else {
      if (relation.scan !== undefined) planError(path, "complete scan cannot replace explicit bounded relation");
      if (scope.proof === "ecb-full-decoded-feed" && admission.kind !== "provider-get") planError(path, "ECB scan requires GET admission");
      if (scope.proof === "immutable-local-array" && admission.kind === "provider-get") planError(path, "local array cannot use live GET admission");
      if (admission.kind === "unknown-local" && scope.proof !== "immutable-local-array") planError(path, "unknown rights only admitted for local array");
    }
    const expected: StructuredQuery<Data> = { source, filters: [], orders: relation.scan?.orderBy ?? [], limit: scope.requestedLimit };
    if (canonicalProviderEvidence(captured.scanQuery) !== canonicalProviderEvidence(expected)) planError(path, "scan query admission mismatch");
    scans.set(relation, { executor, execute: execute.bind(executor), source: captured.source, semanticRef: captured.semanticRef, scope, admission,
      query: captured.scanQuery, scanId: `scan-${index.toString()}`, relationPath: path });
  }
  return scans;
}

function expandQueryColumns(query: JoinedDTQLQuery, aliases: ReadonlyMap<string, QueryRelation>, schema: DTQLSchema | undefined): JoinedDTQLQuery {
  return query.columns === undefined ? query : { ...query, columns: expandColumns(query.columns, aliases, schema) };
}

/**
 * For an aggregate query without `columns`, the group keys become its
 * projection (an ungrouped aggregate query projects an empty row), as the Go
 * engine does, rather than the first row of every group.
 */
function withDerivedColumns(query: JoinedDTQLQuery): JoinedDTQLQuery {
  const columns = effectiveColumns(query);
  return columns === undefined || columns === query.columns ? query : { ...query, columns };
}

function validateRelationShape(value: unknown, ancestors: WeakSet<object>, path: string): void {
  const relation = shapeObject(value, path);
  if (typeof relation.name !== "string" || relation.name.length === 0) shapeError(`${path}.name`, "relation name is required");
  if (relation.alias !== undefined && (typeof relation.alias !== "string" || relation.alias.length === 0)) shapeError(`${path}.alias`, "alias must be a non-empty string");
  if (ancestors.has(relation)) cycleError(path);
  ancestors.add(relation);
  try {
    const joins = relation.joins;
    if (!Array.isArray(joins)) shapeError(`${path}.joins`, "joins must be an array");
    joins.forEach((joinValue, index) => {
      const joinPath = `${path}.joins[${index.toString()}]`;
      const join = shapeObject(joinValue, joinPath);
      if (join.type !== undefined && join.type !== "inner" && join.type !== "left") typeError(`${joinPath}.type`, "unsupported join type");
      validateJoinHints(join.hints, `${joinPath}.hints`);
      const on = join.on;
      if (!Array.isArray(on) || on.length === 0) shapeError(`${joinPath}.on`, "ON must be a non-empty array");
      on.forEach((predicateValue, predicateIndex) => {
        const predicatePath = `${joinPath}.on[${predicateIndex.toString()}]`;
        const predicate = shapeObject(predicateValue, predicatePath);
        if (predicate.operator !== "==") operatorError(`${predicatePath}.op`, `unsupported join operator ${String(predicate.operator)}`);
        validateJoinReferenceShape(predicate.left, `${predicatePath}.left`);
        validateJoinReferenceShape(predicate.right, `${predicatePath}.right`);
      });
      validateRelationShape(join.from, ancestors, `${joinPath}.from`);
    });
  } finally {
    ancestors.delete(relation);
  }
}

const joinAlgorithms = new Set<QueryJoinAlgorithm>(["hash", "merge", "lookup", "batchedLookup", "nestedLoop"]);

function validateJoinHints(value: unknown, path: string): void {
  if (value === undefined) return;
  if (value === null || Array.isArray(value) || typeof value !== "object") algorithmError(`${path}.algorithms`, "hints must be an object");
  const hints = value as Record<string, unknown>;
  for (const key of Object.keys(hints)) if (key !== "algorithms") algorithmError(`${path}.algorithms`, `unsupported hints key ${key}`);
  const algorithms = hints.algorithms;
  if (!Array.isArray(algorithms) || algorithms.length === 0) algorithmError(`${path}.algorithms`, "must be a non-empty array");
  assertDenseAlgorithms(algorithms, `${path}.algorithms`);
  const seen = new Set<QueryJoinAlgorithm>();
  algorithms.forEach((algorithm, index) => {
    const entryPath = `${path}.algorithms[${index.toString()}]`;
    if (typeof algorithm !== "string" || !joinAlgorithms.has(algorithm as QueryJoinAlgorithm)) algorithmError(entryPath, `unsupported algorithm ${String(algorithm)}`);
    const typed = algorithm as QueryJoinAlgorithm;
    if (seen.has(typed)) algorithmError(entryPath, `duplicate algorithm ${typed}`);
    seen.add(typed);
  });
}

function assertDenseAlgorithms(algorithms: readonly unknown[], path: string): void {
  for (let index = 0; index < algorithms.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(algorithms, index)) algorithmError(`${path}[${index.toString()}]`, "algorithm entry is required");
  }
}

function snapshotRelationHints(relation: QueryRelation): QueryRelation {
  return {
    ...relation,
    joins: relation.joins.map((join) => ({
      ...join,
      from: snapshotRelationHints(join.from),
      ...(join.hints === undefined ? {} : { hints: { algorithms: [...join.hints.algorithms] } }),
    })),
  };
}

/**
 * Picks the executable generic strategy for one JOIN edge. Unavailable
 * preferences are skipped; `nestedLoop` deliberately bypasses a hash index.
 */
export function selectJoinAlgorithm(
  hints: readonly QueryJoinAlgorithm[] | undefined,
  hashAvailable: boolean,
): SelectedJoinAlgorithm {
  for (const algorithm of hints ?? []) {
    if (algorithm === "nestedLoop") return "nestedLoop";
    if (algorithm === "hash" && hashAvailable) return "hash";
  }
  return hashAvailable ? "hash" : "nestedLoop";
}

function shapeObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") shapeError(path, "must be an object");
  return value as Record<string, unknown>;
}

function validateJoinReferenceShape(value: unknown, path: string): void {
  const reference = shapeObject(value, path);
  if (typeof reference.field !== "string" || reference.field.length === 0 || typeof reference.source !== "string" || reference.source.length === 0) {
    shapeError(path, "ON operands must be qualified fields");
  }
}

function validateClauseSources(query: JoinedDTQLQuery, aliases: ReadonlyMap<string, QueryRelation>): void {
  const field = (reference: QueryFieldReference, path: string): void => {
    if (!aliases.has(reference.source)) scopeError(`${path}.source`, `unknown alias ${reference.source}`);
  };
  const expression = (value: DTQLExpression, path: string): void => {
    switch (value.kind) {
      case "field": field(value.field, path); return;
      case "aggregate": value.args.forEach((argument, index) => { expression(argument, `${path}.aggregate.args[${index.toString()}]`); }); return;
      case "binary": expression(value.left, `${path}.binary.left`); expression(value.right, `${path}.binary.right`); return;
      default: return;
    }
  };
  query.filters.forEach((filter, index) => { walkConditionExpressions(toCondition(filter), `where[${index.toString()}]`, expression); });
  query.orders.forEach((order, index) => {
    if (order.expression === undefined) field(order.field, `orderBy[${index.toString()}]`);
    else expression(order.expression, `orderBy[${index.toString()}]`);
  });
  query.columns?.forEach((column, index) => {
    if (column.expression !== undefined) expression(column.expression, `columns[${index.toString()}]`);
  });
  query.groupBy?.forEach((group, index) => { expression(group, `groupBy[${index.toString()}]`); });
  if (query.having !== undefined) walkConditionExpressions(query.having, "having", expression);
}

function expandColumns(
  columns: readonly QueryColumn[],
  aliases: ReadonlyMap<string, QueryRelation>,
  schema: DTQLSchema | undefined,
): readonly QueryColumn[] {
  const expanded: QueryColumn[] = [];
  const names = new Set<string>();
  columns.forEach((column, index) => {
    if (column.wildcard === undefined) {
      const name = columnOutput(column, `columns[${index.toString()}]`);
      if (names.has(name)) planError(`columns[${index.toString()}]`, `duplicate output key ${name}`);
      names.add(name);
      expanded.push(column);
      return;
    }
    const source = column.wildcard.source;
    if (source === undefined) planError(`columns[${index.toString()}].wildcard.source`, "joined wildcard must name a source");
    const relation = aliases.get(source);
    if (relation === undefined) planError(`columns[${index.toString()}].wildcard.source`, `unknown alias ${source}`);
    const tables = schema?.tables.filter((table) => table.name === relation.name &&
      (relation.schema === undefined || table.schema === relation.schema) &&
      (relation.database === undefined || table.database === undefined || table.database === relation.database));
    if (tables?.length !== 1) planError(`columns[${index.toString()}].wildcard`, "wildcard expansion requires ordered schema metadata");
    const table = tables[0];
    if (table === undefined) planError(`columns[${index.toString()}].wildcard`, "wildcard expansion requires ordered schema metadata");
    const ordered = table.fields;
    const excluded = new Set(column.wildcard.exclude);
    for (const field of ordered) {
      if (excluded.has(field)) continue;
      if (names.has(field)) planError(`columns[${index.toString()}]`, `duplicate output key ${field}`);
      names.add(field);
      expanded.push({ expression: { kind: "field", field: { source, field } } });
    }
  });
  return expanded;
}

function validateLimits(limits: ExecutionLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function collectRelations(
  relation: QueryRelation,
  aliases: Map<string, QueryRelation>,
  nodes: QueryRelation[],
  ancestors: WeakSet<object>,
  path: string,
): void {
  if (ancestors.has(relation)) planError(path, "join_cycle");
  ancestors.add(relation);
  try {
    const alias = relation.alias ?? relation.name;
    if (aliases.has(alias)) planError(`${path}.alias`, `duplicate alias ${alias}`);
    aliases.set(alias, relation);
    nodes.push(relation);
    relation.joins.forEach((join, index) => {
      collectRelations(join.from, aliases, nodes, ancestors, `${path}.joins[${index.toString()}].from`);
    });
  } finally {
    ancestors.delete(relation);
  }
}

async function scanRelations(
  executor: QueryExecutor,
  relations: readonly QueryRelation[],
  keyReferences: ReadonlyMap<QueryRelation, readonly { readonly field: string; readonly path: string }[]>,
  limits: ExecutionLimits,
  resolveSource: JoinedQueryExecutionOptions["resolveSource"],
  resolveExecutor: JoinedQueryExecutionOptions["resolveExecutor"],
  onProgress: JoinedQueryExecutionOptions["onProgress"],
  composition?: CompositionExecution,
): Promise<ReadonlyMap<QueryRelation, readonly StoredRow[]>> {
  const result = new Map<QueryRelation, readonly StoredRow[]>();
  let fetched = 0;
  let retained = 0;
  for (const relation of relations) {
    const prepared = composition?.prepared?.get(relation);
    if (composition !== undefined && prepared === undefined) throw new Error("missing prepared scan");
    const source: StructuredQuery<Data> = prepared?.query ?? {
      source: relationSource(relation, resolveSource),
      filters: [],
      orders: relation.scan?.orderBy ?? [],
      limit: relation.scan?.limit ?? limits.maxFetchedRows + 1,
    };
    if (prepared === undefined && relation.database !== undefined && resolveExecutor === undefined) planError(aliasOf(relation), "database-qualified relation requires resolveExecutor");
    const page = prepared === undefined
      ? await (resolveExecutor?.(relation) ?? executor).query(source)
      : await prepared.execute(structuredClone(source));
    if (prepared === undefined) requireUnannotatedQueryInput(page);
    else {
      const metadata = await captureSourceLeaf(page, prepared.admission);
      // Refuse before record getters; cursors imply unsupported paged transport.
      if (page.nextCursor !== undefined) planError(aliasOf(relation), "composed scan is paginated");
      const input: SourceCompositionInput = { scanId: prepared.scanId, relationPath: prepared.relationPath,
        source: prepared.source, semanticRef: prepared.semanticRef, scope: prepared.scope,
        rightsStatus: metadata.sourceRights === undefined ? "unknown" : "provided", metadata };
      composition?.inputs.push(input);
      if (composition !== undefined) finishComposition(composition, false);
    }
    if (page.nextCursor !== undefined && relation.scan === undefined) planError(aliasOf(relation), "relation scan is paginated");
    const records = page.records;
    if (prepared !== undefined) {
      if (records.length > prepared.scope.requestedLimit) planError(aliasOf(relation), "admitted scan row bound exceeded");
      if (prepared.scope.kind === "complete" && prepared.scope.proof === "immutable-local-array" && records.length !== prepared.scope.maxRows) planError(aliasOf(relation), "immutable array completeness mismatch");
    }
    fetched += records.length;
    retained += records.reduce((total, record) => total + bytes(record.data), 0);
    for (const record of records) for (const reference of keyReferences.get(relation) ?? []) joinKey(record.data[reference.field], reference.path);
    if (fetched > limits.maxFetchedRows) planError(aliasOf(relation), "fetched-row bound exceeded");
    if (retained > limits.maxRetainedBytes) planError(aliasOf(relation), "retained-byte bound exceeded");
    result.set(relation, records);
    onProgress?.({ phase: "download", ...(relation.database === undefined ? {} : { database: relation.database }), rows: fetched });
  }
  return result;
}

function relationSource(
  relation: QueryRelation,
  resolveSource: JoinedQueryExecutionOptions["resolveSource"],
): StructuredQuery<Data>["source"] {
  if (resolveSource !== undefined) return resolveSource(relation);
  if (relation.schema !== undefined) planError(aliasOf(relation), "schema-qualified relation requires resolveSource");
  return { kind: "collection", name: relation.name };
}

async function evaluateRelation(
  relation: QueryRelation,
  inherited: ReadonlyMap<string, StoredRow | undefined>,
  cached: ReadonlyMap<QueryRelation, readonly StoredRow[]>,
  limits: ExecutionLimits,
  counter: { candidates: number },
  inheritedRoot?: StoredRow,
  relationPath = "from",
): Promise<JoinedRow[]> {
  const records = cached.get(relation);
  if (records === undefined) planError(aliasOf(relation), "relation was not scanned");
  let rows: JoinedRow[] = records.map((record) => ({ aliases: new Map([...inherited, [aliasOf(relation), record]]), root: inheritedRoot ?? record }));
  assertRowBound(rows, limits, relationPath);
  for (const [index, join] of relation.joins.entries()) {
    const joinPath = `${relationPath}.joins[${index.toString()}]`;
    const next: JoinedRow[] = [];
    const childAliases = aliasesFor(join.from);
    const uncorrelated = !hasExternalReference(join.from, new Set(childAliases));
    const childRows = uncorrelated ? await evaluateRelation(join.from, new Map(), cached, limits, counter, undefined, `${joinPath}.from`) : undefined;
    const hashAvailable = childRows !== undefined && crossSidePredicate(join, new Set(childAliases)) !== undefined;
    const algorithm = selectJoinAlgorithm(join.hints?.algorithms, hashAvailable);
    const candidateLookup = childRows === undefined || algorithm !== "hash" ? undefined : candidateIndex(childRows, join, new Set(childAliases), joinPath);
    for (const left of rows) {
      const candidates = childRows === undefined
        ? await evaluateRelation(join.from, left.aliases, cached, limits, counter, left.root, `${joinPath}.from`)
        : (algorithm === "hash"
          ? indexedCandidates(left, childRows, candidateLookup, join, new Set(childAliases), joinPath)
          : childRows).map((candidate) => mergeCandidate(left, candidate));
      counter.candidates += candidates.length;
      if (counter.candidates > limits.maxCandidateEvaluations) planError(joinPath, "candidate-evaluation bound exceeded");
      const matches = candidates.filter((candidate) => join.on.every((predicate) => matchesJoin(candidate, predicate, joinPath)));
      if (matches.length > 0) {
        next.push(...matches);
      } else if (join.type === "left") {
        const aliases = new Map(left.aliases);
        for (const alias of childAliases) aliases.set(alias, undefined);
        next.push({ aliases, root: left.root });
      }
      assertRowBound(next, limits, joinPath);
    }
    rows = next;
  }
  return rows;
}

function mergeCandidate(left: JoinedRow, candidate: JoinedRow): JoinedRow {
  return { aliases: new Map([...left.aliases, ...candidate.aliases]), root: left.root };
}

function candidateIndex(
  candidates: readonly JoinedRow[],
  join: QueryRelation["joins"][number],
  childAliases: ReadonlySet<string>,
  path: string,
): ReadonlyMap<string, readonly JoinedRow[]> | undefined {
  const predicate = crossSidePredicate(join, childAliases);
  if (predicate === undefined) return undefined;
  const child = childAliases.has(predicate.left.source) ? predicate.left : predicate.right;
  const index = new Map<string, JoinedRow[]>();
  for (const candidate of candidates) {
    const key = joinKey(fieldValue(candidate, child), `${path}.index`);
    if (key === undefined) continue;
    const bucket = index.get(key) ?? [];
    bucket.push(candidate);
    index.set(key, bucket);
  }
  return index;
}

function crossSidePredicate(
  join: QueryRelation["joins"][number],
  childAliases: ReadonlySet<string>,
): QueryJoinPredicate | undefined {
  return join.on.find((item) => childAliases.has(item.left.source) !== childAliases.has(item.right.source));
}

function indexedCandidates(
  left: JoinedRow,
  candidates: readonly JoinedRow[],
  index: ReadonlyMap<string, readonly JoinedRow[]> | undefined,
  join: QueryRelation["joins"][number],
  childAliases: ReadonlySet<string>,
  path: string,
): readonly JoinedRow[] {
  if (index === undefined) return candidates;
  const predicate = crossSidePredicate(join, childAliases);
  if (predicate === undefined) return candidates;
  const parent = childAliases.has(predicate.left.source) ? predicate.right : predicate.left;
  const key = joinKey(fieldValue(left, parent), `${path}.index`);
  return key === undefined ? [] : index.get(key) ?? [];
}

function hasExternalReference(relation: QueryRelation, subtreeAliases: ReadonlySet<string>): boolean {
  return relation.joins.some((join) => join.on.some((predicate) =>
    !subtreeAliases.has(predicate.left.source) || !subtreeAliases.has(predicate.right.source),
  ) || hasExternalReference(join.from, subtreeAliases));
}

function collectKeyReferences(
  root: QueryRelation,
  aliases: ReadonlyMap<string, QueryRelation>,
): ReadonlyMap<QueryRelation, readonly { readonly field: string; readonly path: string }[]> {
  const references = new Map<QueryRelation, { readonly field: string; readonly path: string }[]>();
  const visit = (relation: QueryRelation, path: string): void => {
    relation.joins.forEach((join, index) => {
      join.on.forEach((predicate, predicateIndex) => {
        for (const [side, reference] of [["left", predicate.left], ["right", predicate.right]] as const) {
          const owner = aliases.get(reference.source);
          if (owner === undefined) planError(`${path}.joins[${index.toString()}].on[${predicateIndex.toString()}].${side}`, `unknown alias ${reference.source}`);
          const values = references.get(owner) ?? [];
          values.push({ field: reference.field, path: `${path}.joins[${index.toString()}].on[${predicateIndex.toString()}].${side}` });
          references.set(owner, values);
        }
      });
      visit(join.from, `${path}.joins[${index.toString()}].from`);
    });
  };
  visit(root, "from");
  return references;
}

function matchesJoin(row: JoinedRow, predicate: QueryJoinPredicate, path: string): boolean {
  const left = joinKey(fieldValue(row, predicate.left), `${path}.left`);
  const right = joinKey(fieldValue(row, predicate.right), `${path}.right`);
  return left !== undefined && right !== undefined && left === right;
}

function joinKey(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) keyTypeError(path);
    return `number:${Object.is(value, -0) ? "0" : value.toString()}`;
  }
  keyTypeError(path);
}

/**
 * A WHERE filter as the Go executor decides it: only a true result keeps the
 * row; a comparison with a null operand is unknown (so `x == null` never holds
 * and `NotIn` over a list containing null never does either).
 */
function matchesWhere(row: JoinedRow, filter: DTQLQueryFilter | DTQLCondition): boolean {
  return evaluateCondition(toCondition(filter), (leaf, path) => whereTruth(row, leaf, path), "where") === "true";
}

function whereTruth(row: JoinedRow, leaf: DTQLLeaf, path: string): Truth {
  if ("operand" in leaf) return nullTestTruth(leaf, whereOperand(row, leaf.operand, `${path}.operand`));
  const comparison = leaf;
  const left = whereOperand(row, comparison.left, `${path}.left`);
  if (isMembership(comparison.operator)) {
    const right = whereOperand(row, comparison.right, `${path}.right`);
    if (!Array.isArray(right)) planError(`${path}.right`, "IN requires an array");
    const items: readonly unknown[] = right;
    let truth: Truth = "false";
    if (items.length > 0) {
      if (items.some((item) => item !== null && left !== null && left !== undefined && equal(left, item))) truth = "true";
      else if (left === null || left === undefined || items.includes(null)) truth = "unknown";
    }
    if (comparison.operator === "not-in") return truth === "true" ? "false" : truth === "false" ? "true" : truth;
    return truth;
  }
  const right = whereOperand(row, comparison.right, `${path}.right`);
  // `!=` is a DTQL extension of this package (Go has none): it treats null as a value, so `x != null` means "x is not null".
  if (comparison.operator === "!=") return equal(left ?? null, right ?? null) ? "false" : "true";
  if (left === null || left === undefined || right === null || right === undefined) return "unknown";
  switch (comparison.operator) {
    case "==": return equal(left, right) ? "true" : "false";
    case "<": return compare(left, right) < 0 ? "true" : "false";
    case "<=": return compare(left, right) <= 0 ? "true" : "false";
    case ">": return compare(left, right) > 0 ? "true" : "false";
    case ">=": return compare(left, right) >= 0 ? "true" : "false";
    default: return planError(path, `unsupported operator ${comparison.operator}`);
  }
}

/** A WHERE operand: a field, a literal, a list or arithmetic over them (no aggregate, star or parameter). */
function whereOperand(row: JoinedRow, expression: DTQLExpression, path: string): unknown {
  switch (expression.kind) {
    case "field": return fieldValue(row, expression.field);
    case "literal": return expression.value;
    case "values": return expression.values;
    case "binary": return binary(expression.operator, whereOperand(row, expression.left, `${path}.binary.left`), whereOperand(row, expression.right, `${path}.binary.right`));
    default: return planError(path, `unsupported expression ${expression.kind}`);
  }
}

function materialize(rows: readonly JoinedRow[], query: JoinedDTQLQuery, limits: ExecutionLimits): MaterializedRow[] {
  if (!hasAggregation(query)) return rows.map((row) => ({ row, group: [row] }));
  const groups = new Map<string, JoinedRow[]>();
  if (rows.length === 0 && query.groupBy === undefined) groups.set("all", []);
  for (const row of rows) {
    const key = query.groupBy === undefined ? "all" : groupKey(row, query.groupBy);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const values = [...groups.values()].map((group) => ({ row: group[0] ?? emptyAggregateRow(), group: Object.freeze(group) }));
  assertRowBound(values.map((value) => value.row), limits, "groupBy");
  // Go accumulates every aggregate of the query over every group (so an overflow in one is an error even if
  // the group is filtered out or paged away); evaluating them up front does the same.
  const aggregates = queryAggregates(query);
  for (const value of values) for (const expression of aggregates) aggregate(value.group, expression, "aggregate");
  const having = query.having;
  return having === undefined ? values : values.filter((value) => matchesHaving(value, having));
}

function queryAggregates(query: JoinedDTQLQuery): Extract<DTQLExpression, { readonly kind: "aggregate" }>[] {
  const found: Extract<DTQLExpression, { readonly kind: "aggregate" }>[] = [];
  const visit = (expression: DTQLExpression): void => {
    if (expression.kind === "aggregate") found.push(expression);
    else if (expression.kind === "binary") { visit(expression.left); visit(expression.right); }
  };
  query.columns?.forEach((column) => { if (column.expression !== undefined) visit(column.expression); });
  query.orders.forEach((order) => { if (order.expression !== undefined) visit(order.expression); });
  if (query.having !== undefined) walkConditionExpressions(query.having, "having", visit);
  return found;
}

function validateExecutionScopes(relation: QueryRelation, inherited: ReadonlySet<string>, path: string): Set<string> {
  const visible = new Set(inherited);
  visible.add(aliasOf(relation));
  for (const [index, join] of relation.joins.entries()) {
    const subtree = new Set(aliasesFor(join.from));
    for (const [predicateIndex, predicate] of join.on.entries()) {
      for (const [side, reference] of [["left", predicate.left], ["right", predicate.right]] as const) {
        if (!visible.has(reference.source) && !subtree.has(reference.source)) {
          throw new TypeError(`join_scope at ${path}.joins[${index.toString()}].on[${predicateIndex.toString()}].${side}.source: unavailable alias ${reference.source}`);
        }
      }
    }
    for (const alias of validateExecutionScopes(join.from, visible, `${path}.joins[${index.toString()}].from`)) visible.add(alias);
  }
  return visible;
}

function emptyAggregateRow(): JoinedRow {
  return { aliases: new Map(), root: { key: new Key("__dtql__", "aggregate"), exists: true, data: {} } };
}

function matchesHaving(value: MaterializedRow, having: DTQLCondition): boolean {
  return evaluateCondition(having, (leaf, path) => {
    if ("operand" in leaf) return nullTestTruth(leaf, expressionValue(value.row, value.group, leaf.operand, `${path}.operand`));
    return havingHolds(leaf.operator, expressionValue(value.row, value.group, leaf.left, `${path}.left`), expressionValue(value.row, value.group, leaf.right, `${path}.right`)) ? "true" : "false";
  }, "having") === "true";
}

/**
 * HAVING comparison as the Go engine evaluates it: `==` is true for two nulls,
 * every ordering comparison is false when either side is null, and membership
 * operators are not supported there (Go reports it when a group is evaluated).
 */
function havingHolds(operator: DTQLComparison["operator"], leftValue: unknown, rightValue: unknown): boolean {
  const left = leftValue ?? null;
  const right = rightValue ?? null;
  switch (operator) {
    case "==": return equal(left, right);
    case "!=": return !equal(left, right);
    default: break;
  }
  if (operator === "in" || operator === "not-in") planError("having", `unsupported operator ${operator === "in" ? "In" : "NotIn"}`);
  if (left === null || right === null) return false;
  switch (operator) {
    case "<": return compare(left, right) < 0;
    case "<=": return compare(left, right) <= 0;
    case ">": return compare(left, right) > 0;
    case ">=": return compare(left, right) >= 0;
    default: return planError("having", `unsupported operator ${operator}`);
  }
}

function stableOrder(rows: readonly MaterializedRow[], query: JoinedDTQLQuery): MaterializedRow[] {
  const grouped = hasAggregation(query);
  // Keys are resolved once per row, before sorting, so an evaluation error
  // surfaces deterministically instead of depending on comparison order.
  return rows.map((row, index) => ({ row, index, keys: query.orders.map((order, position) => {
    const location = `orderBy[${position.toString()}]`;
    const key = order.expression === undefined ? fieldValue(row.row, order.field) : expressionValue(row.row, row.group, order.expression, location);
    // Go keeps a group's order keys with its output, where a non-finite number is refused.
    if (grouped) rejectNonFinite(key, location);
    return key;
  }) })).sort((a, b) => {
    for (const [position, order] of query.orders.entries()) {
      const result = compare(a.keys[position], b.keys[position]);
      if (result !== 0) return order.direction === "desc" ? -result : result;
    }
    return a.index - b.index;
  }).map(({ row }) => row);
}

function project(value: MaterializedRow, query: JoinedDTQLQuery, aliases: readonly string[]): Data {
  if (query.columns === undefined) {
    const result: Data = {};
    for (const alias of aliases) {
      const record = value.row.aliases.get(alias);
      if (record !== undefined) Object.assign(result, record.data);
    }
    return result;
  }
  const result: Data = {};
  for (const [position, column] of query.columns.entries()) {
    const expression = column.expression;
    const location = `columns[${position.toString()}]`;
    if (expression === undefined) planError(location, "column expression is required");
    const output = expressionValue(value.row, value.group, expression, location) ?? null;
    rejectNonFinite(output, location);
    result[columnOutput(column, location)] = output;
  }
  return result;
}

/** A number that overflowed to infinity (or NaN) cannot be part of a result, as in Go. */
function rejectNonFinite(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) planError(path, "arithmetic overflow: the result is not a finite number");
}

function columnOutput(column: QueryColumn, path: string): string {
  if (column.as !== undefined) return column.as;
  if (column.expression?.kind === "field") return column.expression.field.field;
  // As in Go, an aggregate with no alias is named by its text, for example COUNT(*).
  if (column.expression?.kind === "aggregate") return expressionText(column.expression);
  planError(path, "non-field joined column requires an alias");
}

function expressionValue(row: JoinedRow, group: readonly JoinedRow[], expression: DTQLExpression, path = "expression"): unknown {
  switch (expression.kind) {
    case "field": return fieldValue(row, expression.field);
    case "literal": return expression.value;
    case "values": return expression.values;
    case "param": return planError(path, "parameters are not bound by generic execution");
    case "star": return planError(path, "star is only valid as an aggregate argument");
    case "binary": return binary(expression.operator, expressionValue(row, group, expression.left, `${path}.binary.left`), expressionValue(row, group, expression.right, `${path}.binary.right`));
    case "aggregate": return aggregate(group, expression, path);
  }
}

/** Aggregate results per group, so an aggregate used in several places is computed (and can fail) once. */
const aggregateResults = new WeakMap<readonly JoinedRow[], Map<string, unknown>>();

function aggregate(rows: readonly JoinedRow[], expression: Extract<DTQLExpression, { readonly kind: "aggregate" }>, path: string): unknown {
  let results = aggregateResults.get(rows);
  if (results === undefined) {
    results = new Map();
    aggregateResults.set(rows, results);
  }
  const identity = JSON.stringify(expression);
  if (results.has(identity)) return results.get(identity);
  const value = computeAggregate(rows, expression, path);
  results.set(identity, value);
  return value;
}

function computeAggregate(rows: readonly JoinedRow[], expression: Extract<DTQLExpression, { readonly kind: "aggregate" }>, path: string): unknown {
  const argument = expression.args[0];
  if (argument === undefined) planError(path, "aggregate requires an argument");
  const argumentPath = `${path}.aggregate.args[0]`;
  const name = expression.function.toUpperCase();
  if (expression.function === "first" || expression.function === "last") {
    // As in the Go engine, FIRST and LAST keep a null value instead of skipping it.
    const row = expression.function === "first" ? rows[0] : rows.at(-1);
    const kept = row === undefined ? null : expressionValue(row, [row], argument, argumentPath) ?? null;
    rejectNonFinite(kept, path);
    return kept;
  }
  const values = argument.kind === "star" ? rows.map(() => 1) : rows.map((row) => expressionValue(row, [row], argument, argumentPath)).filter((value) => value !== undefined && value !== null);
  const distinct = expression.distinct === true ? unique(values, path) : values;
  switch (expression.function) {
    case "count": return distinct.length;
    case "min":
    case "max": {
      for (const value of distinct) rejectNonFinite(value, path);
      const pick = expression.function === "min" ? (left: unknown, right: unknown) => compare(left, right) <= 0 ? left : right : (left: unknown, right: unknown) => compare(left, right) >= 0 ? left : right;
      return distinct.length === 0 ? null : distinct.reduce(pick);
    }
    case "sum":
    case "avg": {
      // Non-numeric values are outside SUM and AVG's domain and are ignored; no numbers at all is null.
      // Like Go, fail as soon as the running total leaves the finite range, even if it would come back.
      let total = 0;
      let count = 0;
      for (const value of distinct) {
        if (!isNumeric(value)) continue;
        if (!Number.isFinite(value)) planError(path, `${name} produced a non-finite value`);
        total += value;
        if (!Number.isFinite(total)) planError(path, `${name} numeric overflow`);
        count += 1;
      }
      if (count === 0) return null;
      return expression.function === "sum" ? total : total / count;
    }
    default: return null;
  }
}

function isNumeric(value: unknown): value is number {
  return typeof value === "number";
}

function fieldValue(row: JoinedRow, field: QueryFieldReference): unknown {
  return row.aliases.get(field.source)?.data[field.field];
}

function aliasesFor(relation: QueryRelation): string[] {
  return [aliasOf(relation), ...relation.joins.flatMap((join) => aliasesFor(join.from))];
}

function aliasOf(relation: QueryRelation): string {
  return relation.alias ?? relation.name;
}

function equal(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return Number.isFinite(left) && Number.isFinite(right) && left === right;
  return left === right;
}

/**
 * The Go engine's ordering: null first, then values of one type by value, and
 * values of different types by type name: booleans, then numbers, then strings.
 */
function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  // A missing field and a null are the same value.
  if (left === undefined || left === null) return right === undefined || right === null ? 0 : -1;
  if (right === undefined || right === null) return 1;
  if ((typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string") || (typeof left === "boolean" && typeof right === "boolean")) return left < right ? -1 : 1;
  return typeRank(left) - typeRank(right);
}

function typeRank(value: unknown): number {
  if (Array.isArray(value)) return 0;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "string") return 3;
  return 4;
}

/**
 * Arithmetic is null for a null or non-numeric operand and for division by
 * zero, as in the Go engine. An overflow stays infinite here; it is refused
 * only where the number would become part of a result.
 */
function binary(operator: "+" | "-" | "*" | "/", left: unknown, right: unknown): number | null {
  if (!isNumeric(left) || !isNumeric(right)) return null;
  if (operator === "/" && right === 0) return null;
  return operator === "+" ? left + right : operator === "-" ? left - right : operator === "*" ? left * right : left / right;
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) planError(context, "aggregate requires finite numbers");
  return value;
}

interface Decimal { coefficient: bigint; scale: number }
const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function validateMoney(config: NonNullable<JoinedQueryExecutionOptions["money"]>): void {
  const rounding: unknown = config.rounding;
  if (!Number.isInteger(config.minorUnitScale) || config.minorUnitScale < 0 || config.minorUnitScale > 18 || !Number.isInteger(config.divisionScale) || config.divisionScale < 0 || config.divisionScale > 18 || rounding !== "halfEven") {
    planError("money", "minorUnitScale and divisionScale must be 0..18; rounding must be halfEven");
  }
}

function decimalInput(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && decimalPattern.test(value)) return value;
  planError("money", "decimal input must be a base-10 string or safe integer");
}

function parseDecimal(value: string): Decimal {
  if (!decimalPattern.test(value)) planError("money", "invalid decimal input");
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  return { coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`), scale: fraction.length };
}

function formatDecimal(value: Decimal): string {
  const negative = value.coefficient < 0n;
  let digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale > 0) digits = digits.padStart(value.scale + 1, "0");
  const split = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, "");
  return `${negative && value.coefficient !== 0n ? "-" : ""}${split}`;
}

function moneyMinor(value: unknown, scale: number): bigint {
  const parsed = parseDecimal(decimalInput(value));
  if (parsed.scale > scale) planError("money", "amount exceeds minorUnitScale");
  return parsed.coefficient * 10n ** BigInt(scale - parsed.scale);
}

function moneyMinorText(value: bigint, scale: number): string {
  return formatDecimal({ coefficient: value, scale });
}

function decimalDivide(left: string, right: string, scale: number): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (b.coefficient === 0n) planError("money", "division by zero");
  const numerator = a.coefficient * 10n ** BigInt(b.scale + scale);
  const denominator = b.coefficient * 10n ** BigInt(a.scale);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = (remainder < 0n ? -remainder : remainder) * 2n;
  const divisor = denominator < 0n ? -denominator : denominator;
  if (doubled > divisor || (doubled === divisor && quotient % 2n !== 0n)) quotient += (numerator < 0n) === (denominator < 0n) ? 1n : -1n;
  return formatDecimal({ coefficient: quotient, scale });
}

function decimalBinary(operator: "+" | "-" | "*" | "/", left: unknown, right: unknown, scale: number): string | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  if (operator !== "/") planError("money", "money arithmetic supports per-capita division only");
  const a = decimalInput(left);
  const b = decimalInput(right);
  return decimalDivide(a, b, scale);
}

function unique(values: readonly unknown[], path: string): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    rejectNonFinite(value, path);
    const key = expressionKey([value]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expressionKey(values: readonly unknown[]): string {
  return JSON.stringify(values, (_key, value: unknown) => {
    if (typeof value === "number") return `number:${value.toString()}`;
    if (typeof value === "string") return `string:${value}`;
    if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
    // A field that is missing and one that is null belong to the same group, as in Go.
    if (value === undefined) return null;
    return value;
  });
}

/** The group a row belongs to: its group-by values, with null and missing the same value. */
function groupKey(row: JoinedRow, groupBy: readonly DTQLExpression[]): string {
  return expressionKey(groupBy.map((expression) => {
    const value = expressionValue(row, [row], expression);
    rejectNonFinite(value, "groupBy");
    return value;
  }));
}

function assertRowBound(rows: readonly JoinedRow[], limits: ExecutionLimits, path: string): void {
  if (rows.length > limits.maxResultRows) planError(path, "result-row bound exceeded");
  const retained = rows.reduce((total, row) => total + bytes([...row.aliases.entries()].map(([alias, record]) => [alias, record?.data])), 0);
  if (retained > limits.maxRetainedBytes) planError(path, "retained-byte bound exceeded");
}

function bytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    planError("rows", "rows must be JSON-like values");
  }
}

function keyTypeError(path: string): never {
  throw new TypeError(`join_key_type at ${path}: expected string, boolean, or finite number`);
}

function scopeError(path: string, reason: string): never {
  throw new TypeError(`join_scope at ${path}: ${reason}`);
}

function typeError(path: string, reason: string): never {
  throw new TypeError(`join_type at ${path}: ${reason}`);
}

function operatorError(path: string, reason: string): never {
  throw new TypeError(`join_operator at ${path}: ${reason}`);
}

function algorithmError(path: string, reason: string): never {
  throw new TypeError(`join_algorithm at ${path}: ${reason}`);
}

function shapeError(path: string, reason: string): never {
  throw new TypeError(`join_shape at ${path}: ${reason}`);
}

function cycleError(path: string): never {
  throw new TypeError(`join_cycle at ${path}: recursive relation tree`);
}

function planError(path: string, reason: string): never {
  throw new TypeError(`join_plan at ${path}: ${reason}`);
}

/**
 * The streaming plan keeps one running state per aggregate, so it takes an
 * aggregate query (the same `hasAggregation` the generic plan uses, including
 * an aggregate that only appears in an order key or HAVING) over one flat hash
 * join. `DISTINCT` aggregates need every distinct value and use the generic plan.
 */
function canStreamJoinedAggregate(query: JoinedDTQLQuery): boolean {
  return query.from.joins.length === 1 && query.from.joins[0]?.from.joins.length === 0 &&
    selectJoinAlgorithm(query.from.joins[0].hints?.algorithms, true) === "hash" &&
    hasAggregation(query) && !hasDistinctAggregate(query);
}

/** Streams a flat equality join in bounded result pages. The indexed side
 * remains bounded; the fact side and output can exceed generic join limits. */
export async function* executeJoinedDTQLQueryPages(
  query: JoinedDTQLQuery,
  options: JoinedQueryExecutionOptions,
): AsyncIterable<QueryPage<Data>> {
  if (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000)) planError("pageSize", "pageSize must be 1..1000");
  const scanPages = options.scanPages;
  if (scanPages === undefined) planError("from", "paged source transport is required");
  validateRelationShape(query.from, new WeakSet(), "from");
  const root = query.from;
  const join = root.joins[0];
  if (join === undefined || root.joins.length !== 1 || join.from.joins.length !== 0 ||
      query.groupBy !== undefined || query.having !== undefined || query.orders.length !== 0 ||
      (query.columns ?? []).some((column) => column.expression !== undefined && containsAggregate(column.expression)) ||
      selectJoinAlgorithm(join.hints?.algorithms, true) !== "hash") {
    planError("from", "paged output requires one flat hash equality join without global aggregation or ordering");
  }
  const child = join.from;
  const rootAlias = aliasOf(root);
  const childAlias = aliasOf(child);
  const aliases = new Map<string, QueryRelation>();
  collectRelations(root, aliases, [], new WeakSet(), "from");
  validateExecutionScopes(root, new Set(), "from");
  collectKeyReferences(root, aliases);
  const predicate = crossSidePredicate(join, new Set([childAlias]));
  if (predicate === undefined) planError("from.joins[0].on", "paged output requires a cross-source equality");
  const childRef = predicate.left.source === childAlias ? predicate.left : predicate.right;
  const rootRef = predicate.left.source === rootAlias ? predicate.left : predicate.right;
  if (rootRef.source !== rootAlias || childRef.source !== childAlias) planError("from.joins[0].on", "paged output requires root and child aliases");
  const columns = query.columns === undefined ? undefined : expandColumns(query.columns, aliases, options.schema);
  const effective = { ...query, ...(columns === undefined ? {} : { columns }) };
  validateClauseSources(effective, aliases);
  const dimension = new Map<string, StoredRow[]>();
  const childQuery: StructuredQuery<Data> = { source: relationSource(child, options.resolveSource), filters: [], orders: child.scan?.orderBy ?? [], ...(child.scan?.limit === undefined ? {} : { limit: child.scan.limit }) };
  let downloaded = 0;
  let retained = 0;
  for await (const page of scanPages(child, childQuery)) {
    requireUnannotatedQueryInput(page);
    for (const record of page.records) {
      downloaded++;
      retained += bytes(record.data);
      if (downloaded > (options.maxFetchedRows ?? defaults.maxFetchedRows) || retained > (options.maxRetainedBytes ?? defaults.maxRetainedBytes)) planError(childAlias, "dimension bound exceeded");
      const index = joinKey(record.data[childRef.field], "from.joins[0].on");
      if (index !== undefined) dimension.set(index, [...(dimension.get(index) ?? []), record]);
    }
    options.onProgress?.({ phase: "download", ...(child.database === undefined ? {} : { database: child.database }), rows: downloaded });
  }
  const rootQuery: StructuredQuery<Data> = { source: relationSource(root, options.resolveSource), filters: [], orders: root.scan?.orderBy ?? [], ...(root.scan?.limit === undefined ? {} : { limit: root.scan.limit }) };
  let scanned = 0;
  let processed = 0;
  let skipped = 0;
  let emitted = 0;
  let output: StoredRow[] = [];
  for await (const page of scanPages(root, rootQuery)) {
    requireUnannotatedQueryInput(page);
    scanned += page.records.length;
    if (root.scan !== undefined && scanned > root.scan.limit) planError(rootAlias, "source exceeded its scan limit");
    downloaded += page.records.length;
    options.onProgress?.({ phase: "download", ...(root.database === undefined ? {} : { database: root.database }), rows: downloaded });
    for (const fact of page.records) {
      const index = joinKey(fact.data[rootRef.field], "from.joins[0].on");
      const matches = index === undefined ? [] : dimension.get(index) ?? [];
      const candidates = matches.length === 0 && join.type === "left" ? [undefined] : matches;
      for (const candidate of candidates) {
        const row: JoinedRow = { root: fact, aliases: new Map([[rootAlias, fact], [childAlias, candidate]]) };
        if (candidate !== undefined && !join.on.every((condition) => matchesJoin(row, condition, "from.joins[0].on"))) continue;
        if (!effective.filters.every((filter) => matchesWhere(row, filter))) continue;
        processed++;
        if (skipped < (effective.offset ?? 0)) { skipped++; continue; }
        if (effective.limit !== undefined && emitted >= effective.limit) break;
        output.push({ key: fact.key, exists: true, data: project({ row, group: [row] }, effective, [rootAlias, childAlias]) });
        emitted++;
        if (output.length === (options.pageSize ?? 500)) { yield { records: output }; output = []; }
      }
      if (effective.limit !== undefined && emitted >= effective.limit) break;
    }
    options.onProgress?.({ phase: "process", rows: processed });
    if (effective.limit !== undefined && emitted >= effective.limit) break;
  }
  if (output.length !== 0) yield { records: output };
}

interface StreamAggregateState {
  count: number;
  value: unknown;
}

interface StreamGroup {
  first: JoinedRow;
  aggregates: Map<string, StreamAggregateState>;
}

/** Streams a large fact relation through one indexed dimension and keeps only groups. */
async function executeStreamingJoinedAggregateQuery(query: JoinedDTQLQuery, options: JoinedQueryExecutionOptions): Promise<QueryPage<Data>> {
  const scanPages = options.scanPages;
  if (scanPages === undefined) planError("from", "paged source transport is required");
  validateRelationShape(query.from, new WeakSet(), "from");
  validateLimits({
    maxFetchedRows: options.maxFetchedRows ?? defaults.maxFetchedRows,
    maxResultRows: options.maxResultRows ?? defaults.maxResultRows,
    maxCandidateEvaluations: options.maxCandidateEvaluations ?? defaults.maxCandidateEvaluations,
    maxRetainedBytes: options.maxRetainedBytes ?? defaults.maxRetainedBytes,
  });
  const aliases = new Map<string, QueryRelation>();
  collectRelations(query.from, aliases, [], new WeakSet(), "from");
  validateExecutionScopes(query.from, new Set(), "from");
  collectKeyReferences(query.from, aliases);
  const join = query.from.joins[0];
  if (join?.from.joins.length !== 0) planError("from", "streaming aggregation requires one flat join");
  const root = query.from;
  const child = join.from;
  const rootAlias = aliasOf(root);
  const childAlias = aliasOf(child);
  const predicate = crossSidePredicate(join, new Set([childAlias]));
  if (predicate === undefined) planError("from.joins[0].on", "streaming aggregation requires a cross-source equality");
  const childRef = predicate.left.source === childAlias ? predicate.left : predicate.right;
  const rootRef = predicate.left.source === rootAlias ? predicate.left : predicate.right;
  if (rootRef.source !== rootAlias || childRef.source !== childAlias) planError("from.joins[0].on", "streaming aggregation requires root and child aliases");
  const expanded = expandQueryColumns(query, aliases, options.schema);
  validateClauseSources(expanded, aliases);
  const effective = withDerivedColumns(expanded);
  const aggregateExpressions = new Map<string, Extract<DTQLExpression, { readonly kind: "aggregate" }>>();
  const collect = (value: DTQLExpression): void => {
    if (value.kind === "aggregate") {
      if (value.distinct) planError("columns", "streaming DISTINCT aggregate is not supported");
      aggregateExpressions.set(JSON.stringify(value), value);
    } else if (value.kind === "binary") { collect(value.left); collect(value.right); }
  };
  effective.columns?.forEach((column) => { if (column.expression !== undefined) collect(column.expression); });
  if (effective.having !== undefined) walkConditionExpressions(effective.having, "having", collect);
  for (const order of effective.orders) {
    if (order.expression === undefined) continue;
    if (options.money !== undefined) planError("orderBy", "expression order keys are not supported in exact money mode");
    collect(order.expression);
  }
  const dimension = new Map<string, StoredRow[]>();
  const childQuery: StructuredQuery<Data> = { source: relationSource(child, options.resolveSource), filters: [], orders: child.scan?.orderBy ?? [], ...(child.scan?.limit === undefined ? {} : { limit: child.scan.limit }) };
  let downloaded = 0;
  let dimensionBytes = 0;
  for await (const page of scanPages(child, childQuery)) {
    requireUnannotatedQueryInput(page);
    for (const record of page.records) {
      downloaded += 1;
      dimensionBytes += bytes(record.data);
      if (downloaded > (options.maxFetchedRows ?? defaults.maxFetchedRows) || dimensionBytes > (options.maxRetainedBytes ?? defaults.maxRetainedBytes)) planError(childAlias, "dimension bound exceeded");
      const key = joinKey(record.data[childRef.field], "from.joins[0].on");
      if (key !== undefined) dimension.set(key, [...(dimension.get(key) ?? []), record]);
    }
    options.onProgress?.({ phase: "download", ...(child.database === undefined ? {} : { database: child.database }), rows: downloaded });
  }
  const groups = new Map<string, StreamGroup>();
  let groupBytes = 0;
  const rootQuery: StructuredQuery<Data> = { source: relationSource(root, options.resolveSource), filters: [], orders: root.scan?.orderBy ?? [], ...(root.scan?.limit === undefined ? {} : { limit: root.scan.limit }) };
  let processed = 0;
  let factRows = 0;
  for await (const page of scanPages(root, rootQuery)) {
    requireUnannotatedQueryInput(page);
    factRows += page.records.length;
    if (root.scan !== undefined && factRows > root.scan.limit) planError(rootAlias, "source exceeded its scan limit");
    downloaded += page.records.length;
    options.onProgress?.({ phase: "download", ...(root.database === undefined ? {} : { database: root.database }), rows: downloaded });
    for (const fact of page.records) {
      const key = joinKey(fact.data[rootRef.field], "from.joins[0].on");
      const matches = key === undefined ? [] : dimension.get(key) ?? [];
      const candidates = matches.length === 0 && join.type === "left" ? [undefined] : matches;
      for (const candidate of candidates) {
        const row: JoinedRow = { root: fact, aliases: new Map([[rootAlias, fact], [childAlias, candidate]]) };
        if (candidate !== undefined && !join.on.every((condition) => matchesJoin(row, condition, "from.joins[0].on"))) continue;
        if (!effective.filters.every((filter) => matchesWhere(row, filter))) continue;
        const rowGroup = effective.groupBy === undefined ? "all" : groupKey(row, effective.groupBy);
        let group = groups.get(rowGroup);
        if (group === undefined) {
          if (groups.size >= (options.maxResultRows ?? defaults.maxResultRows)) planError("groupBy", "group bound exceeded");
          groupBytes += 128 + bytes([rowGroup, [...row.aliases.values()].map((record) => record?.data)]);
          if (groupBytes + dimensionBytes > (options.maxRetainedBytes ?? defaults.maxRetainedBytes)) planError("groupBy", "retained-byte bound exceeded");
          group = { first: row, aggregates: new Map() };
          groups.set(rowGroup, group);
        }
        for (const [signature, aggregateExpression] of aggregateExpressions) updateStreamAggregate(group, signature, aggregateExpression, row, options.money);
        processed += 1;
      }
    }
    options.onProgress?.({ phase: "process", rows: processed });
  }
  // Without GROUP BY every row, including none at all, falls into one group.
  if (effective.groupBy === undefined && groups.size === 0) groups.set("all", { first: emptyAggregateRow(), aggregates: new Map() });
  const kept = [...groups.values()].filter((group) => effective.having === undefined || streamHaving(group, effective.having, options.money));
  const projected = kept.map((group) => ({
    key: group.first.root.key,
    exists: true as const,
    data: streamProject(group, effective, [rootAlias, childAlias], options.money),
    // Every key, field keys included, is evaluated over the group. A field key
    // must not read the projected row: `columns` may rename it or leave it out.
    sortKeys: effective.orders.map((order, position) => {
      const key = streamExpression(group, order.expression ?? { kind: "field", field: order.field }, `orderBy[${position.toString()}]`, options.money);
      rejectNonFinite(key, `orderBy[${position.toString()}]`);
      return key;
    }),
  }));
  const start = effective.offset ?? 0;
  const ordered = (effective.orders.length === 0 ? projected : projected.sort((left, right) => {
    for (const [position, order] of effective.orders.entries()) {
      const cmp = compare(left.sortKeys[position], right.sortKeys[position]);
      if (cmp !== 0) return order.direction === "desc" ? -cmp : cmp;
    }
    return 0;
  })).map(({ key, exists, data }) => ({ key, exists, data }));
  return { records: ordered.slice(start, effective.limit === undefined ? undefined : start + effective.limit) };
}

function updateStreamAggregate(group: StreamGroup, signature: string, expression: Extract<DTQLExpression, { readonly kind: "aggregate" }>, row: JoinedRow, exact?: NonNullable<JoinedQueryExecutionOptions["money"]>): void {
  const argument = expression.args[0];
  if (argument === undefined) planError("aggregate", "aggregate requires an argument");
  const value = argument.kind === "star" ? 1 : expressionValue(row, [row], argument);
  const state = group.aggregates.get(signature) ?? { count: 0, value: null };
  const name = expression.function.toUpperCase();
  if (expression.function === "first" || expression.function === "last") {
    // As in the Go engine, FIRST and LAST keep a null value instead of skipping it.
    if (expression.function === "last" || state.count === 0) {
      state.value = value ?? null;
      rejectNonFinite(state.value, "aggregate");
    }
    state.count += 1;
    group.aggregates.set(signature, state);
    return;
  }
  if (value === null || value === undefined) return;
  // SUM and AVG ignore non-numeric values; the exact decimal path validates its own input.
  if ((expression.function === "sum" || expression.function === "avg") && exact === undefined && !isNumeric(value)) return;
  state.count += 1;
  switch (expression.function) {
    case "count": state.value = state.count; break;
    case "sum": case "avg":
      if (exact === undefined) {
        // Like Go, fail as soon as the running total leaves the finite range, even if it would come back.
        const input = value as number;
        if (!Number.isFinite(input)) planError("aggregate", `${name} produced a non-finite value`);
        const total = (state.value === null ? 0 : state.value as number) + input;
        if (!Number.isFinite(total)) planError("aggregate", `${name} numeric overflow`);
        state.value = total;
      } else {
        state.value = (state.value === null ? 0n : state.value as bigint) + moneyMinor(value, exact.minorUnitScale);
      }
      break;
    case "min": rejectNonFinite(value, "aggregate"); if (state.value === null || compare(value, state.value) < 0) state.value = value; break;
    case "max": rejectNonFinite(value, "aggregate"); if (state.value === null || compare(value, state.value) > 0) state.value = value; break;
  }
  group.aggregates.set(signature, state);
}

function streamExpression(group: StreamGroup, expression: DTQLExpression, path: string, exact?: NonNullable<JoinedQueryExecutionOptions["money"]>): unknown {
  if (expression.kind === "aggregate") {
    const state = group.aggregates.get(JSON.stringify(expression));
    if (expression.function === "count") return state?.count ?? 0;
    if (expression.function === "sum") return state === undefined ? null : exact === undefined ? state.value : moneyMinorText(state.value as bigint, exact.minorUnitScale);
    if (expression.function === "avg") return state === undefined || state.count === 0 ? null : exact === undefined ? finiteNumber(state.value, "avg") / state.count : decimalDivide(moneyMinorText(state.value as bigint, exact.minorUnitScale), String(state.count), exact.divisionScale);
    return state?.value ?? null;
  }
  if (expression.kind === "binary") {
    const left = streamExpression(group, expression.left, `${path}.binary.left`, exact);
    const right = streamExpression(group, expression.right, `${path}.binary.right`, exact);
    return exact === undefined ? binary(expression.operator, left, right) : decimalBinary(expression.operator, left, right, exact.divisionScale);
  }
  return expressionValue(group.first, [group.first], expression, path);
}

function streamHaving(group: StreamGroup, having: DTQLCondition, exact?: NonNullable<JoinedQueryExecutionOptions["money"]>): boolean {
  return evaluateCondition(having, (leaf, path) => {
    if ("operand" in leaf) return nullTestTruth(leaf, streamExpression(group, leaf.operand, `${path}.operand`, exact));
    return havingHolds(leaf.operator, streamExpression(group, leaf.left, `${path}.left`, exact), streamExpression(group, leaf.right, `${path}.right`, exact)) ? "true" : "false";
  }, "having") === "true";
}

function streamProject(group: StreamGroup, query: JoinedDTQLQuery, aliases: readonly string[], exact?: NonNullable<JoinedQueryExecutionOptions["money"]>): Data {
  if (query.columns === undefined) return project({ row: group.first, group: [group.first] }, query, aliases);
  const data: Data = {};
  for (const [position, column] of query.columns.entries()) {
    const location = `columns[${position.toString()}]`;
    if (column.expression === undefined) planError(location, "column expression is required");
    const output = streamExpression(group, column.expression, location, exact) ?? null;
    rejectNonFinite(output, location);
    data[columnOutput(column, location)] = output;
  }
  return data;
}
