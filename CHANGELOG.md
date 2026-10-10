# @dalgo/core

## 0.7.2

### Patch Changes

- 0adfd60: Require explicit parenthesized blocks for multiline TugQL `SELECT` lists while preserving compact same-line projections.

## 0.7.1

### Patch Changes

- 62ee8eb: Reject out-of-order TugQL clauses, including HAVING before GROUP BY or after ORDER BY.

## 0.7.0

### Minor Changes

- e755633: Add versioned TugQL parsing, formatting, and schema-authorized resolution APIs while preserving the existing recursive query execution model.

## 0.6.0

### Minor Changes

- 3fc880b: Add an opt-in JS-local materialized join route with bounded, separately admitted leaf metadata and versioned source composition. Preserve unknown rights and evidence for empty results, and refuse compositions in legacy joins, recursive execution, live GET validation and generic enrichment.

## 0.5.0

### Minor Changes

- cd6fab3: Add optional providerReads v1 metadata transport and a strict plan-aware consumer
  gate for bounded live provider observations. Preserve legacy omission and refuse
  unplanned or conflicting evidence before output. This does not enable producers
  or source activation.

## 0.4.0

### Minor Changes

- e2dd9ab: Add optional table/view source data rights metadata and query page source rights inventories. Lookup pages preserve captured metadata; generic joins and recursive execution explicitly refuse annotated inputs until they support rights preflight. Providers may continue omitting metadata.

## 0.3.0

### Minor Changes

- ee6a7c5: Bring the in-browser DTQL engine to parity with the Go engine for conditions, ordering and aggregation, proven by a checked-in Go-vs-TypeScript parity suite (`test/parity`, 301 cases whose expectations are generated from dalgo v0.88.2 by `tools/parity/regenerate.sh`). The README's "Differences from Go" lists what still differs.
  
  New: `where` and `having` take Go's condition grammar, so a comparison may have a literal or an expression on either side (a field against a field, arithmetic, a `values` list) and conditions nest in `and` / `or` groups (in the generic and the `scanPages` plans alike); `orderBy` accepts expression keys (for example a binary `/` over aggregates, with `desc`) alongside field keys; a column's `as` alias can be used as an `orderBy` key and as a `having` operand, also inside arithmetic; `having` accepts any expression; an unaliased aggregate column is named by its text as in Go (`COUNT(*)`, `SUM(s.qty)`); `null` counts as absent for `where`, `having`, `orderBy`, `groupBy`, `columns`, `limit`, `offset`, `desc`, `distinct` and a column's `as`, an empty `groupBy` or `columns` is absent, and `limit: 0` means no limit; aggregate queries are validated at parse like Go's `ValidateAggregation` (non-grouped field or expression, nested aggregates, `sum(*)`, `DISTINCT` on `min`/`max`/`first`/`last`, a plain column beside an aggregate-only key all fail with a located `join_aggregate at orderBy[0]: ...` error); an unknown property on an order key (`descending`, `direction`, `as`, `source` without `field`), a `star` or a `param` key is rejected at parse instead of being ignored, and unknown properties inside any expression are too; an aggregate query without `columns` returns its group keys (an ungrouped one returns one empty row) instead of the first row of each group; DISTINCT aggregates over a flat join run through the generic plan under `scanPages` instead of failing. Fixed: the streaming (`scanPages`) plan sorted field keys by the projected column name, so a renamed or omitted column left rows unsorted; it also leaked an internal `sortKeys` field on results without an `ORDER BY`, and returned no row for an aggregate over zero rows without a `groupBy`.
  
  Types: `DTQLQueryOrder` is now the union `DTQLFieldOrder | DTQLExpressionOrder` (narrow on `order.expression`); `JoinedDTQLQuery.filters` holds `DTQLQueryFilter | DTQLCondition` (a top-level field-versus-literal `where` keeps the `DTQLQueryFilter` shape, every other condition is a `DTQLComparison` or a `DTQLConditionGroup`); `JoinedDTQLQuery.having` is a `DTQLCondition` (`DTQLHaving` is now an alias of `DTQLComparison`). Code that reads `filter.field` or `query.having.operator` must narrow. Several hand-built `filters` now serialise as one `and` group instead of throwing.
  
  Behaviour changes, all to match Go: a WHERE comparison with a null operand is unknown, so `x == null` and `In` with a null item match nothing and `NotIn` over a list containing null matches nothing (null used to equal null); an empty `In` list is accepted and matches nothing; a null and a missing field are one group key (they were two); `sum` and `avg` fail with `SUM numeric overflow` when the running total leaves the finite range (they returned `Infinity`); arithmetic on a null or non-numeric operand, and division by zero, evaluate to null (division by zero was `Infinity`, text operands threw), and an overflow is an error only where it reaches a result; mixed-type values order as booleans, then numbers, then strings (it was strings, numbers, booleans); `sum` over a group with no numeric values is null (it was 0) and `sum`/`avg` ignore non-numeric values (they threw); `first`/`last` keep a null value; `where` and `having` comparisons `<`, `<=`, `>`, `>=` are false when either side is null (null used to sort below everything and so satisfied `< x`); every aggregate of a query is accumulated over every group, so an overflow is not hidden by `having` or `limit`; an unqualified field on an aliased single source now resolves to that source instead of being left as a bare string; `In` and `NotIn` in `having` parse and fail when a group is evaluated, as in Go, instead of failing at parse. Queries that Go rejects for an invalid aggregate shape (for example a plain column that is not in `groupBy`) now also fail in `parseDTQL`. `!=` stays a package extension and treats null as a value.
- fe9cb53: Add DTQL `NotIn` filters with empty-set and SQL NULL semantics in generic joined execution.
- 1534acd: Add explicit null tests to DTQL, as in the Go engine (`dal.IsNullCondition`): `isNull: <expression>` and `isNotNull: <expression>` conditions, valid in `where`, in `having`, inside `and` / `or` groups and, for `parseRecursiveDTQL`, in nested queries. A comparison with null is unknown in a joined, aggregated or nested query (`x == null` and `In` with a null item match nothing), so until now there was no way to select or exclude nulls once a query was joined; a null test is never unknown and a field missing from a document counts as null. Both executor plans evaluate them (generic and `scanPages` streaming), an aggregate may be the operand in `having`, and they serialise losslessly to YAML and JSON. They are rejected at parse in a join's `on` list. A bare single-source query accepts them too, so one spelling serves a parent query and its derived join, but it then parses to the relation model (`joined-dtql`) because the legacy `StructuredQuery` filter cannot carry a null test. The operand is a field, a literal, arithmetic or a scalar subquery: `values`, `star`, `param` and (in `where`) an aggregate are rejected at parse, as in Go. Comparison semantics are unchanged and no `not` is added. Parity: 71 new cases (`test/parity/cases/19-null-tests.json` and `20-null-adversarial.json`, 372 in all) whose expectations are generated by the Go engine from dalgo commit `d019eea35efa77095236e30350dc771d29af2b06` (the open dal-go/dalgo pull request that adds `IsNullCondition`; `tools/parity/regenerate.sh <tag>` repins `test/parity/expected.json` to the released dalgo tag once that lands). `tools/parity/regenerate.sh` now takes the dalgo ref as an argument.
  
  Types: `DTQLCondition` is now `DTQLComparison | DTQLConditionGroup | DTQLNullTest` (new `DTQLNullTest`, `{ kind: "is-null" | "is-not-null"; operand: DTQLExpression }`), and `RecursiveDTQLCondition` gains the same two kinds. Code that told a group from a comparison with `"kind" in condition` must check `kind === "and" || kind === "or"` and narrow on `"operand" in condition` for a null test.
