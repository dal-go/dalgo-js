import type {
  QueryFieldReference,
  QueryColumn,
  DTQLQueryFilter,
  DTQLQueryOrder,
  QueryFilter,
  QueryJoin,
  QueryJoinPredicate,
  QueryJoinType,
  QueryOperator,
  QueryOrder,
  QueryRelation,
  ParsedDTQLQuery,
  StructuredQuery,
} from "./query.js";
import { parseDocument as parseYamlDocument } from "yaml";

/** The allowlisted tables and fields against which a DTQL action is validated. */
export interface DTQLSchema {
  readonly tables: readonly {
    readonly name: string;
    readonly schema?: string;
    readonly fields: readonly string[];
  }[];
}

type ObjectValue = Record<string, unknown>;

const defaultMaxLimit = 1000;
const rootKeys = new Set(["from", "where", "orderBy", "limit", "columns"]);
const fromKeys = new Set(["schema", "name", "alias", "as", "joins"]);
const joinKeys = new Set(["type", "from", "on"]);
const joinPredicateKeys = new Set(["left", "op", "right"]);
const whereKeys = new Set(["op", "left", "right"]);
const fieldKeys = new Set(["field"]);
const qualifiedFieldKeys = new Set(["field", "source"]);
const valueKeys = new Set(["value"]);
const valuesKeys = new Set(["values"]);
const orderKeys = new Set(["field", "source", "desc"]);
const columnKeys = new Set(["field", "source", "as"]);
const operators = new Set(["==", "!=", "<", "<=", ">", ">=", "In"]);

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
  const hasRelationModel = relation.alias !== undefined || relation.joins.length > 0;
  const requiresQualifiedFields = relation.joins.length > 0;
  const where = document.where === undefined ? undefined : parseWhere(document.where, fields, aliases, requiresQualifiedFields, schema);
  const orders = document.orderBy === undefined ? [] : parseOrders(document.orderBy, fields, aliases, requiresQualifiedFields, schema);
  const columns = document.columns === undefined ? undefined : parseColumns(document.columns, aliases, schema);
  const limit = parseLimit(document.limit, options.maxLimit ?? defaultMaxLimit);
  if (columns !== undefined && !hasRelationModel) fail("columns require an aliased or joined relation model");

  const query = {
    source: { kind: "collection", name: tableIdentity(table) },
    filters: where === undefined ? [] : [where],
    orders,
    limit,
  };
  if (hasRelationModel) {
    return {
      kind: "joined-dtql" as const,
      from: relation,
      filters: query.filters as readonly DTQLQueryFilter[],
      orders: query.orders as readonly DTQLQueryOrder[],
      ...(columns === undefined ? {} : { columns }),
      limit,
    };
  }
  return query as StructuredQuery<Record<string, unknown>>;
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

function resolveTable(name: string, requestedSchema: string | undefined, schema: DTQLSchema, context: string): DTQLSchema["tables"][number] {
  const candidates = schema.tables.filter((table) =>
    table.name === name && (requestedSchema === undefined || table.schema === requestedSchema),
  );
  if (candidates.length === 0) fail(`join_field at ${context}: unknown table ${requestedSchema === undefined ? name : `${requestedSchema}.${name}`}`);
  if (candidates.length > 1) fail(`join_field at ${context}: ambiguous table ${name}; specify schema`);
  const table = candidates[0];
  if (table === undefined) fail(`join_field at ${context}: unknown table ${name}`);
  return table;
}

function resolveRelationTable(relation: QueryRelation, schema: DTQLSchema): DTQLSchema["tables"][number] {
  return resolveTable(relation.name, relation.schema, schema, "from");
}

function parseRelation(value: ObjectValue, schema: DTQLSchema, path: string, ancestors: WeakSet<object>): QueryRelation {
  if (ancestors.has(value)) fail(`join_cycle at ${path}`);
  ancestors.add(value);
  try {
    assertOnlyKeys(value, fromKeys, path);
    const name = requiredString(value, "name");
    const relationSchema = optionalString(value, "schema");
    resolveTable(name, relationSchema, schema, path);
    const alias = parseAlias(value, path);
    const joinsValue = value.joins;
    if (joinsValue !== undefined && !Array.isArray(joinsValue)) fail(`join_shape at ${path}.joins: must be an array`);
    const joins = (joinsValue ?? []).map((entry, index) => parseJoin(object(entry, `${path}.joins[${index.toString()}]`), schema, `${path}.joins[${index.toString()}]`, ancestors));
    return { name, ...(relationSchema === undefined ? {} : { schema: relationSchema }), ...(alias === undefined ? {} : { alias }), joins };
  } finally {
    ancestors.delete(value);
  }
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
  return { type, from, on };
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
      const leftInSubtree = subtree.has(predicate.left.source);
      const rightInSubtree = subtree.has(predicate.right.source);
      const leftInParent = visible.has(predicate.left.source);
      const rightInParent = visible.has(predicate.right.source);
      if (!((leftInSubtree && rightInParent) || (rightInSubtree && leftInParent))) {
        fail(`join_scope at ${joinPath}.on[${predicateIndex.toString()}]: each predicate must connect the joined subtree to the parent scope`);
      }
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
    const category = allAliases.has(reference.source) ? "join_scope" : "join_field";
    fail(`${category} at ${path}: ${allAliases.has(reference.source) ? `forward alias ${reference.source}` : `unknown alias ${reference.source}`}`);
  }
  const table = resolveTable(relation.name, relation.schema, schema, path);
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
  if (operator === "In") {
    assertOnlyKeys(right, valuesKeys, "where.right");
    if (!Array.isArray(right.values) || right.values.length === 0 || !right.values.every(isPortableScalar)) {
      fail("where In values must be a non-empty array of portable scalars");
    }
    return typeof field === "string"
      ? { field, operator: "in", value: right.values }
      : { field, operator: "in", value: right.values };
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
    const field = parseKnownQualifiedField(column, path, aliases, schema);
    const as = requiredString(column, "as");
    if (names.has(as)) fail(`join_shape at ${path}.as: duplicate output key ${as}`);
    names.add(as);
    return { expression: { kind: "field", field }, as };
  });
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
    if (joined) fail(`join_field at ${path}: source is required for joined fields`);
    if (!baseFields.has(field)) fail(`unknown field ${field}`);
    return field;
  }
  assertOnlyKeys(value, qualifiedFieldKeys, path);
  const relation = aliases.get(source);
  if (relation === undefined) fail(`join_field at ${path}.source: unknown alias ${source}`);
  const table = resolveTable(relation.name, relation.schema, schema, path);
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
  const reference = { field: requiredString(value, "field"), source: requiredString(value, "source") };
  const relation = aliases.get(reference.source);
  if (relation === undefined) fail(`join_field at ${path}.source: unknown alias ${reference.source}`);
  const table = resolveTable(relation.name, relation.schema, schema, path);
  if (!table.fields.includes(reference.field)) fail(`join_field at ${path}: unknown field ${reference.source}.${reference.field}`);
  return reference;
}

function parseLimit(value: unknown, maxLimit: number): number {
  if (!Number.isSafeInteger(maxLimit) || maxLimit <= 0) throw new RangeError("maxLimit must be a positive safe integer");
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail("limit must be a positive safe integer");
  const limit = value as number;
  if (limit > maxLimit) fail(`limit must not exceed ${maxLimit.toString()}`);
  return limit;
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
