import type { QueryExecutor } from "./database.js";
import type { DTQLSchema } from "./dtql.js";
import { Key } from "./key.js";
import type { ExistingRecord } from "./record.js";
import type {
  DTQLExpression,
  QueryFieldReference,
  QueryPage,
  RecursiveDTQLColumn,
  RecursiveDTQLCondition,
  RecursiveDTQLExpression,
  RecursiveDTQLQuery,
  RecursiveDTQLRelation,
  StructuredQuery,
} from "./query.js";
import { parseDocument as parseYamlDocument, stringify as stringifyYaml } from "yaml";

type Data = Record<string, unknown>;
type Row = ExistingRecord<Data>;
type Environment = ReadonlyMap<string, Row | undefined>;
type Truth = true | false | undefined;

export interface RecursiveQueryExecutionOptions {
  readonly maxFetchedRows?: number;
  readonly maxResultRows?: number;
  readonly maxCandidateEvaluations?: number;
  readonly maxRetainedBytes?: number;
  readonly signal?: AbortSignal;
  readonly resolveSource?: (relation: RecursiveDTQLRelation) => StructuredQuery<Data>["source"];
  /** Required only for caller-constructed ASTs; parsed documents carry a private binding. */
  readonly schema?: DTQLSchema;
}

interface Budget {
  fetched: number;
  results: number;
  candidates: number;
  retained: number;
  readonly maxFetchedRows: number;
  readonly maxResultRows: number;
  readonly maxCandidateEvaluations: number;
  readonly maxRetainedBytes: number;
  readonly signal?: AbortSignal;
  readonly memo: WeakMap<RecursiveDTQLQuery, Map<string, Promise<Data[]>>>;
  readonly rowIDs: WeakMap<object, number>;
  nextRowID: number;
}

const defaults = { maxFetchedRows: 10_000, maxResultRows: 10_000, maxCandidateEvaluations: 100_000, maxRetainedBytes: 16 * 1024 * 1024 };
const boundQueries = new WeakSet<RecursiveDTQLQuery>();

/** Parses the additive recursive wire model. Legacy parseDTQL stays unchanged. */
export function parseRecursiveDTQL(input: unknown, schema: DTQLSchema): RecursiveDTQLQuery {
  const root = raw(input, "root");
  const query = parseQuery(root, schema, "root");
  bindQuery(query, schema, [], "");
  boundQueries.add(query);
  return query;
}

export function serializeRecursiveDTQL(query: RecursiveDTQLQuery): Record<string, unknown> {
  return {
    ...(query.as === undefined ? {} : { as: query.as }), from: writeRelation(query.from),
    ...(query.where === undefined ? {} : { where: writeCondition(query.where) }),
    ...(query.groupBy === undefined ? {} : { groupBy: query.groupBy.map(writeExpression) }),
    ...(query.having === undefined ? {} : { having: writeCondition(query.having) }),
    ...(query.orderBy === undefined ? {} : { orderBy: query.orderBy.map((order) => ({ field: order.field.field, source: order.field.source, ...(order.direction === "desc" ? { desc: true } : {}) })) }),
    ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.offset === undefined ? {} : { offset: query.offset }),
    ...(query.columns === undefined ? {} : { columns: query.columns.map((column) => ({ ...writeExpression(column.expression), ...(column.as === undefined ? {} : { as: column.as }) })) }),
  };
}

export function stringifyRecursiveDTQL(query: RecursiveDTQLQuery): string { return stringifyYaml(serializeRecursiveDTQL(query)); }

/**
 * Executes nested DTQL by materializing only ordinary leaf scans through the
 * legacy executor.  A provider can therefore never receive a recursive AST
 * through QueryExecutor.query().  AbortSignal is checked around every nested
 * step; an already in-flight legacy adapter scan cannot itself be interrupted.
 */
export async function executeRecursiveDTQLQuery(
  executor: QueryExecutor,
  query: RecursiveDTQLQuery,
  options: RecursiveQueryExecutionOptions = {},
): Promise<QueryPage<Data>> {
  validateProgram(query, new WeakSet(), "root");
  if (!boundQueries.has(query)) {
    if (options.schema === undefined) shape("root", "caller-constructed recursive query requires schema validation");
    bindQuery(query, options.schema, [], "");
    boundQueries.add(query);
  }
  const budget: Budget = {
    fetched: 0, results: 0, candidates: 0, retained: 0,
    maxFetchedRows: options.maxFetchedRows ?? defaults.maxFetchedRows,
    maxResultRows: options.maxResultRows ?? defaults.maxResultRows,
    maxCandidateEvaluations: options.maxCandidateEvaluations ?? defaults.maxCandidateEvaluations,
    maxRetainedBytes: options.maxRetainedBytes ?? defaults.maxRetainedBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    memo: new WeakMap(), rowIDs: new WeakMap(), nextRowID: 0,
  };
  for (const key of ["maxFetchedRows", "maxResultRows", "maxCandidateEvaluations", "maxRetainedBytes"] as const) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0) throw new TypeError(`query_limit at root: ${key} must be a positive safe integer`);
  }
  const rows = await evaluateQuery(executor, query, new Map(), budget, options, "root");
  cancelled(budget, "root");
  return { records: rows.map((row, index) => ({ key: new Key("__dtql__", index.toString()), exists: true as const, data: row })) };
}

async function evaluateQuery(executor: QueryExecutor, query: RecursiveDTQLQuery, outer: Environment, budget: Budget, options: RecursiveQueryExecutionOptions, path: string): Promise<Data[]> {
  cancelled(budget, path);
  let rows = await evaluateRelation(executor, query.from, outer, budget, options, `${path}.from`);
  if (query.where !== undefined) {
    const filtered: Environment[] = [];
    for (const row of rows) if ((await condition(executor, query.where, row, budget, options, `${path}.where`)) === true) filtered.push(row);
    rows = filtered;
  }
  let groups = groupsFor(query, rows);
  if (query.having !== undefined) {
    const kept: Environment[][] = [];
    for (const group of groups) {
      if ((await condition(executor, query.having, group[0] ?? new Map(), budget, options, `${path}.having`, group)) === true) kept.push(group);
    }
    groups = kept;
  }
  if (query.orderBy !== undefined) groups = [...groups].sort((a, b) => compareEnvironment(a[0] ?? new Map(), b[0] ?? new Map(), query.orderBy ?? []));
  const start = query.offset ?? 0;
  groups = groups.slice(start, query.limit === undefined ? undefined : start + query.limit);
  const output = await projectGroups(executor, query, groups, budget, options, path);
  chargeResults(budget, output.length, path);
  return output;
}

async function evaluateRelation(executor: QueryExecutor, relation: RecursiveDTQLRelation, outer: Environment, budget: Budget, options: RecursiveQueryExecutionOptions, path: string): Promise<Environment[]> {
  cancelled(budget, path);
  const alias = relation.alias ?? relation.name ?? relation.query?.as;
  if (alias === undefined || alias.length === 0) shape(path, "relation needs a name or query.as alias");
  let records: readonly Row[];
  if (relation.kind === "table") {
    if (relation.name === undefined) shape(path, "table relation needs name");
    const source = options.resolveSource?.(relation) ?? (relation.schema === undefined ? { kind: "collection" as const, name: relation.name } : undefined);
    if (source === undefined) shape(path, "schema-qualified relation requires resolveSource");
    cancelled(budget, path);
    const page = await executor.query<Data>({ source, filters: [], orders: [], limit: budget.maxFetchedRows + 1 });
    cancelled(budget, path);
    if (page.nextCursor !== undefined) shape(path, "leaf relation scan is paginated");
    records = page.records;
    budget.fetched += records.length;
    if (budget.fetched > budget.maxFetchedRows) limit(path, "fetched_rows");
    for (const record of records) chargeBytes(budget, record.data, path);
  } else {
    if (relation.query === undefined) shape(path, "query relation needs query");
    const data = await evaluateQuery(executor, relation.query, outer, budget, options, `${path}.query`);
    records = data.map((value, index) => ({ key: new Key("__dtql_derived__", index.toString()), exists: true, data: value }));
  }
  let rows: Environment[] = records.map((record) => new Map([...outer, [alias, record]]));
  for (const [index, join] of relation.joins.entries()) {
    const joined: Environment[] = [];
    for (const left of rows) {
      const right = await evaluateRelation(executor, join.from, left, budget, options, `${path}.joins[${index.toString()}].from`);
      let matched = false;
      for (const candidate of right) {
        budget.candidates += 1;
        if (budget.candidates > budget.maxCandidateEvaluations) limit(`${path}.joins[${index.toString()}]`, "candidate_evaluations");
        if (join.on.every((predicate) => joinEqual(field(candidate, predicate.left), field(candidate, predicate.right)))) {
          joined.push(candidate); matched = true;
        }
      }
      if (!matched && join.type === "left") {
        const empty = new Map(left);
        empty.set(join.from.alias ?? join.from.name ?? join.from.query?.as ?? "", undefined);
        joined.push(empty);
      }
    }
    rows = joined;
  }
  return rows;
}

// EXISTS needs only the presence of the first row after the nested logical
// pipeline.  Keep the fast path before projection so scalar expressions in an
// EXISTS body never run, and so a qualifying WHERE row stops evaluation.
async function queryExists(executor: QueryExecutor, query: RecursiveDTQLQuery, outer: Environment, budget: Budget, options: RecursiveQueryExecutionOptions, path: string): Promise<boolean> {
  let rows = await evaluateRelation(executor, query.from, outer, budget, options, `${path}.from`);
  const needsGroups = query.groupBy !== undefined || query.having !== undefined || (query.columns?.some((column) => containsAggregate(column.expression)) ?? false);
  // With no grouping/HAVING and offset zero, ordering cannot change whether a
  // row exists; limit only caps a non-empty result.
  if (!needsGroups && (query.offset ?? 0) === 0) {
    for (const row of rows) {
      if (query.where === undefined || (await condition(executor, query.where, row, budget, options, `${path}.where`)) === true) return true;
    }
    return false;
  }
  if (query.where !== undefined) {
    const filtered: Environment[] = [];
    for (const row of rows) if ((await condition(executor, query.where, row, budget, options, `${path}.where`)) === true) filtered.push(row);
    rows = filtered;
  }
  let groups = groupsFor(query, rows);
  if (query.having !== undefined) {
    const kept: Environment[][] = [];
    for (const group of groups) if ((await condition(executor, query.having, group[0] ?? new Map(), budget, options, `${path}.having`, group)) === true) kept.push(group);
    groups = kept;
  }
  if (query.orderBy !== undefined) groups = [...groups].sort((a, b) => compareEnvironment(a[0] ?? new Map(), b[0] ?? new Map(), query.orderBy ?? []));
  const start = query.offset ?? 0;
  return groups.slice(start, query.limit === undefined ? undefined : start + query.limit).length > 0;
}

// Cache nested scalar/set evaluations by the actual outer-row binding. Queries
// that do not mention any current outer alias share the same key and therefore
// run once for the whole root execution. A false positive merely skips caching;
// it can never reuse a result for the wrong binding.
async function evaluateNested(executor: QueryExecutor, query: RecursiveDTQLQuery, outer: Environment, budget: Budget, options: RecursiveQueryExecutionOptions, path: string): Promise<Data[]> {
  const key = referencesOuter(query, new Set(outer.keys())) ? bindingKey(outer, budget) : "uncorrelated";
  let entries = budget.memo.get(query);
  if (entries === undefined) { entries = new Map(); budget.memo.set(query, entries); }
  let result = entries.get(key);
  if (result === undefined) {
    result = evaluateQuery(executor, query, outer, budget, options, path);
    entries.set(key, result);
  }
  return result;
}

function bindingKey(outer: Environment, budget: Budget): string {
  return [...outer.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([alias, row]) => {
    if (row === undefined) return `${alias}:null`;
    let id = budget.rowIDs.get(row);
    if (id === undefined) { budget.nextRowID += 1; id = budget.nextRowID; budget.rowIDs.set(row, id); }
    return `${alias}:${id.toString()}`;
  }).join("|");
}

function referencesOuter(query: RecursiveDTQLQuery, outer: ReadonlySet<string>): boolean {
  const mentions = (expression: RecursiveDTQLExpression): boolean => expression.kind === "field" ? outer.has(expression.field.source) : expression.kind === "query" ? referencesOuter(expression.query, outer) : expression.kind === "aggregate" ? expression.args.some((item) => mentions(item)) : expression.kind === "binary" ? mentions(expression.left) || mentions(expression.right) : false;
  const conditionMentions = (condition: RecursiveDTQLCondition | undefined): boolean => {
    if (condition === undefined) return false;
    if (condition.kind === "exists" || condition.kind === "not-exists") return referencesOuter(condition.query, outer);
    if (condition.kind === "and" || condition.kind === "or") return condition.conditions.some(conditionMentions);
    const comparison = condition as Extract<RecursiveDTQLCondition, { readonly kind: "comparison" }>;
    return mentions(comparison.left) || mentions(comparison.right);
  };
  return conditionMentions(query.where) || conditionMentions(query.having) || (query.groupBy?.some(mentions) ?? false) || (query.columns?.some((column) => mentions(column.expression)) ?? false) || query.from.joins.some((join) => join.on.some((predicate) => outer.has(predicate.left.source) || outer.has(predicate.right.source)) || (join.from.kind === "query" && referencesOuter(join.from.query ?? shape("from", "query relation needs query"), outer)));
}

function groupsFor(query: RecursiveDTQLQuery, rows: readonly Environment[]): Environment[][] {
  const aggregates = query.columns?.some((column) => containsAggregate(column.expression)) ?? false;
  const groups = new Map<string, Environment[]>();
  if (aggregates || query.groupBy !== undefined) {
    if (rows.length === 0 && aggregates && query.groupBy === undefined) groups.set("all", []);
    for (const row of rows) {
      const group = query.groupBy === undefined ? "all" : JSON.stringify(query.groupBy.map((item) => legacyExpression(item, row)));
      const current = groups.get(group) ?? []; current.push(row); groups.set(group, current);
    }
  } else for (const row of rows) groups.set(groups.size.toString(), [row]);
  return [...groups.values()];
}

async function projectGroups(executor: QueryExecutor, query: RecursiveDTQLQuery, groups: readonly (readonly Environment[])[], budget: Budget, options: RecursiveQueryExecutionOptions, path: string): Promise<Data[]> {
  if (query.columns === undefined) return groups.map((group) => merge(group[0] ?? new Map()));
  const result: Data[] = [];
  for (const group of groups) {
    const row = group[0] ?? new Map();
    const value: Data = {};
    for (const [index, column] of query.columns.entries()) {
      const output = column.as ?? fieldOutput(column, `${path}.columns[${index.toString()}]`);
      value[output] = (await expression(executor, column.expression, row, budget, options, `${path}.columns[${index.toString()}]`, group)) ?? null;
    }
    result.push(value);
  }
  return result;
}

async function condition(executor: QueryExecutor, value: RecursiveDTQLCondition, row: Environment, budget: Budget, options: RecursiveQueryExecutionOptions, path: string, group?: readonly Environment[]): Promise<Truth> {
  if (value.kind === "and" || value.kind === "or") {
    let unknown = false;
    for (const [index, child] of value.conditions.entries()) {
      const current = await condition(executor, child, row, budget, options, `${path}.${value.kind}[${index.toString()}]`, group);
      if (value.kind === "and" && current === false) return false;
      if (value.kind === "or" && current === true) return true;
      unknown ||= current === undefined;
    }
    return unknown ? undefined : value.kind === "and";
  }
  if (value.kind === "exists" || value.kind === "not-exists") {
    const exists = await queryExists(executor, value.query, row, budget, options, `${path}.query`);
    return value.kind === "exists" ? exists : !exists;
  }
  const comparison = value as Extract<RecursiveDTQLCondition, { readonly kind: "comparison" }>;
  const left = await expression(executor, comparison.left, row, budget, options, `${path}.left`, group);
  if (comparison.operator === "in" || comparison.operator === "not-in") {
    const right = comparison.right.kind === "query"
      ? (await evaluateNested(executor, comparison.right.query, row, budget, options, `${path}.right.query`)).map((item) => { const values = Object.values(item); if (values.length !== 1) shape(`${path}.right.query`, "IN query requires one column"); return values[0]; })
      : await expression(executor, comparison.right, row, budget, options, `${path}.right`, group);
    return membership(left, Array.isArray(right) ? right : [], comparison.operator === "not-in");
  }
  const right = await expression(executor, comparison.right, row, budget, options, `${path}.right`, group);
  if (left === null || left === undefined || right === null || right === undefined) return undefined;
  switch (comparison.operator) {
    case "==": return equal(left, right);
    case "!=": return !equal(left, right);
    case "<": return compare(left, right) < 0;
    case "<=": return compare(left, right) <= 0;
    case ">": return compare(left, right) > 0;
    case ">=": return compare(left, right) >= 0;
    default: shape(path, `unsupported operator ${comparison.operator}`);
  }
}

async function expression(executor: QueryExecutor, value: RecursiveDTQLExpression, row: Environment, budget: Budget, options: RecursiveQueryExecutionOptions, path: string, group?: readonly Environment[]): Promise<unknown> {
  if (value.kind === "query") {
    const rows = await evaluateNested(executor, value.query, row, budget, options, `${path}.query`);
    if (rows.length > 1) shape(`${path}.query`, "scalar query returned more than one row");
    const first = rows[0];
    if (first === undefined) return null;
    const values = Object.values(first);
    if (values.length !== 1) shape(`${path}.query`, "scalar query requires one column");
    return values[0] ?? null;
  }
  return legacyExpression(value, row, group);
}

function legacyExpression(value: DTQLExpression, row: Environment, group: readonly Environment[] = [row]): unknown {
  switch (value.kind) {
    case "field": return field(row, value.field);
    case "literal": return value.value;
    case "values": return value.values;
    case "binary": { const left = legacyExpression(value.left, row, group); const right = legacyExpression(value.right, row, group); return typeof left === "number" && typeof right === "number" ? value.operator === "+" ? left + right : value.operator === "-" ? left - right : value.operator === "*" ? left * right : left / right : null; }
    case "aggregate": {
      const arg = value.args[0];
      if (arg === undefined) return null;
      const values = arg.kind === "star" ? group.map(() => 1) : group.map((item) => legacyExpression(arg, item, [item])).filter((item) => item !== null && item !== undefined);
      if (value.function === "count") return values.length;
      if (value.function === "sum") return values.reduce<number>((sum, item) => sum + (typeof item === "number" ? item : 0), 0);
      if (value.function === "avg") return values.length === 0 ? null : values.reduce<number>((sum, item) => sum + (typeof item === "number" ? item : 0), 0) / values.length;
      if (value.function === "first") return values[0] ?? null;
      if (value.function === "last") return values.at(-1) ?? null;
      if (value.function === "min") return values.length === 0 ? null : values.reduce((best, item) => compare(item, best) < 0 ? item : best);
      return values.length === 0 ? null : values.reduce((best, item) => compare(item, best) > 0 ? item : best);
    }
    default: shape("expression", `${value.kind} is unavailable in recursive scalar evaluation`);
  }
}

function containsAggregate(value: RecursiveDTQLExpression): boolean { return value.kind === "aggregate" || (value.kind === "binary" && (containsAggregate(value.left) || containsAggregate(value.right))); }

function membership(left: unknown, values: readonly unknown[], negate: boolean): Truth {
  if (values.length === 0) return negate;
  if (left === null || left === undefined) return undefined;
  if (values.some((value) => value !== null && value !== undefined && equal(left, value))) return !negate;
  if (values.some((value) => value === null || value === undefined)) return undefined;
  return negate;
}

function joinEqual(left: unknown, right: unknown): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && equal(left, right);
}

function field(row: Environment, reference: QueryFieldReference): unknown { return row.get(resolvedSources.get(reference) ?? reference.source)?.data[reference.field]; }
function merge(row: Environment): Data { const value: Data = {}; for (const record of row.values()) if (record !== undefined) Object.assign(value, record.data); return value; }
function fieldOutput(column: RecursiveDTQLColumn, path: string): string { if (column.expression.kind === "field") return column.expression.field.field; if (column.expression.kind === "aggregate") return column.expression.function; return shape(path, "non-field column requires as"); }
function equal(left: unknown, right: unknown): boolean { return typeof left === "number" && typeof right === "number" ? Number.isFinite(left) && Number.isFinite(right) && left === right : left === right; }
function compare(left: unknown, right: unknown): number { return left === right ? 0 : left === null || left === undefined ? -1 : right === null || right === undefined ? 1 : left < right ? -1 : 1; }
function compareEnvironment(left: Environment, right: Environment, orders: readonly { readonly field: QueryFieldReference; readonly direction: "asc" | "desc" }[]): number { for (const order of orders) { const result = compare(field(left, order.field), field(right, order.field)); if (result !== 0) return order.direction === "desc" ? -result : result; } return 0; }
function chargeResults(budget: Budget, count: number, path: string): void { budget.results += count; if (budget.results > budget.maxResultRows) limit(path, "result_rows"); }
function chargeBytes(budget: Budget, value: unknown, path: string): void { budget.retained += new TextEncoder().encode(JSON.stringify(value)).byteLength; if (budget.retained > budget.maxRetainedBytes) limit(path, "retained_bytes"); }
function cancelled(budget: Budget, path: string): void { if (budget.signal?.aborted === true) throw budget.signal.reason ?? new DOMException(`query cancelled at ${path}`, "AbortError"); }
function shape(path: string, reason: string): never { throw new TypeError(`shape at ${path}: ${reason}`); }
function limit(path: string, counter: string): never { throw new RangeError(`query_limit at ${path}: ${counter}`); }

type BoundSource = ReadonlySet<string>;
const resolvedSources = new WeakMap<QueryFieldReference, string>();

function at(path: string, suffix: string): string { return path === "" ? suffix : `${path}.${suffix}`; }

// Binding is deliberately separate from execution. It rejects missing and
// forward aliases before a provider sees a leaf query, while retaining source
// names in the public AST for canonical serialization.
function bindQuery(query: RecursiveDTQLQuery, schema: DTQLSchema, outers: readonly ReadonlyMap<string, BoundSource>[], path: string): BoundSource {
  const local = bindRelation(query.from, schema, outers, path === "" ? "from" : `${path}.from`);
  bindCondition(query.where, schema, local, outers, at(path, "where"));
  for (const [index, expression] of (query.groupBy ?? []).entries()) bindExpression(expression, schema, local, outers, `${at(path, "groupBy")}[${index.toString()}]`, "ordinary");
  bindCondition(query.having, schema, local, outers, at(path, "having"));
  for (const [index, order] of (query.orderBy ?? []).entries()) bindField(order.field, local, outers, `${at(path, "orderBy")}[${index.toString()}]`);
  for (const [index, column] of (query.columns ?? []).entries()) {
    const columnPath = `${at(path, "columns")}[${index.toString()}]`;
    bindExpression(column.expression, schema, local, outers, columnPath, "column");
    if (column.expression.kind === "query") {
      if (column.as !== undefined && column.as !== column.expression.query.as) shape(columnPath, "scalar query alias belongs in query.as");
      if (column.expression.query.as === undefined) shape(`${columnPath}.query.as`, "scalar query requires as");
      scalarShape(column.expression.query, `${columnPath}.query`);
    }
  }
  return outputFields(query, local, path);
}

function bindRelation(relation: RecursiveDTQLRelation, schema: DTQLSchema, outers: readonly ReadonlyMap<string, BoundSource>[], path: string): ReadonlyMap<string, BoundSource> {
  const visible = new Map<string, BoundSource>();
  const bindOne = (value: RecursiveDTQLRelation, sourcePath: string): void => {
    const alias = value.alias ?? value.name ?? value.query?.as;
    if (alias === undefined || alias.length === 0) shape(sourcePath, "relation needs a name or query.as alias");
    let fields: BoundSource;
    if (value.kind === "table") {
      const table = schema.tables.find((item) => item.name === value.name && (value.schema === undefined || item.schema === value.schema));
      if (table === undefined) shape(sourcePath, `unknown table ${value.name ?? ""}`);
      fields = new Set(table.fields);
    } else {
      if (value.query?.as === undefined || value.query.as.length === 0) shape(`${sourcePath}.query.as`, "derived query requires as");
      fields = bindQuery(value.query, schema, [visible, ...outers], `${sourcePath}.query`);
    }
    if (visible.has(alias)) shape(sourcePath, `duplicate source alias ${alias}`);
    visible.set(alias, fields);
  };
  bindOne({ ...relation, joins: [] }, path);
  for (const [index, join] of relation.joins.entries()) {
    const joinPath = `${path}.joins[${index.toString()}]`;
    const future = new Set(relation.joins.slice(index + 1).map((item) => item.from.alias ?? item.from.name ?? item.from.query?.as).filter((item): item is string => item !== undefined));
    bindOne({ ...join.from, joins: [] }, `${joinPath}.from`);
    for (const [predicateIndex, predicate] of join.on.entries()) {
      bindJoinField(predicate.left, visible, outers, future, `${joinPath}.on[${predicateIndex.toString()}].left`);
      bindJoinField(predicate.right, visible, outers, future, `${joinPath}.on[${predicateIndex.toString()}].right`);
    }
    // A nested right relation may itself have joins. Its aliases remain
    // visible to the enclosing relation after their edge has been bound.
    if (join.from.joins.length > 0) {
      const nested = bindRelation(join.from, schema, [visible, ...outers], `${joinPath}.from`);
      for (const [alias, fields] of nested) if (!visible.has(alias)) visible.set(alias, fields);
    }
  }
  return visible;
}

function bindJoinField(reference: QueryFieldReference, local: ReadonlyMap<string, BoundSource>, outers: readonly ReadonlyMap<string, BoundSource>[], future: ReadonlySet<string>, path: string): void {
  if (!local.has(reference.source) && future.has(reference.source)) throw new TypeError(`join_scope at ${path}.source: forward source alias ${reference.source} is unavailable`);
  bindField(reference, local, outers, path, "join_scope");
}

function bindField(reference: QueryFieldReference, local: ReadonlyMap<string, BoundSource>, outers: readonly ReadonlyMap<string, BoundSource>[], path: string, category = "scope"): void {
  if (reference.source === "") {
    const candidates = [...local.entries()].filter(([, fields]) => fields.has(reference.field));
    if (candidates.length > 1) throw new TypeError(`${category} at ${path}: ambiguous unqualified field ${reference.field}`);
    if (candidates.length === 1) { const [alias] = candidates[0] ?? []; if (alias !== undefined) resolvedSources.set(reference, alias); return; }
    for (const scope of outers) {
      const outerCandidates = [...scope.entries()].filter(([, fields]) => fields.has(reference.field));
      if (outerCandidates.length > 1) throw new TypeError(`${category} at ${path}: ambiguous unqualified field ${reference.field}`);
      if (outerCandidates.length === 1) { const [alias] = outerCandidates[0] ?? []; if (alias !== undefined) resolvedSources.set(reference, alias); return; }
    }
    throw new TypeError(`${category} at ${path}: unknown field ${reference.field}`);
  }
  let fields = local.get(reference.source);
  if (fields === undefined) for (const scope of outers) { fields = scope.get(reference.source); if (fields !== undefined) break; }
  if (fields === undefined) throw new TypeError(`${category} at ${path}.source: unknown source alias ${reference.source}`);
  if (!fields.has(reference.field)) throw new TypeError(`${category} at ${path}: unknown field ${reference.field}`);
}

function bindExpression(value: RecursiveDTQLExpression, schema: DTQLSchema, local: ReadonlyMap<string, BoundSource>, outers: readonly ReadonlyMap<string, BoundSource>[], path: string, context: "ordinary" | "column" | "membership" = "ordinary"): void {
  if (value.kind === "field") { bindField(value.field, local, outers, path); return; }
  if (value.kind === "query") {
    if (context !== "column" && context !== "membership") shape(path, "query expression is not valid here");
    bindQuery(value.query, schema, [local, ...outers], `${path}.query`);
    return;
  }
  if (value.kind === "aggregate") for (const [index, argument] of value.args.entries()) bindExpression(argument, schema, local, outers, `${path}.aggregate.args[${index.toString()}]`);
  if (value.kind === "binary") { bindExpression(value.left, schema, local, outers, `${path}.binary.left`); bindExpression(value.right, schema, local, outers, `${path}.binary.right`); }
}

function bindCondition(value: RecursiveDTQLCondition | undefined, schema: DTQLSchema, local: ReadonlyMap<string, BoundSource>, outers: readonly ReadonlyMap<string, BoundSource>[], path: string): void {
  if (value === undefined) return;
  if (value.kind === "and" || value.kind === "or") { value.conditions.forEach((child, index) => { bindCondition(child, schema, local, outers, `${path}.${value.kind}[${index.toString()}]`); }); return; }
  if (value.kind === "exists" || value.kind === "not-exists") { bindQuery(value.query, schema, [local, ...outers], `${path}.query`); return; }
  const comparison = value as Extract<RecursiveDTQLCondition, { readonly kind: "comparison" }>;
  bindExpression(comparison.left, schema, local, outers, `${path}.left`);
  const membership = comparison.operator === "in" || comparison.operator === "not-in";
  bindExpression(comparison.right, schema, local, outers, `${path}.right`, membership ? "membership" : "ordinary");
  if (comparison.right.kind === "query") {
    if (!membership) shape(`${path}.right`, "query right operand requires In or NotIn");
    scalarShape(comparison.right.query, `${path}.right.query`);
  }
  if (comparison.left.kind === "query") shape(`${path}.left`, "query expressions are not valid as comparison left operands");
}

function scalarShape(query: RecursiveDTQLQuery, path: string): void {
  if (query.columns?.length !== 1) shape(`${path}.columns`, "scalar query requires exactly one column");
}

function outputFields(query: RecursiveDTQLQuery, local: ReadonlyMap<string, BoundSource>, path: string): BoundSource {
  if (query.columns === undefined) {
    const output = new Set<string>();
    for (const fields of local.values()) for (const field of fields) {
      if (output.has(field)) shape(at(path, "columns"), `duplicate output field ${field}`);
      output.add(field);
    }
    return output;
  }
  const output = new Set<string>();
  for (const [index, column] of query.columns.entries()) {
    const name = column.as ?? (column.expression.kind === "field" ? column.expression.field.field : column.expression.kind === "aggregate" ? column.expression.function : column.expression.kind === "query" ? column.expression.query.as : undefined);
    if (name === undefined) shape(`${at(path, "columns")}[${index.toString()}]`, "computed column requires as");
    if (output.has(name)) shape(`${at(path, "columns")}[${index.toString()}]`, `duplicate output field ${name}`);
    output.add(name);
  }
  return output;
}

function validateProgram(query: RecursiveDTQLQuery, ancestors: WeakSet<object>, path: string): void {
  if (ancestors.has(query)) shape(path, "recursive query cycle");
  ancestors.add(query);
  try {
    validateRelationProgram(query.from, ancestors, `${path}.from`);
    validateConditionProgram(query.where, ancestors, `${path}.where`);
    validateConditionProgram(query.having, ancestors, `${path}.having`);
    query.columns?.forEach((column, index) => { validateExpressionProgram(column.expression, ancestors, `${path}.columns[${index.toString()}]`); });
    query.groupBy?.forEach((expression, index) => { validateExpressionProgram(expression, ancestors, `${path}.groupBy[${index.toString()}]`); });
  } finally { ancestors.delete(query); }
}

function validateRelationProgram(relation: RecursiveDTQLRelation, ancestors: WeakSet<object>, path: string): void {
  if (ancestors.has(relation)) shape(path, "recursive relation cycle");
  ancestors.add(relation);
  try {
    if (relation.kind === "query") validateProgram(relation.query ?? shape(path, "query relation needs query"), ancestors, `${path}.query`);
    relation.joins.forEach((join, index) => { validateRelationProgram(join.from, ancestors, `${path}.joins[${index.toString()}].from`); });
  } finally { ancestors.delete(relation); }
}

function validateConditionProgram(value: RecursiveDTQLCondition | undefined, ancestors: WeakSet<object>, path: string): void {
  if (value === undefined) return;
  if (value.kind === "exists" || value.kind === "not-exists") { validateProgram(value.query, ancestors, `${path}.query`); return; }
  if (value.kind === "and" || value.kind === "or") { value.conditions.forEach((child, index) => { validateConditionProgram(child, ancestors, `${path}.${value.kind}[${index.toString()}]`); }); return; }
  const comparison = value as Extract<RecursiveDTQLCondition, { readonly kind: "comparison" }>;
  validateExpressionProgram(comparison.left, ancestors, `${path}.left`);
  validateExpressionProgram(comparison.right, ancestors, `${path}.right`);
}

function validateExpressionProgram(value: RecursiveDTQLExpression, ancestors: WeakSet<object>, path: string): void {
  if (value.kind === "query") { validateProgram(value.query, ancestors, `${path}.query`); return; }
  if (value.kind === "aggregate") value.args.forEach((item, index) => { validateExpressionProgram(item, ancestors, `${path}.aggregate.args[${index.toString()}]`); });
  if (value.kind === "binary") { validateExpressionProgram(value.left, ancestors, `${path}.binary.left`); validateExpressionProgram(value.right, ancestors, `${path}.binary.right`); }
}

function parseQuery(value: Record<string, unknown>, schema: DTQLSchema, path: string): RecursiveDTQLQuery {
  keys(value, new Set(["as", "from", "where", "groupBy", "having", "orderBy", "limit", "offset", "columns"]), path);
  const result: RecursiveDTQLQuery = {
    kind: "recursive-dtql", from: parseRelation(requireValue(value, "from", path), schema, `${path}.from`),
    ...(value.as === undefined ? {} : { as: text(value.as, `${path}.as`) }),
    ...(value.where === undefined ? {} : { where: parseCondition(raw(value.where, `${path}.where`), schema, `${path}.where`) }),
    ...(value.orderBy === undefined ? {} : { orderBy: list(value.orderBy, `${path}.orderBy`).map((item, index) => { const order = raw(item, `${path}.orderBy[${index.toString()}]`); keys(order, new Set(["field", "source", "desc"]), `${path}.orderBy[${index.toString()}]`); const desc = order.desc === true; delete order.desc; return { field: fieldReference(order, `${path}.orderBy[${index.toString()}]`), direction: desc ? "desc" as const : "asc" as const }; }) }),
    ...(value.limit === undefined ? {} : { limit: positive(value.limit, `${path}.limit`) }),
    ...(value.offset === undefined ? {} : { offset: offset(value.offset, `${path}.offset`) }),
    ...(value.columns === undefined ? {} : { columns: list(value.columns, `${path}.columns`).map((item, index) => { const column = raw(item, `${path}.columns[${index.toString()}]`); const as = column.as === undefined ? undefined : text(column.as, `${path}.columns[${index.toString()}].as`); delete column.as; const expression = parseExpression(column, schema, `${path}.columns[${index.toString()}]`); return { expression, ...(as === undefined ? expression.kind === "query" && expression.query.as !== undefined ? { as: expression.query.as } : {} : { as }) }; }) }),
    ...(value.groupBy === undefined ? {} : { groupBy: list(value.groupBy, `${path}.groupBy`).map((item, index) => parseExpression(item, schema, `${path}.groupBy[${index.toString()}]`) as DTQLExpression) }),
    ...(value.having === undefined ? {} : { having: parseCondition(raw(value.having, `${path}.having`), schema, `${path}.having`) }),
  };
  return result;
}

function parseRelation(value: unknown, schema: DTQLSchema, path: string): RecursiveDTQLRelation {
  const source = raw(value, path); keys(source, new Set(["name", "schema", "alias", "as", "query", "joins"]), path);
  const hasName = source.name !== undefined; const hasQuery = source.query !== undefined;
  if (hasName === hasQuery) shape(path, "requires exactly one of name or query");
  const joins = source.joins === undefined ? [] : list(source.joins, `${path}.joins`).map((item, index) => parseJoin(raw(item, `${path}.joins[${index.toString()}]`), schema, `${path}.joins[${index.toString()}]`));
  if (hasName) {
    const name = text(source.name, `${path}.name`); const relationSchema = source.schema === undefined ? undefined : text(source.schema, `${path}.schema`);
    if (!schema.tables.some((table) => table.name === name && (relationSchema === undefined || table.schema === relationSchema))) shape(path, `unknown table ${name}`);
    const alias = source.alias ?? source.as; if (source.alias !== undefined && source.as !== undefined) shape(path, "alias and as cannot both be set");
    return { kind: "table", name, ...(relationSchema === undefined ? {} : { schema: relationSchema }), ...(alias === undefined ? {} : { alias: text(alias, `${path}.alias`) }), joins: joins as RecursiveDTQLRelation["joins"] };
  }
  if (source.schema !== undefined || source.alias !== undefined || source.as !== undefined) shape(path, "derived alias belongs in query.as");
  return { kind: "query", query: parseQuery(raw(source.query, `${path}.query`), schema, `${path}.query`), joins: joins as RecursiveDTQLRelation["joins"] };
}

function parseJoin(value: Record<string, unknown>, schema: DTQLSchema, path: string) {
  keys(value, new Set(["type", "from", "on", "hints"]), path); const type = value.type === undefined ? "inner" : value.type;
  if (type !== "inner" && type !== "left") shape(`${path}.type`, "must be inner or left");
  const predicates = list(requireValue(value, "on", path), `${path}.on`).map((item, index) => { const predicate = raw(item, `${path}.on[${index.toString()}]`); keys(predicate, new Set(["left", "op", "right"]), `${path}.on[${index.toString()}]`); if (predicate.op !== "==" && predicate.op !== "eq") shape(`${path}.on[${index.toString()}].op`, "must be =="); return { left: fieldReference(raw(requireValue(predicate, "left", path), `${path}.on[${index.toString()}].left`), `${path}.on[${index.toString()}].left`), operator: "==" as const, right: fieldReference(raw(requireValue(predicate, "right", path), `${path}.on[${index.toString()}].right`), `${path}.on[${index.toString()}].right`) }; });
  if (predicates.length === 0) shape(`${path}.on`, "must not be empty");
  const hints = value.hints === undefined ? undefined : parseHints(raw(value.hints, `${path}.hints`), `${path}.hints`);
  return { type, from: parseRelation(requireValue(value, "from", path), schema, `${path}.from`), on: predicates, ...(hints === undefined ? {} : { hints }) };
}

function parseHints(value: Record<string, unknown>, path: string) {
  keys(value, new Set(["algorithms"]), path);
  const algorithms = list(requireValue(value, "algorithms", path), `${path}.algorithms`);
  const supported = new Set(["hash", "merge", "lookup", "batchedLookup", "nestedLoop"]);
  if (algorithms.length === 0 || !algorithms.every((item) => typeof item === "string" && supported.has(item))) shape(`${path}.algorithms`, "invalid algorithms");
  return { algorithms: algorithms as ("hash" | "merge" | "lookup" | "batchedLookup" | "nestedLoop")[] };
}

function parseCondition(value: Record<string, unknown>, schema: DTQLSchema, path: string): RecursiveDTQLCondition {
  if (value.exists !== undefined || value.notExists !== undefined) { const yes = value.exists !== undefined; keys(value, new Set([yes ? "exists" : "notExists"]), path); const nested = raw(yes ? value.exists : value.notExists, `${path}.query`); keys(nested, new Set(["query"]), `${path}.query`); return { kind: yes ? "exists" : "not-exists", query: parseQuery(raw(nested.query, `${path}.query`), schema, `${path}.query`) }; }
  if (value.and !== undefined || value.or !== undefined) { const kind = value.and === undefined ? "or" : "and"; keys(value, new Set([kind]), path); return { kind, conditions: list(value[kind], `${path}.${kind}`).map((item, index) => parseCondition(raw(item, `${path}.${kind}[${index.toString()}]`), schema, `${path}.${kind}[${index.toString()}]`)) }; }
  keys(value, new Set(["left", "op", "right"]), path); const op = text(requireValue(value, "op", path), `${path}.op`); const operator = op === "In" ? "in" : op === "NotIn" ? "not-in" : op;
  if (!["==", "!=", "<", "<=", ">", ">=", "in", "not-in"].includes(operator)) shape(`${path}.op`, `unsupported operator ${op}`);
  return { kind: "comparison", left: parseExpression(requireValue(value, "left", path), schema, `${path}.left`), operator: operator as never, right: parseExpression(requireValue(value, "right", path), schema, `${path}.right`) };
}

function parseExpression(value: unknown, schema: DTQLSchema, path: string): RecursiveDTQLExpression {
  const expression = raw(value, path);
  if (expression.query !== undefined) { keys(expression, new Set(["query"]), path); return { kind: "query", query: parseQuery(raw(expression.query, `${path}.query`), schema, `${path}.query`) }; }
  if (expression.field !== undefined) return { kind: "field", field: fieldReference(expression, path) };
  if (Object.prototype.hasOwnProperty.call(expression, "value")) { keys(expression, new Set(["value"]), path); return { kind: "literal", value: expression.value as string | number | boolean | null }; }
  if (expression.values !== undefined) { keys(expression, new Set(["values"]), path); return { kind: "values", values: list(expression.values, `${path}.values`) as (string | number | boolean | null)[] }; }
  if (expression.star === true) return { kind: "star" };
  if (expression.aggregate !== undefined) { keys(expression, new Set(["aggregate"]), path); const aggregate = raw(expression.aggregate, `${path}.aggregate`); keys(aggregate, new Set(["function", "args", "distinct"]), `${path}.aggregate`); return { kind: "aggregate", function: text(requireValue(aggregate, "function", `${path}.aggregate`), `${path}.aggregate.function`) as never, args: list(requireValue(aggregate, "args", `${path}.aggregate`), `${path}.aggregate.args`).map((item, index) => parseExpression(item, schema, `${path}.aggregate.args[${index.toString()}]`) as DTQLExpression), ...(aggregate.distinct === true ? { distinct: true } : {}) }; }
  shape(path, "unknown expression");
}

function writeRelation(value: RecursiveDTQLRelation): Record<string, unknown> { const joins = value.joins.length === 0 ? {} : { joins: value.joins.map((join) => ({ ...(join.type === "inner" ? {} : { type: join.type }), from: writeRelation(join.from), on: join.on.map((item) => ({ left: item.left, op: "==", right: item.right })), ...(join.hints === undefined ? {} : { hints: { algorithms: [...join.hints.algorithms] } }) })) }; return value.kind === "table" ? { ...(value.schema === undefined ? {} : { schema: value.schema }), name: value.name, ...(value.alias === undefined ? {} : { alias: value.alias }), ...joins } : { query: serializeRecursiveDTQL(value.query ?? shape("relation", "query relation needs query")), ...joins }; }
function writeCondition(value: RecursiveDTQLCondition): Record<string, unknown> { if (value.kind === "exists") return { exists: { query: serializeRecursiveDTQL(value.query) } }; if (value.kind === "not-exists") return { notExists: { query: serializeRecursiveDTQL(value.query) } }; if (value.kind === "and" || value.kind === "or") return { [value.kind]: value.conditions.map(writeCondition) }; const comparison = value as Extract<RecursiveDTQLCondition, { readonly kind: "comparison" }>; return { left: writeExpression(comparison.left), op: comparison.operator === "in" ? "In" : comparison.operator === "not-in" ? "NotIn" : comparison.operator, right: writeExpression(comparison.right) }; }
function writeExpression(value: RecursiveDTQLExpression): Record<string, unknown> { if (value.kind === "query") return { query: serializeRecursiveDTQL(value.query) }; if (value.kind === "field") return { field: value.field.field, ...(value.field.source === "" ? {} : { source: value.field.source }) }; if (value.kind === "literal") return { value: value.value }; if (value.kind === "values") return { values: value.values }; if (value.kind === "star") return { star: true }; if (value.kind === "aggregate") return { aggregate: { function: value.function, args: value.args.map(writeExpression), ...(value.distinct === true ? { distinct: true } : {}) } }; shape("expression", `cannot serialize ${value.kind}`); }
function raw(value: unknown, path: string): Record<string, unknown> { if (typeof value === "string") { const parsed = parseYamlDocument(value, { prettyErrors: false, strict: true, uniqueKeys: true }); if (parsed.errors.length > 0) shape(path, "invalid YAML"); return raw(parsed.toJS(), path); } if (value === null || Array.isArray(value) || typeof value !== "object") shape(path, "must be object"); return { ...(value as Record<string, unknown>) }; }
function list(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) shape(path, "must be array"); return value; }
function requireValue(value: Record<string, unknown>, key: string, path: string): unknown { if (!(key in value)) shape(path, `${key} is required`); return value[key]; }
function text(value: unknown, path: string): string { if (typeof value !== "string" || value.length === 0) shape(path, "must be non-empty string"); return value; }
function fieldReference(value: Record<string, unknown>, path: string): QueryFieldReference { keys(value, new Set(["field", "source"]), path); return { field: text(requireValue(value, "field", path), `${path}.field`), source: value.source === undefined ? "" : text(value.source, `${path}.source`) }; }
function keys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void { for (const key of Object.keys(value)) if (!allowed.has(key)) shape(path, `unsupported key ${key}`); }
function positive(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 10_000) shape(path, "must be positive safe integer at most 10000"); return value; }
function offset(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) shape(path, "must be non-negative safe integer"); return value; }

/** Parsed recursively by dtql.ts; exported here for a single public execution route. */
export type { DTQLSchema };
