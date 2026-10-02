import type { DTQLComparison, DTQLCondition, DTQLConditionGroup, DTQLQueryFilter, QueryOperator } from "./query.js";

/** True for the `In` and `NotIn` membership operators. */
export function isMembership(operator: QueryOperator): boolean {
  return operator === "in" || operator === "not-in";
}

/** True when the condition is an `and`/`or` group rather than one comparison. */
export function isConditionGroup(condition: DTQLCondition): condition is DTQLConditionGroup {
  return "kind" in condition;
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
 * Visits every comparison of a condition, depth first, with the path that
 * locates it (`where`, `having.and[1]`, ...), the way Go's executor reports it.
 */
export function walkComparisons(condition: DTQLCondition, path: string, visit: (comparison: DTQLComparison, path: string) => void): void {
  if (!isConditionGroup(condition)) {
    visit(condition, path);
    return;
  }
  condition.conditions.forEach((child, index) => { walkComparisons(child, `${path}.${condition.kind}[${index.toString()}]`, visit); });
}

/**
 * Evaluates a condition tree with the Go executor's short-circuit order: an
 * `and` stops at the first false child, an `or` at the first true one, and a
 * leaf is only evaluated when it is reached (so an error in a later leaf is
 * raised only if the earlier ones did not decide the group). An unknown
 * (null-affected) leaf neither stops a group nor satisfies it.
 */
export type Truth = "true" | "false" | "unknown";

export function evaluateCondition(condition: DTQLCondition, leaf: (comparison: DTQLComparison, path: string) => Truth, path: string): Truth {
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
