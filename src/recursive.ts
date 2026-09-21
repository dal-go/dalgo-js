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
}

const defaults = { maxFetchedRows: 10_000, maxResultRows: 10_000, maxCandidateEvaluations: 100_000, maxRetainedBytes: 16 * 1024 * 1024 };

/** Parses the additive recursive wire model. Legacy parseDTQL stays unchanged. */
export function parseRecursiveDTQL(input: unknown, schema: DTQLSchema): RecursiveDTQLQuery {
  const root = raw(input, "root");
  return parseQuery(root, schema, "root");
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
  const budget: Budget = {
    fetched: 0, results: 0, candidates: 0, retained: 0,
    maxFetchedRows: options.maxFetchedRows ?? defaults.maxFetchedRows,
    maxResultRows: options.maxResultRows ?? defaults.maxResultRows,
    maxCandidateEvaluations: options.maxCandidateEvaluations ?? defaults.maxCandidateEvaluations,
    maxRetainedBytes: options.maxRetainedBytes ?? defaults.maxRetainedBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  for (const key of ["maxFetchedRows", "maxResultRows", "maxCandidateEvaluations", "maxRetainedBytes"] as const) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0) throw new TypeError(`query_limit at root: ${key} must be a positive safe integer`);
  }
  validateProgram(query, new WeakSet(), "root");
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
  if (query.orderBy !== undefined) rows = [...rows].sort((a, b) => compareEnvironment(a, b, query.orderBy ?? []));
  const output = await projectRows(executor, query, rows, budget, options, path);
  const start = query.offset ?? 0;
  const sliced = output.slice(start, query.limit === undefined ? undefined : start + query.limit);
  chargeResults(budget, sliced.length, path);
  return sliced;
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
        if (join.on.every((predicate) => equal(field(candidate, predicate.left), field(candidate, predicate.right)))) {
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

async function projectRows(executor: QueryExecutor, query: RecursiveDTQLQuery, rows: readonly Environment[], budget: Budget, options: RecursiveQueryExecutionOptions, path: string): Promise<Data[]> {
  if (query.columns === undefined) return rows.map((row) => merge(row));
  const aggregates = query.columns.some((column) => containsAggregate(column.expression));
  const groups = new Map<string, Environment[]>();
  if (aggregates || query.groupBy !== undefined) {
    if (rows.length === 0 && aggregates && query.groupBy === undefined) groups.set("all", []);
    for (const row of rows) {
      const group = query.groupBy === undefined ? "all" : JSON.stringify(query.groupBy.map((item) => legacyExpression(item, row)));
      const current = groups.get(group) ?? []; current.push(row); groups.set(group, current);
    }
  } else for (const row of rows) groups.set(groups.size.toString(), [row]);
  const result: Data[] = [];
  for (const group of groups.values()) {
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

async function condition(executor: QueryExecutor, value: RecursiveDTQLCondition, row: Environment, budget: Budget, options: RecursiveQueryExecutionOptions, path: string): Promise<Truth> {
  if (value.kind === "and" || value.kind === "or") {
    let unknown = false;
    for (const [index, child] of value.conditions.entries()) {
      const current = await condition(executor, child, row, budget, options, `${path}.${value.kind}[${index.toString()}]`);
      if (value.kind === "and" && current === false) return false;
      if (value.kind === "or" && current === true) return true;
      unknown ||= current === undefined;
    }
    return unknown ? undefined : value.kind === "and";
  }
  if (value.kind === "exists" || value.kind === "not-exists") {
    const rows = await evaluateQuery(executor, value.query, row, budget, options, `${path}.query`);
    return value.kind === "exists" ? rows.length > 0 : rows.length === 0;
  }
  const comparison = value as Extract<RecursiveDTQLCondition, { readonly kind: "comparison" }>;
  const left = await expression(executor, comparison.left, row, budget, options, `${path}.left`);
  if (comparison.operator === "in" || comparison.operator === "not-in") {
    const right = comparison.right.kind === "query"
      ? (await evaluateQuery(executor, comparison.right.query, row, budget, options, `${path}.right.query`)).map((item) => { const values = Object.values(item); if (values.length !== 1) shape(`${path}.right.query`, "IN query requires one column"); return values[0]; })
      : await expression(executor, comparison.right, row, budget, options, `${path}.right`);
    return membership(left, Array.isArray(right) ? right : [], comparison.operator === "not-in");
  }
  const right = await expression(executor, comparison.right, row, budget, options, `${path}.right`);
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
    const rows = await evaluateQuery(executor, value.query, row, budget, options, `${path}.query`);
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
    case "aggregate": { const arg = value.args[0]; if (arg === undefined) return null; const values = arg.kind === "star" ? group.map(() => 1) : group.map((item) => legacyExpression(arg, item, [item])).filter((item) => item !== null && item !== undefined); if (value.function === "count") return values.length; if (value.function === "sum") return values.reduce<number>((sum, item) => sum + (typeof item === "number" ? item : 0), 0); if (value.function === "avg") return values.length === 0 ? null : values.reduce<number>((sum, item) => sum + (typeof item === "number" ? item : 0), 0) / values.length; return null; }
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

function field(row: Environment, reference: QueryFieldReference): unknown { return row.get(reference.source)?.data[reference.field]; }
function merge(row: Environment): Data { const value: Data = {}; for (const record of row.values()) if (record !== undefined) Object.assign(value, record.data); return value; }
function fieldOutput(column: RecursiveDTQLColumn, path: string): string { if (column.expression.kind === "field") return column.expression.field.field; if (column.expression.kind === "aggregate") return column.expression.function; return shape(path, "non-field column requires as"); }
function equal(left: unknown, right: unknown): boolean { return typeof left === "number" && typeof right === "number" ? Number.isFinite(left) && Number.isFinite(right) && left === right : left === right; }
function compare(left: unknown, right: unknown): number { return left === right ? 0 : left === null || left === undefined ? -1 : right === null || right === undefined ? 1 : left < right ? -1 : 1; }
function compareEnvironment(left: Environment, right: Environment, orders: readonly { readonly field: QueryFieldReference; readonly direction: "asc" | "desc" }[]): number { for (const order of orders) { const result = compare(field(left, order.field), field(right, order.field)); if (result !== 0) return order.direction === "desc" ? -result : result; } return 0; }
function chargeResults(budget: Budget, count: number, path: string): void { budget.results += count; if (budget.results > budget.maxResultRows) limit(path, "result_rows"); }
function chargeBytes(budget: Budget, value: unknown, path: string): void { budget.retained += new TextEncoder().encode(JSON.stringify(value)).byteLength; if (budget.retained > budget.maxRetainedBytes) limit(path, "retained_bytes"); }
function cancelled(budget: Budget, path: string): void { if (budget.signal?.aborted === true) throw budget.signal.reason ?? new DOMException(`query cancelled at ${path}`, "AbortError"); }
function shape(path: string, reason: string): never { throw new TypeError(`query_shape at ${path}: ${reason}`); }
function limit(path: string, counter: string): never { throw new RangeError(`query_limit at ${path}: ${counter}`); }

function validateProgram(query: RecursiveDTQLQuery, ancestors: WeakSet<object>, path: string): void {
  if (ancestors.has(query)) shape(path, "recursive query cycle");
  ancestors.add(query);
  try { validateRelationProgram(query.from, ancestors, `${path}.from`); } finally { ancestors.delete(query); }
}

function validateRelationProgram(relation: RecursiveDTQLRelation, ancestors: WeakSet<object>, path: string): void {
  if (ancestors.has(relation)) shape(path, "recursive relation cycle");
  ancestors.add(relation);
  try {
    if (relation.kind === "query") validateProgram(relation.query ?? shape(path, "query relation needs query"), ancestors, `${path}.query`);
    relation.joins.forEach((join, index) => { validateRelationProgram(join.from, ancestors, `${path}.joins[${index.toString()}].from`); });
  } finally { ancestors.delete(relation); }
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
function writeExpression(value: RecursiveDTQLExpression): Record<string, unknown> { if (value.kind === "query") return { query: serializeRecursiveDTQL(value.query) }; if (value.kind === "field") return { field: value.field.field, source: value.field.source }; if (value.kind === "literal") return { value: value.value }; if (value.kind === "values") return { values: value.values }; if (value.kind === "star") return { star: true }; if (value.kind === "aggregate") return { aggregate: { function: value.function, args: value.args.map(writeExpression), ...(value.distinct === true ? { distinct: true } : {}) } }; shape("expression", `cannot serialize ${value.kind}`); }
function raw(value: unknown, path: string): Record<string, unknown> { if (typeof value === "string") { const parsed = parseYamlDocument(value, { prettyErrors: false, strict: true, uniqueKeys: true }); if (parsed.errors.length > 0) shape(path, "invalid YAML"); return raw(parsed.toJS(), path); } if (value === null || Array.isArray(value) || typeof value !== "object") shape(path, "must be object"); return { ...(value as Record<string, unknown>) }; }
function list(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) shape(path, "must be array"); return value; }
function requireValue(value: Record<string, unknown>, key: string, path: string): unknown { if (!(key in value)) shape(path, `${key} is required`); return value[key]; }
function text(value: unknown, path: string): string { if (typeof value !== "string" || value.length === 0) shape(path, "must be non-empty string"); return value; }
function fieldReference(value: Record<string, unknown>, path: string): QueryFieldReference { keys(value, new Set(["field", "source"]), path); return { field: text(requireValue(value, "field", path), `${path}.field`), source: text(requireValue(value, "source", path), `${path}.source`) }; }
function keys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void { for (const key of Object.keys(value)) if (!allowed.has(key)) shape(path, `unsupported key ${key}`); }
function positive(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 10_000) shape(path, "must be positive safe integer at most 10000"); return value; }
function offset(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) shape(path, "must be non-negative safe integer"); return value; }

/** Parsed recursively by dtql.ts; exported here for a single public execution route. */
export type { DTQLSchema };
