import type { QueryFilter, QueryOperator, QueryOrder, StructuredQuery } from "./query.js";
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
const rootKeys = new Set(["from", "where", "orderBy", "limit"]);
const fromKeys = new Set(["schema", "name"]);
const whereKeys = new Set(["op", "left", "right"]);
const fieldKeys = new Set(["field"]);
const valueKeys = new Set(["value"]);
const valuesKeys = new Set(["values"]);
const orderKeys = new Set(["field", "desc"]);
const operators = new Set(["==", "!=", "<", "<=", ">", ">=", "In"]);

/**
 * Parses the deliberately small Phase 1 DTQL action format into DALgo's existing
 * structured query model. It does not execute the query.
 */
export function parseDTQL(
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- public API accepts YAML/JSON text and objects
  input: string | unknown,
  schema: DTQLSchema,
  options: { maxLimit?: number } = {},
): StructuredQuery<Record<string, unknown>> {
  const document = parseDocument(input);
  assertOnlyKeys(document, rootKeys, "DTQL action");

  const table = resolveTable(requiredObject(document, "from"), schema);
  const fields = new Set(table.fields);
  const where = document.where === undefined ? undefined : parseWhere(document.where, fields);
  const orders = document.orderBy === undefined ? [] : parseOrders(document.orderBy, fields);
  const limit = parseLimit(document.limit, options.maxLimit ?? defaultMaxLimit);

  return {
    source: { kind: "collection", name: tableIdentity(table) },
    filters: where === undefined ? [] : [where],
    orders,
    limit,
  };
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

function resolveTable(from: ObjectValue, schema: DTQLSchema): DTQLSchema["tables"][number] {
  assertOnlyKeys(from, fromKeys, "from");
  const name = requiredString(from, "name");
  const requestedSchema = optionalString(from, "schema");
  const candidates = schema.tables.filter((table) =>
    table.name === name && (requestedSchema === undefined || table.schema === requestedSchema),
  );
  if (candidates.length === 0) fail(`unknown table ${requestedSchema === undefined ? name : `${requestedSchema}.${name}`}`);
  if (candidates.length > 1) fail(`ambiguous table ${name}; specify schema`);
  const table = candidates[0];
  if (table === undefined) fail(`unknown table ${name}`);
  return table;
}

function parseWhere(value: unknown, fields: ReadonlySet<string>): QueryFilter<Record<string, unknown>> {
  const where = object(value, "where");
  assertOnlyKeys(where, whereKeys, "where");
  const operator = requiredString(where, "op");
  if (!operators.has(operator)) fail(`unsupported where operator ${operator}`);
  const field = parseField(requiredObject(where, "left"), fields, "where.left");
  const right = requiredObject(where, "right");
  if (operator === "In") {
    assertOnlyKeys(right, valuesKeys, "where.right");
    if (!Array.isArray(right.values) || right.values.length === 0 || !right.values.every(isPortableScalar)) {
      fail("where In values must be a non-empty array of portable scalars");
    }
    return { field, operator: "in", value: right.values };
  }
  assertOnlyKeys(right, valueKeys, "where.right");
  if (!("value" in right) || !isPortableScalar(right.value)) fail("where.right.value must be a portable scalar");
  return { field, operator: toQueryOperator(operator), value: right.value };
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

function parseOrders(value: unknown, fields: ReadonlySet<string>): readonly QueryOrder<Record<string, unknown>>[] {
  if (!Array.isArray(value)) fail("orderBy must be an array");
  return value.map((entry, index) => {
    const location = `orderBy[${index.toString()}]`;
    const order = object(entry, location);
    assertOnlyKeys(order, orderKeys, location);
    const field = requiredString(order, "field");
    if (!fields.has(field)) fail(`unknown field ${field}`);
    if (order.desc !== undefined && typeof order.desc !== "boolean") fail(`${location}.desc must be boolean`);
    return { field, direction: order.desc === true ? "desc" : "asc" };
  });
}

function parseField(value: ObjectValue, fields: ReadonlySet<string>, context: string): string {
  assertOnlyKeys(value, fieldKeys, context);
  const field = requiredString(value, "field");
  if (!fields.has(field)) fail(`unknown field ${field}`);
  return field;
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
