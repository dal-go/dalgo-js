import type { QueryExecutor } from "./database.js";
import type { DTQLSchema } from "./dtql.js";
import { Key } from "./key.js";
import type { ExistingRecord } from "./record.js";
import type {
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

type ExecutionLimits = Required<Omit<JoinedQueryExecutionOptions, "schema" | "resolveSource">>;

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
  const limits: ExecutionLimits = {
    maxFetchedRows: options.maxFetchedRows ?? defaults.maxFetchedRows,
    maxResultRows: options.maxResultRows ?? defaults.maxResultRows,
    maxCandidateEvaluations: options.maxCandidateEvaluations ?? defaults.maxCandidateEvaluations,
    maxRetainedBytes: options.maxRetainedBytes ?? defaults.maxRetainedBytes,
  };
  validateLimits(limits);
  validateRelationShape(query.from, new WeakSet(), "from");
  const aliases = new Map<string, QueryRelation>();
  const nodes: QueryRelation[] = [];
  collectRelations(query.from, aliases, nodes, new WeakSet(), "from");
  validateExecutionScopes(query.from, new Set(), "from");
  const effectiveQuery = { ...query, ...(query.columns === undefined ? {} : { columns: expandColumns(query.columns, aliases, options.schema) }) };
  validateClauseSources(effectiveQuery, aliases);
  const keyReferences = collectKeyReferences(query.from, aliases);
  const cached = await scanRelations(executor, nodes, keyReferences, limits, options.resolveSource);
  const relationAliases = aliasesFor(query.from);
  let rows = await evaluateRelation(query.from, new Map(), cached, limits, { candidates: 0 });
  rows = rows.filter((row) => effectiveQuery.filters.every((filter) => matchesFilter(row, filter)));

  const materialized = materialize(rows, effectiveQuery, limits);
  const ordered = stableOrder(materialized, effectiveQuery);
  const start = effectiveQuery.offset ?? 0;
  const end = effectiveQuery.limit === undefined ? undefined : start + effectiveQuery.limit;
  const page = ordered.slice(start, end).map((item) => ({ key: item.row.root.key, exists: true as const, data: project(item, effectiveQuery, relationAliases) }));
  return { records: page };
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
  const seen = new Set<QueryJoinAlgorithm>();
  algorithms.forEach((algorithm, index) => {
    const entryPath = `${path}.algorithms[${index.toString()}]`;
    if (typeof algorithm !== "string" || !joinAlgorithms.has(algorithm as QueryJoinAlgorithm)) algorithmError(entryPath, `unsupported algorithm ${String(algorithm)}`);
    const typed = algorithm as QueryJoinAlgorithm;
    if (seen.has(typed)) algorithmError(entryPath, `duplicate algorithm ${typed}`);
    seen.add(typed);
  });
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
  query.filters.forEach((filter, index) => { field(filter.field, `where[${index.toString()}].left`); });
  query.orders.forEach((order, index) => { field(order.field, `orderBy[${index.toString()}]`); });
  query.columns?.forEach((column, index) => {
    if (column.expression !== undefined) expression(column.expression, `columns[${index.toString()}]`);
  });
  query.groupBy?.forEach((group, index) => { expression(group, `groupBy[${index.toString()}]`); });
  if (query.having !== undefined) {
    expression(query.having.left, "having.left");
    expression(query.having.right, "having.right");
  }
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
    const tables = schema?.tables.filter((table) => table.name === relation.name && (relation.schema === undefined || table.schema === relation.schema));
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
): Promise<ReadonlyMap<QueryRelation, readonly StoredRow[]>> {
  const result = new Map<QueryRelation, readonly StoredRow[]>();
  let fetched = 0;
  let retained = 0;
  for (const relation of relations) {
    const source: StructuredQuery<Data> = {
      source: relationSource(relation, resolveSource),
      filters: [],
      orders: [],
      limit: limits.maxFetchedRows + 1,
    };
    const page = await executor.query(source);
    if (page.nextCursor !== undefined) planError(aliasOf(relation), "relation scan is paginated");
    const records = page.records;
    fetched += records.length;
    retained += records.reduce((total, record) => total + bytes(record.data), 0);
    for (const record of records) for (const reference of keyReferences.get(relation) ?? []) joinKey(record.data[reference.field], reference.path);
    if (fetched > limits.maxFetchedRows) planError(aliasOf(relation), "fetched-row bound exceeded");
    if (retained > limits.maxRetainedBytes) planError(aliasOf(relation), "retained-byte bound exceeded");
    result.set(relation, records);
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
): Promise<JoinedRow[]> {
  const records = cached.get(relation);
  if (records === undefined) planError(aliasOf(relation), "relation was not scanned");
  let rows: JoinedRow[] = records.map((record) => ({ aliases: new Map([...inherited, [aliasOf(relation), record]]), root: inheritedRoot ?? record }));
  assertRowBound(rows, limits, aliasOf(relation));
  for (const [index, join] of relation.joins.entries()) {
    const next: JoinedRow[] = [];
    const childAliases = aliasesFor(join.from);
    const uncorrelated = !hasExternalReference(join.from, new Set(childAliases));
    const childRows = uncorrelated ? await evaluateRelation(join.from, new Map(), cached, limits, counter) : undefined;
    const hashAvailable = childRows !== undefined && crossSidePredicate(join, new Set(childAliases)) !== undefined;
    const algorithm = selectJoinAlgorithm(join.hints?.algorithms, hashAvailable);
    const candidateLookup = childRows === undefined || algorithm !== "hash" ? undefined : candidateIndex(childRows, join, new Set(childAliases), `joins[${index.toString()}]`);
    for (const left of rows) {
      const candidates = childRows === undefined
        ? await evaluateRelation(join.from, left.aliases, cached, limits, counter, left.root)
        : (algorithm === "hash"
          ? indexedCandidates(left, childRows, candidateLookup, join, new Set(childAliases), `joins[${index.toString()}]`)
          : childRows).map((candidate) => mergeCandidate(left, candidate));
      counter.candidates += candidates.length;
      if (counter.candidates > limits.maxCandidateEvaluations) planError(`${aliasOf(relation)}.joins[${index.toString()}]`, "candidate-evaluation bound exceeded");
      const matches = candidates.filter((candidate) => join.on.every((predicate) => matchesJoin(candidate, predicate, `joins[${index.toString()}]`)));
      if (matches.length > 0) {
        next.push(...matches);
      } else if (join.type === "left") {
        const aliases = new Map(left.aliases);
        for (const alias of childAliases) aliases.set(alias, undefined);
        next.push({ aliases, root: left.root });
      }
      assertRowBound(next, limits, `${aliasOf(relation)}.joins[${index.toString()}]`);
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

function matchesFilter(row: JoinedRow, filter: DTQLQueryFilter): boolean {
  const left = fieldValue(row, filter.field);
  const right = filter.value;
  switch (filter.operator) {
    case "==": return equal(left, right);
    case "!=": return !equal(left, right);
    case "<": return compare(left, right) < 0;
    case "<=": return compare(left, right) <= 0;
    case ">": return compare(left, right) > 0;
    case ">=": return compare(left, right) >= 0;
    case "in": return Array.isArray(right) && right.some((value) => equal(left, value));
    default: planError("where", `unsupported filter ${filter.operator}`);
  }
}

function materialize(rows: readonly JoinedRow[], query: JoinedDTQLQuery, limits: ExecutionLimits): MaterializedRow[] {
  const aggregate = (query.columns ?? []).some((column) => column.expression !== undefined && containsAggregate(column.expression)) || (query.having !== undefined && (containsAggregate(query.having.left) || containsAggregate(query.having.right)));
  if (query.groupBy === undefined && !aggregate) return rows.map((row) => ({ row, group: [row] }));
  const groups = new Map<string, JoinedRow[]>();
  if (rows.length === 0 && query.groupBy === undefined) groups.set("all", []);
  for (const row of rows) {
    const key = query.groupBy === undefined ? "all" : expressionKey(query.groupBy.map((expression) => expressionValue(row, [row], expression)));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const values = [...groups.values()].map((group) => ({ row: group[0] ?? emptyAggregateRow(), group: Object.freeze(group) }));
  assertRowBound(values.map((value) => value.row), limits, "groupBy");
  const having = query.having;
  return having === undefined ? values : values.filter((value) => matchesHaving(value, having));
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

function matchesHaving(value: MaterializedRow, having: NonNullable<JoinedDTQLQuery["having"]>): boolean {
  const left = expressionValue(value.row, value.group, having.left);
  const right = expressionValue(value.row, value.group, having.right);
  switch (having.operator) {
    case "==": return equal(left, right);
    case "!=": return !equal(left, right);
    case "<": return compare(left, right) < 0;
    case "<=": return compare(left, right) <= 0;
    case ">": return compare(left, right) > 0;
    case ">=": return compare(left, right) >= 0;
    default: planError("having", `unsupported operator ${having.operator}`);
  }
}

function stableOrder(rows: readonly MaterializedRow[], query: JoinedDTQLQuery): MaterializedRow[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    for (const order of query.orders) {
      const result = compare(fieldValue(a.row.row, order.field), fieldValue(b.row.row, order.field));
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
  for (const column of query.columns) {
    const expression = column.expression;
    if (expression === undefined) planError("columns", "column expression is required");
    const output = columnOutput(column, "columns");
    result[output] = expressionValue(value.row, value.group, expression) ?? null;
  }
  return result;
}

function columnOutput(column: QueryColumn, path: string): string {
  if (column.as !== undefined) return column.as;
  if (column.expression?.kind === "field") return column.expression.field.field;
  planError(path, "non-field joined column requires an alias");
}

function expressionValue(row: JoinedRow, group: readonly JoinedRow[], expression: DTQLExpression): unknown {
  switch (expression.kind) {
    case "field": return fieldValue(row, expression.field);
    case "literal": return expression.value;
    case "values": return expression.values;
    case "param": return planError("expression", "parameters are not bound by generic execution");
    case "star": return planError("expression", "star is only valid as an aggregate argument");
    case "binary": return binary(expression.operator, expressionValue(row, group, expression.left), expressionValue(row, group, expression.right));
    case "aggregate": return aggregate(group, expression);
  }
}

function aggregate(rows: readonly JoinedRow[], expression: Extract<DTQLExpression, { readonly kind: "aggregate" }>): unknown {
  const argument = expression.args[0];
  if (argument === undefined) planError("aggregate", "aggregate requires an argument");
  const values = argument.kind === "star" ? rows.map(() => 1) : rows.map((row) => expressionValue(row, [row], argument)).filter((value) => value !== undefined && value !== null);
  const distinct = expression.distinct === true ? unique(values) : values;
  switch (expression.function) {
    case "count": return distinct.length;
    case "first": return distinct[0] ?? null;
    case "last": return distinct.at(-1) ?? null;
    case "min": return distinct.length === 0 ? null : distinct.reduce((left, right) => compare(left, right) <= 0 ? left : right);
    case "max": return distinct.length === 0 ? null : distinct.reduce((left, right) => compare(left, right) >= 0 ? left : right);
    case "sum": return distinct.reduce<number>((sum, value) => sum + finiteNumber(value, "sum"), 0);
    case "avg": return distinct.length === 0 ? null : distinct.reduce<number>((sum, value) => sum + finiteNumber(value, "avg"), 0) / distinct.length;
  }
}

function containsAggregate(expression: DTQLExpression): boolean {
  return expression.kind === "aggregate" || (expression.kind === "binary" && (containsAggregate(expression.left) || containsAggregate(expression.right)));
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

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if ((typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string") || (typeof left === "boolean" && typeof right === "boolean")) return left < right ? -1 : 1;
  return typeRank(left) - typeRank(right);
}

function typeRank(value: unknown): number {
  if (typeof value === "string") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "boolean") return 3;
  return 4;
}

function binary(operator: "+" | "-" | "*" | "/", left: unknown, right: unknown): number | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  const leftNumber = finiteNumber(left, "binary");
  const rightNumber = finiteNumber(right, "binary");
  return operator === "+" ? leftNumber + rightNumber : operator === "-" ? leftNumber - rightNumber : operator === "*" ? leftNumber * rightNumber : leftNumber / rightNumber;
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) planError(context, "aggregate requires finite numbers");
  return value;
}

function unique(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
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
    if (value === undefined) return "undefined";
    return value;
  });
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
