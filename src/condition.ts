import type { DTQLComparison, DTQLCondition, DTQLConditionGroup, DTQLExpression, DTQLNullTest, DTQLQueryFilter, QueryOperator } from "./query.js";

/** A condition that is neither an `and`/`or` group: a comparison or a null test. */
export type DTQLLeaf = DTQLComparison | DTQLNullTest;

/** True for the `In` and `NotIn` membership operators. */
export function isMembership(operator: QueryOperator): boolean {
  return operator === "in" || operator === "not-in";
}

/** True when the condition is an `and`/`or` group rather than one comparison. */
export function isConditionGroup(condition: DTQLCondition): condition is DTQLConditionGroup {
  return "kind" in condition && (condition.kind === "and" || condition.kind === "or");
}

/** True for an `isNull` / `isNotNull` condition. */
export function isNullTest(condition: DTQLCondition): condition is DTQLNullTest {
  return "kind" in condition && (condition.kind === "is-null" || condition.kind === "is-not-null");
}

/** The expressions a leaf condition reads, each with the key that locates it in an error path. */
export function leafOperands(leaf: DTQLLeaf): readonly (readonly [string, DTQLExpression])[] {
  return "operand" in leaf ? [["operand", leaf.operand]] : [["left", leaf.left], ["right", leaf.right]];
}

/**
 * A null test as Go decides it: never unknown. `value` is what the operand
 * evaluated to; an undefined (missing) value counts as null.
 */
export function nullTestTruth(test: DTQLNullTest, value: unknown): Truth {
  return ((value === null || value === undefined) === (test.kind === "is-null")) ? "true" : "false";
}

/** Rewrites the compact field-versus-literal filter as the general comparison it stands for. */
export function toCondition(filter: DTQLQueryFilter | DTQLCondition): DTQLCondition {
  if (!("field" in filter)) return filter;
  const value = filter.value as string | number | boolean | null;
  return {
    left: { kind: "field", field: filter.field },
    operator: filter.operator,
    right: isMembership(filter.operator) && Array.isArray(filter.value)
      ? { kind: "values", values: filter.value as readonly (string | number | boolean | null)[] }
      : { kind: "literal", value },
  };
}

/**
 * Visits every leaf (comparison or null test) of a condition, depth first, with
 * the path that locates it (`where`, `having.and[1]`, ...), the way Go's
 * executor reports it.
 */
export function walkLeaves(condition: DTQLCondition, path: string, visit: (leaf: DTQLLeaf, path: string) => void): void {
  if (!isConditionGroup(condition)) {
    visit(condition, path);
    return;
  }
  condition.conditions.forEach((child, index) => { walkLeaves(child, `${path}.${condition.kind}[${index.toString()}]`, visit); });
}

/** Visits every expression a condition reads, with its path (`where.left`, `having.and[0].operand`, ...). */
export function walkConditionExpressions(condition: DTQLCondition, path: string, visit: (expression: DTQLExpression, path: string) => void): void {
  walkLeaves(condition, path, (leaf, leafPath) => { for (const [key, expression] of leafOperands(leaf)) visit(expression, `${leafPath}.${key}`); });
}

/**
 * Evaluates a condition tree with the Go executor's short-circuit order: an
 * `and` stops at the first false child, an `or` at the first true one, and a
 * leaf is only evaluated when it is reached (so an error in a later leaf is
 * raised only if the earlier ones did not decide the group). An unknown
 * (null-affected) comparison neither stops a group nor satisfies it; a null
 * test is never unknown.
 */
export type Truth = "true" | "false" | "unknown";

export function evaluateCondition(condition: DTQLCondition, leaf: (leaf: DTQLLeaf, path: string) => Truth, path: string): Truth {
  if (!isConditionGroup(condition)) return leaf(condition, path);
  const stopOn: Truth = condition.kind === "or" ? "true" : "false";
  let unknown = false;
  for (const [index, child] of condition.conditions.entries()) {
    const truth = evaluateCondition(child, leaf, `${path}.${condition.kind}[${index.toString()}]`);
    if (truth === stopOn) return truth;
    if (truth === "unknown") unknown = true;
  }
  if (unknown) return "unknown";
  return condition.kind === "or" ? "false" : "true";
}
