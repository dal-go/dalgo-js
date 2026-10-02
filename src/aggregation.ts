import { walkConditionExpressions } from "./condition.js";
import type { DTQLCondition, DTQLExpression, DTQLQueryOrder, QueryColumn } from "./query.js";

/** True when the expression is, or contains, an aggregate call. */
export function containsAggregate(expression: DTQLExpression): boolean {
  return expression.kind === "aggregate" || (expression.kind === "binary" && (containsAggregate(expression.left) || containsAggregate(expression.right)));
}

/** True when the expression is, or contains, a `DISTINCT` aggregate call. */
export function containsDistinctAggregate(expression: DTQLExpression): boolean {
  if (expression.kind === "aggregate") return expression.distinct === true || expression.args.some(containsDistinctAggregate);
  return expression.kind === "binary" && (containsDistinctAggregate(expression.left) || containsDistinctAggregate(expression.right));
}

/** The pieces of a query that decide whether it has aggregate semantics. */
export interface AggregationParts {
  readonly groupBy?: readonly DTQLExpression[] | undefined;
  readonly columns?: readonly QueryColumn[] | undefined;
  readonly having?: DTQLCondition | undefined;
  readonly orders: readonly DTQLQueryOrder[];
}

/**
 * Whether a query enters aggregate semantics, including an implicit single
 * group when there is no GROUP BY. This is the Go engine's `HasAggregation`: a
 * GROUP BY or HAVING alone is enough, as is an aggregate in any column or key.
 */
export function hasAggregation(parts: AggregationParts): boolean {
  return (parts.groupBy?.length ?? 0) > 0 || parts.having !== undefined ||
    (parts.columns ?? []).some((column) => column.expression !== undefined && containsAggregate(column.expression)) ||
    parts.orders.some((order) => order.expression !== undefined && containsAggregate(order.expression));
}

/** Whether any aggregate in the query uses `DISTINCT`. */
export function hasDistinctAggregate(parts: AggregationParts): boolean {
  return (parts.columns ?? []).some((column) => column.expression !== undefined && containsDistinctAggregate(column.expression)) ||
    parts.orders.some((order) => order.expression !== undefined && containsDistinctAggregate(order.expression)) ||
    (parts.having !== undefined && conditionHasDistinctAggregate(parts.having));
}

function conditionHasDistinctAggregate(condition: DTQLCondition): boolean {
  let found = false;
  walkConditionExpressions(condition, "having", (expression) => {
    if (containsDistinctAggregate(expression)) found = true;
  });
  return found;
}

/**
 * The projection of an aggregate query. Without `columns` a grouped query
 * returns its group keys (an ungrouped one returns an empty row), exactly as
 * the Go engine does, rather than the first row of every group.
 */
export function effectiveColumns(parts: AggregationParts): readonly QueryColumn[] | undefined {
  if (parts.columns !== undefined) return parts.columns;
  if (!hasAggregation(parts)) return undefined;
  return (parts.groupBy ?? []).map((expression) => ({ expression }));
}

/** How Go renders a literal inside an expression's text: strings quoted with doubled quotes, other values as JSON. */
export function constantText(value: unknown): string {
  return typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : JSON.stringify(value);
}

/** How Go renders a field: `source.name`, with a name that is not a plain word in brackets. */
export function fieldText(source: string | undefined, field: string): string {
  const name = /^\w+$/.test(field) ? field : `[${field}]`;
  return source === undefined ? name : `${source}.${name}`;
}

/**
 * The text Go gives an expression (`COUNT(*)`, `SUM(s.qty)`, `(a / b)`), which is
 * also the output name of an aggregate column that has no `as`.
 */
export function expressionText(expression: DTQLExpression): string {
  switch (expression.kind) {
    case "field": return fieldText(expression.field.source, expression.field.field);
    case "literal": return constantText(expression.value);
    case "values": return `(${expression.values.map(constantText).join(", ")})`;
    case "param": return `$${expression.name}`;
    case "star": return "*";
    case "aggregate": return `${expression.function.toUpperCase()}(${expression.distinct === true ? "DISTINCT " : ""}${expression.args.map(expressionText).join(", ")})`;
    case "binary": return `(${expressionText(expression.left)} ${expression.operator} ${expressionText(expression.right)})`;
  }
}

/** A stable structural identity, equal exactly when two expressions are the same. */
export function expressionIdentity(expression: DTQLExpression): string {
  switch (expression.kind) {
    case "field": return `${expression.field.source}.${expression.field.field}`;
    case "literal": return JSON.stringify(expression.value);
    case "values": return `(${expression.values.map((value) => JSON.stringify(value)).join(",")})`;
    case "param": return `$${expression.name}`;
    case "star": return "*";
    case "aggregate": return `${expression.function.toUpperCase()}(${expression.distinct === true ? "DISTINCT " : ""}${expression.args.map(expressionIdentity).join(", ")})`;
    case "binary": return `(${expressionIdentity(expression.left)} ${expression.operator} ${expressionIdentity(expression.right)})`;
  }
}

/**
 * The SQL-compatible grouping rules of the Go engine's `ValidateAggregation`,
 * applied to a parsed query so a rejected query fails at parse time. Aliases
 * have already been replaced by the column they name.
 */
export function validateAggregation(parts: AggregationParts): void {
  if (!hasAggregation(parts)) return;
  const groupKeys = new Set<string>();
  (parts.groupBy ?? []).forEach((expression, index) => {
    const location = `groupBy[${index.toString()}]`;
    if (containsAggregate(expression)) reject(location, "a GROUP BY expression must not contain an aggregate");
    validateScalar(expression, location);
    groupKeys.add(expressionIdentity(expression));
  });
  (effectiveColumns(parts) ?? []).forEach((column, index) => {
    const location = `columns[${index.toString()}]`;
    if (column.wildcard !== undefined) reject(location, "a wildcard cannot be selected from an aggregate query");
    const expression = column.expression;
    if (expression === undefined) reject(location, "a column needs an expression");
    if (containsAggregate(expression)) validateGrouped(expression, groupKeys, location);
    else if (!groupKeys.has(expressionIdentity(expression))) reject(location, `${expressionIdentity(expression)} is neither aggregated nor present in GROUP BY`);
  });
  if (parts.having !== undefined) {
    walkConditionExpressions(parts.having, "having", (expression, path) => { validateGrouped(expression, groupKeys, path); });
  }
  parts.orders.forEach((order, index) => {
    const location = `orderBy[${index.toString()}]`;
    if (order.expression !== undefined) validateGrouped(order.expression, groupKeys, location);
    else if (!groupKeys.has(expressionIdentity({ kind: "field", field: order.field }))) {
      reject(location, `${expressionIdentity({ kind: "field", field: order.field })} is neither an aggregate, SELECT alias, nor GROUP BY expression`);
    }
  });
}

function validateGrouped(expression: DTQLExpression, groupKeys: ReadonlySet<string>, location: string): void {
  switch (expression.kind) {
    case "aggregate": validateAggregate(expression, location); return;
    case "binary":
      validateGrouped(expression.left, groupKeys, `${location}.binary.left`);
      validateGrouped(expression.right, groupKeys, `${location}.binary.right`);
      return;
    case "literal": return;
    default:
      if (!groupKeys.has(expressionIdentity(expression))) reject(location, `${expressionIdentity(expression)} is neither an aggregate, SELECT alias, nor GROUP BY expression`);
  }
}

function validateAggregate(expression: Extract<DTQLExpression, { readonly kind: "aggregate" }>, location: string): void {
  const name = expression.function.toUpperCase();
  const [argument] = expression.args;
  if (expression.args.length !== 1 || argument === undefined) reject(location, `${name} requires exactly one argument`);
  const star = argument.kind === "star";
  const distinct = expression.distinct === true;
  switch (expression.function) {
    case "count":
      if (star && distinct) reject(location, "COUNT(DISTINCT *) is not supported");
      break;
    case "sum":
    case "avg":
      if (star) reject(location, `${name}(*) is not supported`);
      break;
    case "min":
    case "max":
    case "first":
    case "last":
      if (distinct) reject(location, `DISTINCT is not supported for ${name}`);
      if (star) reject(location, `${name}(*) is not supported`);
      break;
  }
  if (star) return;
  if (containsAggregate(argument)) reject(location, "nested aggregates are not supported");
  validateScalar(argument, `${location}.aggregate.args[0]`);
}

function validateScalar(expression: DTQLExpression, location: string): void {
  switch (expression.kind) {
    case "field":
    case "literal":
    case "param":
      return;
    case "binary":
      validateScalar(expression.left, `${location}.binary.left`);
      validateScalar(expression.right, `${location}.binary.right`);
      return;
    default:
      reject(location, `an aggregate argument or GROUP BY expression cannot be ${expression.kind === "values" ? "a values list" : expression.kind}`);
  }
}

function reject(location: string, reason: string): never {
  throw new TypeError(`join_aggregate at ${location}: ${reason}`);
}
