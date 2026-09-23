import type {
  QueryFieldReference,
  QueryColumn,
  DTQLQueryFilter,
  DTQLQueryOrder,
  DTQLExpression,
  DTQLHaving,
  QueryFilter,
  QueryJoin,
  QueryJoinAlgorithm,
  QueryJoinPredicate,
  QueryJoinType,
  QueryOperator,
  QueryOrder,
  QueryRelation,
  ParsedDTQLQuery,
  JoinedDTQLQuery,
  StructuredQuery,
} from "./query.js";
import { parseDocument as parseYamlDocument, stringify as stringifyYaml } from "yaml";

/** The allowlisted tables and fields against which a DTQL action is validated. */
export interface DTQLSchema {
  readonly tables: readonly {
    readonly name: string;
    readonly database?: string;
    readonly schema?: string;
    readonly fields: readonly string[];
  }[];
}

type ObjectValue = Record<string, unknown>;

const defaultMaxLimit = 1000;
const rootKeys = new Set(["from", "where", "orderBy", "limit", "offset", "columns", "groupBy", "having"]);
const fromKeys = new Set(["database", "schema", "name", "alias", "as", "scan", "joins"]);
const joinKeys = new Set(["type", "from", "on", "hints"]);
const hintKeys = new Set(["algorithms"]);
const joinAlgorithms = new Set<QueryJoinAlgorithm>(["hash", "merge", "lookup", "batchedLookup", "nestedLoop"]);
const joinPredicateKeys = new Set(["left", "op", "right"]);
const whereKeys = new Set(["op", "left", "right"]);
const fieldKeys = new Set(["field"]);
const qualifiedFieldKeys = new Set(["field", "source"]);
const valueKeys = new Set(["value"]);
const valuesKeys = new Set(["values"]);
const orderKeys = new Set(["field", "source", "desc"]);
const columnKeys = new Set(["field", "source", "as", "wildcard", "aggregate", "binary", "distinct"]);
const aggregateNames = new Set(["count", "sum", "avg", "min", "max", "first", "last"]);
const aggregateKeys = new Set(["function", "distinct", "args"]);
const operators = new Set(["==", "!=", "<", "<=", ">", ">=", "In", "NotIn"]);

/**
 * Parses schema-validated DTQL into either the legacy single-source model or a
 * distinct join-aware model. It does not execute either query.
 */
export function parseDTQL(
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- public API accepts YAML/JSON text and objects
  input: string | unknown,
  schema: DTQLSchema,
  options: { maxLimit?: number } = {},
): ParsedDTQLQuery<Record<string, unknown>> {
  const document = parseDocument(input);
  assertOnlyKeys(document, rootKeys, "DTQL action");

  const rawFrom = requiredObject(document, "from");
  const relation = parseRelation(rawFrom, schema, "from", new WeakSet());
  validateRelationScopes(relation, schema);
  const table = resolveRelationTable(relation, schema);
  const fields = new Set(table.fields);
  const aliases = relationAliases(relation);
  const hasRelationModel = relation.database !== undefined || relation.alias !== undefined || relation.joins.length > 0;
  const requiresQualifiedFields = relation.joins.length > 0;
  const where = document.where === undefined ? undefined : parseWhere(document.where, fields, aliases, requiresQualifiedFields, schema);
  const orders = document.orderBy === undefined ? [] : parseOrders(document.orderBy, fields, aliases, requiresQualifiedFields, schema);
  const columns = document.columns === undefined ? undefined : parseColumns(document.columns, aliases, schema);
  const limit = document.limit === undefined ? undefined : parseLimit(document.limit, options.maxLimit ?? defaultMaxLimit);
  const offset = document.offset === undefined ? undefined : parseOffset(document.offset);
  const groupBy = document.groupBy === undefined ? undefined : parseGroupBy(document.groupBy, aliases, schema);
  const having = document.having === undefined ? undefined : parseHaving(document.having, aliases, schema);
  if (columns !== undefined && !hasRelationModel) fail("columns require an aliased or joined relation model");
  if ((groupBy !== undefined || having !== undefined) && !hasRelationModel) fail("groupBy and having require an aliased or joined relation model");
  if (limit === undefined && !hasRelationModel) fail("limit must be a positive safe integer");

  const query = {
    source: { kind: "collection", name: tableIdentity(table) },
    filters: where === undefined ? [] : [where],
    orders,
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
  if (hasRelationModel) {
    return {
      kind: "joined-dtql" as const,
      from: relation,
      filters: query.filters as readonly DTQLQueryFilter[],
      orders: query.orders as readonly DTQLQueryOrder[],
      ...(columns === undefined ? {} : { columns }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      ...(groupBy === undefined ? {} : { groupBy }),
      ...(having === undefined ? {} : { having }),
    };
  }
  return query as StructuredQuery<Record<string, unknown>>;
}

/** Returns the stable JSON-compatible DTQL representation for a joined query. */
export function serializeJoinedDTQL(query: JoinedDTQLQuery): ObjectValue {
  if (query.filters.length > 1) throw new TypeError("join_plan at where: multiple filters need an explicit DTQL condition group");
  return {
    from: serializeRelation(query.from),
    ...(query.filters.length === 0 ? {} : { where: serializeFilter(firstFilter(query.filters)) }),
    ...(query.orders.length === 0 ? {} : { orderBy: query.orders.map((order) => ({ field: order.field.field, source: order.field.source, ...(order.direction === "desc" ? { desc: true } : {}) })) }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.offset === undefined ? {} : { offset: query.offset }),
    ...(query.columns === undefined ? {} : { columns: query.columns.map(serializeColumn) }),
    ...(query.groupBy === undefined ? {} : { groupBy: query.groupBy.map(serializeExpression) }),
    ...(query.having === undefined ? {} : { having: { left: serializeExpression(query.having.left), op: query.having.operator, right: serializeExpression(query.having.right) } }),
  };
}

/** Serializes a joined query to canonical YAML. JSON callers can stringify the object form. */
export function stringifyJoinedDTQL(query: JoinedDTQLQuery): string {
  return stringifyYaml(serializeJoinedDTQL(query));
}

function serializeRelation(relation: QueryRelation): ObjectValue {
  return {
    ...(relation.database === undefined ? {} : { database: relation.database }),
    ...(relation.scan === undefined ? {} : { scan: { orderBy: relation.scan.orderBy.map((order) => ({ field: order.field, ...(order.direction === "desc" ? { desc: true } : {}) })), limit: relation.scan.limit } }),
    ...(relation.schema === undefined ? {} : { schema: relation.schema }),
    name: relation.name,
    ...(relation.alias === undefined ? {} : { alias: relation.alias }),
    ...(relation.joins.length === 0 ? {} : {
      joins: relation.joins.map((join) => ({
        ...(join.type === "inner" ? {} : { type: join.type }),
        from: serializeRelation(join.from),
        on: join.on.map((predicate) => ({ left: predicate.left, op: "==", right: predicate.right })),
        ...(join.hints === undefined ? {} : { hints: { algorithms: [...join.hints.algorithms] } }),
      })),
    }),
  };
}

function serializeFilter(filter: DTQLQueryFilter): ObjectValue {
  const isMembership = filter.operator === "in" || filter.operator === "not-in";
  return {
    op: filter.operator === "in" ? "In" : filter.operator === "not-in" ? "NotIn" : filter.operator,
    left: { field: filter.field.field, source: filter.field.source },
    right: isMembership ? { values: filter.value } : { value: filter.value },
  };
}

function serializeExpression(expression: DTQLExpression): ObjectValue {
  switch (expression.kind) {
    case "field": return { field: expression.field.field, source: expression.field.source };
    case "literal": return { value: expression.value };
    case "values": return { values: expression.values };
    case "param": return { param: expression.name };
    case "star": return { star: true };
    case "aggregate": return {
      aggregate: { function: expression.function, args: expression.args.map(serializeExpression), ...(expression.distinct === true ? { distinct: true } : {}) },
    };
    case "binary": return { binary: { op: expression.operator, left: serializeExpression(expression.left), right: serializeExpression(expression.right) } };
  }
}

function serializeColumn(column: QueryColumn): ObjectValue {
  if (column.wildcard !== undefined) {
    if (column.expression !== undefined || column.as !== undefined) throw new TypeError("join_plan at columns: wildcard cannot have expression or alias");
    return { wildcard: { ...(column.wildcard.source === undefined ? {} : { source: column.wildcard.source }), exclude: column.wildcard.exclude } };
  }
  if (column.expression === undefined) throw new TypeError("join_plan at columns: expression is required");
  return { ...serializeExpression(column.expression), ...(column.as === undefined ? {} : { as: column.as }) };
}

function firstFilter(filters: readonly DTQLQueryFilter[]): DTQLQueryFilter {
  const filter = filters[0];
  if (filter === undefined) throw new TypeError("join_shape at where: missing filter");
  return filter;
}

function parseDocument(input: unknown): ObjectValue {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      fail("DTQL must not be empty");
    }
    const document = parseYamlDocument(trimmed, { prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length > 0) fail(`invalid DTQL YAML: ${document.errors.map(message).join("; ")}`);
    return object(document.toJS(), "DTQL action");
  }
  return object(input, "DTQL action");
}

function resolveTable(name: string, requestedSchema: string | undefined, requestedDatabase: string | undefined, schema: DTQLSchema, context: string): DTQLSchema["tables"][number] {
  const candidates = schema.tables.filter((table) =>
    table.name === name && (requestedSchema === undefined || table.schema === requestedSchema) &&
    (requestedDatabase === undefined || table.database === undefined || table.database === requestedDatabase),
  );
  if (candidates.length === 0) fail(`join_field at ${context}: unknown table ${requestedSchema === undefined ? name : `${requestedSchema}.${name}`}`);
  if (candidates.length > 1) fail(`join_field at ${context}: ambiguous table ${name}; specify database and schema`);
  const table = candidates[0];
  if (table === undefined) fail(`join_field at ${context}: unknown table ${name}`);
  return table;
}

function resolveRelationTable(relation: QueryRelation, schema: DTQLSchema): DTQLSchema["tables"][number] {
  return resolveTable(relation.name, relation.schema, relation.database, schema, "from");
}

function parseRelation(value: ObjectValue, schema: DTQLSchema, path: string, ancestors: WeakSet<object>): QueryRelation {
  if (ancestors.has(value)) fail(`join_cycle at ${path}`);
  ancestors.add(value);
  try {
    assertOnlyKeys(value, fromKeys, path);
    const name = requiredString(value, "name");
    const database = optionalString(value, "database");
    const relationSchema = optionalString(value, "schema");
    const table = resolveTable(name, relationSchema, database, schema, path);
    const scan = value.scan === undefined ? undefined : parseRelationScan(object(value.scan, `${path}.scan`), table.fields, `${path}.scan`);
    const alias = parseAlias(value, path);
    const joinsValue = value.joins;
    if (joinsValue !== undefined && !Array.isArray(joinsValue)) fail(`join_shape at ${path}.joins: must be an array`);
    const joins = (joinsValue ?? []).map((entry, index) => parseJoin(object(entry, `${path}.joins[${index.toString()}]`), schema, `${path}.joins[${index.toString()}]`, ancestors));
    return { name, ...(database === undefined ? {} : { database }), ...(scan === undefined ? {} : { scan }), ...(relationSchema === undefined ? {} : { schema: relationSchema }), ...(alias === undefined ? {} : { alias }), joins };
  } finally {
    ancestors.delete(value);
  }
}

function parseRelationScan(value: ObjectValue, fields: readonly string[], path: string): NonNullable<QueryRelation["scan"]> {
  assertOnlyKeys(value, new Set(["orderBy", "limit"]), path);
  if (!Array.isArray(value.orderBy) || value.orderBy.length === 0) fail(`join_shape at ${path}.orderBy: a non-empty order is required`);
  const limit = value.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) <= 0 || Number(limit) > 10_000) fail(`join_shape at ${path}.limit: must be between 1 and 10000`);
  const orderBy = value.orderBy.map((item, index) => {
    const term = object(item, `${path}.orderBy[${index.toString()}]`);
    assertOnlyKeys(term, new Set(["field", "desc"]), `${path}.orderBy[${index.toString()}]`);
    const field = requiredString(term, "field");
    if (!fields.includes(field)) fail(`join_field at ${path}.orderBy[${index.toString()}].field: unknown field ${field}`);
    if (term.desc !== undefined && typeof term.desc !== "boolean") fail(`join_shape at ${path}.orderBy[${index.toString()}].desc: must be boolean`);
    return { field, direction: term.desc === true ? "desc" as const : "asc" as const };
  });
  return { orderBy, limit: Number(limit) };
}

function parseAlias(value: ObjectValue, path: string): string | undefined {
  if (value.alias !== undefined && value.as !== undefined) fail(`join_shape at ${path}: alias and as cannot both be set`);
  return optionalString(value, value.alias === undefined ? "as" : "alias");
}

function parseJoin(value: ObjectValue, schema: DTQLSchema, path: string, ancestors: WeakSet<object>): QueryJoin {
  assertOnlyKeys(value, joinKeys, path);
  const type = parseJoinType(value.type, `${path}.type`);
  if (!("from" in value)) fail(`join_shape at ${path}.from: from is required`);
  if (!("on" in value)) fail(`join_shape at ${path}.on: on is required`);
  if (!Array.isArray(value.on) || value.on.length === 0) fail(`join_shape at ${path}.on: must be a non-empty array`);
  const from = parseRelation(object(value.from, `${path}.from`), schema, `${path}.from`, ancestors);
  const on = value.on.map((entry, index) => parseJoinPredicate(object(entry, `${path}.on[${index.toString()}]`), `${path}.on[${index.toString()}]`));
  const hints = parseJoinHints(value.hints, `${path}.hints`);
  return { type, from, on, ...(hints === undefined ? {} : { hints }) };
}

function parseJoinHints(value: unknown, path: string): { readonly algorithms: readonly QueryJoinAlgorithm[] } | undefined {
  if (value === undefined) return undefined;
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`join_algorithm at ${path}.algorithms: hints must be an object`);
  const hints = value as ObjectValue;
  for (const key of Object.keys(hints)) if (!hintKeys.has(key)) fail(`join_algorithm at ${path}.algorithms: unsupported hints key ${key}`);
  if (!Array.isArray(hints.algorithms) || hints.algorithms.length === 0) fail(`join_algorithm at ${path}.algorithms: must be a non-empty array`);
  for (let index = 0; index < hints.algorithms.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(hints.algorithms, index)) fail(`join_algorithm at ${path}.algorithms[${index.toString()}]: algorithm entry is required`);
  }
  const seen = new Set<QueryJoinAlgorithm>();
  const algorithms = hints.algorithms.map((algorithm, index) => {
    const entryPath = `${path}.algorithms[${index.toString()}]`;
    if (typeof algorithm !== "string" || !joinAlgorithms.has(algorithm as QueryJoinAlgorithm)) fail(`join_algorithm at ${entryPath}: unsupported algorithm ${String(algorithm)}`);
    const typed = algorithm as QueryJoinAlgorithm;
    if (seen.has(typed)) fail(`join_algorithm at ${entryPath}: duplicate algorithm ${typed}`);
    seen.add(typed);
    return typed;
  });
  return { algorithms: [...algorithms] };
}

function parseJoinType(value: unknown, path: string): QueryJoinType {
  if (value === undefined) return "inner";
  if (value === "inner" || value === "left") return value;
  if (typeof value === "string") fail(`join_type at ${path}: unsupported join type ${value}`);
  fail(`join_type at ${path}: unsupported join type ${typeof value}`);
}

function parseJoinPredicate(value: ObjectValue, path: string): QueryJoinPredicate {
  assertOnlyKeys(value, joinPredicateKeys, path);
  const operator = requiredString(value, "op");
  if (operator !== "eq" && operator !== "==") fail(`join_operator at ${path}.op: unsupported join operator ${operator}`);
  return {
    left: parseQualifiedField(requiredObject(value, "left"), `${path}.left`),
    operator: "==",
    right: parseQualifiedField(requiredObject(value, "right"), `${path}.right`),
  };
}

function parseQualifiedField(value: ObjectValue, path: string): QueryFieldReference {
  assertOnlyKeys(value, qualifiedFieldKeys, path);
  return { field: requiredString(value, "field"), source: requiredString(value, "source") };
}

function validateRelationScopes(root: QueryRelation, schema: DTQLSchema): void {
  const aliases = new Map<string, { readonly relation: QueryRelation; readonly path: string }>();
  collectAliases(root, "from", aliases);
  validateRelationScope(root, "from", new Map(), aliases, schema);
}

function collectAliases(relation: QueryRelation, path: string, aliases: Map<string, { readonly relation: QueryRelation; readonly path: string }>): void {
  const alias = relation.alias ?? relation.name;
  if (aliases.has(alias)) fail(`join_scope at ${path}.alias: duplicate alias ${alias}`);
  aliases.set(alias, { relation, path });
  relation.joins.forEach((join, index) => {
    collectAliases(join.from, `${path}.joins[${index.toString()}].from`, aliases);
  });
}

function validateRelationScope(
  relation: QueryRelation,
  path: string,
  inherited: ReadonlyMap<string, QueryRelation>,
  allAliases: ReadonlyMap<string, { readonly relation: QueryRelation; readonly path: string }>,
  schema: DTQLSchema,
): Map<string, QueryRelation> {
  const visible = new Map(inherited);
  visible.set(relation.alias ?? relation.name, relation);
  for (const [index, join] of relation.joins.entries()) {
    const joinPath = `${path}.joins[${index.toString()}]`;
    const subtree = relationAliases(join.from);
    for (const [predicateIndex, predicate] of join.on.entries()) {
      validateJoinReference(predicate.left, `${joinPath}.on[${predicateIndex.toString()}].left`, visible, subtree, allAliases, schema);
      validateJoinReference(predicate.right, `${joinPath}.on[${predicateIndex.toString()}].right`, visible, subtree, allAliases, schema);
    }
    const completed = validateRelationScope(join.from, `${joinPath}.from`, visible, allAliases, schema);
    for (const [alias, child] of completed) visible.set(alias, child);
  }
  return visible;
}

function relationAliases(relation: QueryRelation): Map<string, QueryRelation> {
  const aliases = new Map([[relation.alias ?? relation.name, relation]]);
  for (const join of relation.joins) for (const [alias, child] of relationAliases(join.from)) aliases.set(alias, child);
  return aliases;
}

function validateJoinReference(
  reference: QueryFieldReference,
  path: string,
  parentVisible: ReadonlyMap<string, QueryRelation>,
  subtree: ReadonlyMap<string, QueryRelation>,
  allAliases: ReadonlyMap<string, { readonly relation: QueryRelation; readonly path: string }>,
  schema: DTQLSchema,
): void {
  const relation = parentVisible.get(reference.source) ?? subtree.get(reference.source);
  if (relation === undefined) {
    const reason = allAliases.has(reference.source) ? "forward alias" : "unknown alias";
    fail(`join_scope at ${path}.source: ${reason} ${reference.source}`);
  }
  const table = resolveTable(relation.name, relation.schema, relation.database, schema, path);
  if (!table.fields.includes(reference.field)) fail(`join_field at ${path}: unknown field ${reference.source}.${reference.field}`);
}

function parseWhere(
  value: unknown,
  fields: ReadonlySet<string>,
  aliases: ReadonlyMap<string, QueryRelation>,
  joined: boolean,
  schema: DTQLSchema,
): QueryFilter<Record<string, unknown>> | DTQLQueryFilter {
  const where = object(value, "where");
  assertOnlyKeys(where, whereKeys, "where");
  const operator = requiredString(where, "op");
  if (!operators.has(operator)) fail(`unsupported where operator ${operator}`);
  const field = parseScopedField(requiredObject(where, "left"), fields, aliases, joined, "where.left", schema);
  const right = requiredObject(where, "right");
  if (operator === "In" || operator === "NotIn") {
    assertOnlyKeys(right, valuesKeys, "where.right");
    if (!Array.isArray(right.values) || (operator === "In" && right.values.length === 0) || !right.values.every(isPortableScalar)) {
      fail(operator === "In"
        ? "where In values must be a non-empty array of portable scalars"
        : "where NotIn values must be an array of portable scalars");
    }
    return typeof field === "string"
      ? { field, operator: toQueryOperator(operator), value: right.values }
      : { field, operator: toQueryOperator(operator), value: right.values };
  }
  assertOnlyKeys(right, valueKeys, "where.right");
  if (!("value" in right) || !isPortableScalar(right.value)) fail("where.right.value must be a portable scalar");
  const queryOperator = toQueryOperator(operator);
  return typeof field === "string"
    ? { field, operator: queryOperator, value: right.value }
    : { field, operator: queryOperator, value: right.value };
}

function isPortableScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function toQueryOperator(operator: string): QueryOperator {
  switch (operator) {
    case "In": return "in";
    case "NotIn": return "not-in";
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": return operator;
    default: fail(`unsupported where operator ${operator}`);
  }
}

function parseOrders(
  value: unknown,
  fields: ReadonlySet<string>,
  aliases: ReadonlyMap<string, QueryRelation>,
  joined: boolean,
  schema: DTQLSchema,
): readonly (QueryOrder<Record<string, unknown>> | DTQLQueryOrder)[] {
  if (!Array.isArray(value)) fail("orderBy must be an array");
  return value.map((entry, index) => {
    const location = `orderBy[${index.toString()}]`;
    const order = object(entry, location);
    assertOnlyKeys(order, orderKeys, location);
    const field = parseScopedField(
      order.source === undefined ? { field: order.field } : { field: order.field, source: order.source },
      fields,
      aliases,
      joined,
      location,
      schema,
    );
    if (order.desc !== undefined && typeof order.desc !== "boolean") fail(`${location}.desc must be boolean`);
    const direction = order.desc === true ? "desc" : "asc";
    return typeof field === "string" ? { field, direction } : { field, direction };
  });
}

function parseColumns(value: unknown, aliases: ReadonlyMap<string, QueryRelation>, schema: DTQLSchema): readonly QueryColumn[] {
  if (!Array.isArray(value) || value.length === 0) fail("columns must be a non-empty array");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const path = `columns[${index.toString()}]`;
    const column = object(entry, path);
    assertOnlyKeys(column, columnKeys, path);
    const as = optionalString(column, "as");
    if (as !== undefined && names.has(as)) fail(`join_shape at ${path}.as: duplicate output key ${as}`);
    if (as !== undefined) names.add(as);
    if (column.wildcard !== undefined) {
      if (as !== undefined) fail(`join_shape at ${path}.as: wildcard cannot have alias`);
      const wildcard = object(column.wildcard, `${path}.wildcard`);
      assertOnlyKeys(wildcard, new Set(["source", "exclude"]), `${path}.wildcard`);
      const source = optionalString(wildcard, "source");
      if (!Array.isArray(wildcard.exclude) || wildcard.exclude.length === 0 || !wildcard.exclude.every((field) => typeof field === "string" && field.length > 0)) fail(`join_shape at ${path}.wildcard.exclude: must be a non-empty string array`);
      return { wildcard: { ...(source === undefined ? {} : { source }), exclude: wildcard.exclude as string[] } };
    }
    return { expression: parseColumnExpression(column, path, aliases, schema), ...(as === undefined ? {} : { as }) };
  });
}

function parseColumnExpression(value: ObjectValue, path: string, aliases: ReadonlyMap<string, QueryRelation>, schema: DTQLSchema): DTQLExpression {
  const aggregate = value.aggregate;
  if (aggregate === undefined) return parseExpression(value, path, aliases, schema);
  const encoded = object(aggregate, `${path}.aggregate`);
  assertOnlyKeys(encoded, aggregateKeys, `${path}.aggregate`);
  const functionName = requiredString(encoded, "function");
  if (!aggregateNames.has(functionName)) fail(`join_shape at ${path}.aggregate.function: unsupported aggregate`);
  if (encoded.distinct !== undefined && typeof encoded.distinct !== "boolean") fail(`join_shape at ${path}.aggregate.distinct: must be boolean`);
  if (!Array.isArray(encoded.args) || encoded.args.length === 0) fail(`join_shape at ${path}.aggregate.args: must be a non-empty array`);
  return {
    kind: "aggregate",
    function: functionName as "count" | "sum" | "avg" | "min" | "max" | "first" | "last",
    args: encoded.args.map((argument, index) => parseExpression(object(argument, `${path}.aggregate.args[${index.toString()}]`), `${path}.aggregate.args[${index.toString()}]`, aliases, schema)),
    ...(encoded.distinct === true ? { distinct: true } : {}),
  };
}

function parseExpression(value: ObjectValue, path: string, aliases: ReadonlyMap<string, QueryRelation>, schema: DTQLSchema): DTQLExpression {
  const forms = ["field", "value", "values", "param", "star", "aggregate", "binary"].filter((key) => Object.hasOwn(value, key));
  if (forms.length !== 1) fail(`join_shape at ${path}: expression must set exactly one form`);
  if (value.star === true) return { kind: "star" };
  if (value.value !== undefined || Object.hasOwn(value, "value")) {
    if (!isPortableScalar(value.value)) fail(`${path}.value must be a portable scalar`);
    return { kind: "literal", value: value.value };
  }
  if (value.values !== undefined) {
    if (!Array.isArray(value.values) || !value.values.every(isPortableScalar)) fail(`${path}.values must be an array of portable scalars`);
    return { kind: "values", values: value.values };
  }
  if (value.param !== undefined) return { kind: "param", name: requiredString(value, "param") };
  if (value.aggregate !== undefined) return parseColumnExpression({ ...value, as: "_" }, path, aliases, schema);
  if (value.binary !== undefined) {
    const binary = object(value.binary, `${path}.binary`);
    assertOnlyKeys(binary, new Set(["op", "left", "right"]), `${path}.binary`);
    const operator = requiredString(binary, "op");
    if (operator !== "+" && operator !== "-" && operator !== "*" && operator !== "/") fail(`join_shape at ${path}.binary.op: unsupported operator`);
    return {
      kind: "binary",
      operator,
      left: parseExpression(requiredObject(binary, "left"), `${path}.binary.left`, aliases, schema),
      right: parseExpression(requiredObject(binary, "right"), `${path}.binary.right`, aliases, schema),
    };
  }
  return { kind: "field", field: parseKnownQualifiedField(value, path, aliases, schema) };
}

function parseGroupBy(value: unknown, aliases: ReadonlyMap<string, QueryRelation>, schema: DTQLSchema): readonly DTQLExpression[] {
  if (!Array.isArray(value) || value.length === 0) fail("groupBy must be a non-empty array");
  return value.map((entry, index) => ({ kind: "field", field: parseKnownQualifiedField(object(entry, `groupBy[${index.toString()}]`), `groupBy[${index.toString()}]`, aliases, schema) }));
}

function parseHaving(value: unknown, aliases: ReadonlyMap<string, QueryRelation>, schema: DTQLSchema): DTQLHaving {
  const having = object(value, "having");
  assertOnlyKeys(having, whereKeys, "having");
  const operator = requiredString(having, "op");
  if (!operators.has(operator) || operator === "In" || operator === "NotIn") fail(`unsupported having operator ${operator}`);
  return {
    left: parseHavingExpression(requiredObject(having, "left"), "having.left", aliases, schema),
    operator: toQueryOperator(operator),
    right: parseHavingExpression(requiredObject(having, "right"), "having.right", aliases, schema),
  };
}

function parseHavingExpression(value: ObjectValue, path: string, aliases: ReadonlyMap<string, QueryRelation>, schema: DTQLSchema): DTQLExpression {
  if ("value" in value) {
    assertOnlyKeys(value, valueKeys, path);
    if (!isPortableScalar(value.value)) fail(`${path}.value must be a portable scalar`);
    return { kind: "literal", value: value.value };
  }
  if ("aggregate" in value) return parseColumnExpression({ ...value, as: "_" }, path, aliases, schema);
  return { kind: "field", field: parseKnownQualifiedField(value, path, aliases, schema) };
}

function parseScopedField(
  value: ObjectValue,
  baseFields: ReadonlySet<string>,
  aliases: ReadonlyMap<string, QueryRelation>,
  joined: boolean,
  path: string,
  schema: DTQLSchema,
): string | QueryFieldReference {
  const field = requiredString(value, "field");
  const source = optionalString(value, "source");
  if (source === undefined) {
    assertOnlyKeys(value, fieldKeys, path);
    if (joined) return resolveUniqueField(field, aliases, schema, path);
    if (!baseFields.has(field)) fail(`unknown field ${field}`);
    return field;
  }
  assertOnlyKeys(value, qualifiedFieldKeys, path);
  const relation = aliases.get(source);
  if (relation === undefined) fail(`join_field at ${path}.source: unknown alias ${source}`);
  const table = resolveTable(relation.name, relation.schema, relation.database, schema, path);
  if (!table.fields.includes(field)) fail(`join_field at ${path}: unknown field ${source}.${field}`);
  return { field, source };
}

function parseKnownQualifiedField(
  value: ObjectValue,
  path: string,
  aliases: ReadonlyMap<string, QueryRelation>,
  schema: DTQLSchema,
): QueryFieldReference {
  assertOnlyKeys(value, columnKeys, path);
  const field = requiredString(value, "field");
  const source = optionalString(value, "source");
  if (source === undefined) return resolveUniqueField(field, aliases, schema, path);
  const reference = { field, source };
  const relation = aliases.get(reference.source);
  if (relation === undefined) fail(`join_field at ${path}.source: unknown alias ${reference.source}`);
  const table = resolveTable(relation.name, relation.schema, relation.database, schema, path);
  if (!table.fields.includes(reference.field)) fail(`join_field at ${path}: unknown field ${reference.source}.${reference.field}`);
  return reference;
}

function resolveUniqueField(
  field: string,
  aliases: ReadonlyMap<string, QueryRelation>,
  schema: DTQLSchema,
  path: string,
): QueryFieldReference {
  const matches = [...aliases.entries()].filter(([, relation]) =>
    resolveTable(relation.name, relation.schema, relation.database, schema, path).fields.includes(field),
  );
  if (matches.length === 0) fail(`join_field at ${path}: unknown field ${field}`);
  if (matches.length !== 1) fail(`join_field at ${path}: ambiguous field ${field}; specify source`);
  const [source] = matches[0] ?? [];
  if (source === undefined) fail(`join_field at ${path}: unknown field ${field}`);
  return { field, source };
}

function parseLimit(value: unknown, maxLimit: number): number {
  if (!Number.isSafeInteger(maxLimit) || maxLimit <= 0) throw new RangeError("maxLimit must be a positive safe integer");
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail("limit must be a positive safe integer");
  const limit = value as number;
  if (limit > maxLimit) fail(`limit must not exceed ${maxLimit.toString()}`);
  return limit;
}

function parseOffset(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("offset must be a non-negative safe integer");
  return value as number;
}

function tableIdentity(table: DTQLSchema["tables"][number]): string {
  return table.schema === undefined ? table.name : `${table.schema}.${table.name}`;
}

function assertOnlyKeys(value: ObjectValue, allowed: ReadonlySet<string>, context: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`unsupported ${context} key ${key}`);
}

function object(value: unknown, context: string): ObjectValue {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${context} must be an object`);
  return value as ObjectValue;
}

function requiredObject(value: ObjectValue, key: string): ObjectValue {
  if (!(key in value)) fail(`${key} is required`);
  return object(value[key], key);
}

function requiredString(value: ObjectValue, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) fail(`${key} must be a non-empty string`);
  return result;
}

function optionalString(value: ObjectValue, key: string): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.length === 0) fail(`${key} must be a non-empty string`);
  return result;
}

function fail(messageText: string): never {
  throw new TypeError(messageText);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
