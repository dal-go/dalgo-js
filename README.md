# DALgo for TypeScript

`@dalgo/core` is the browser-neutral TypeScript implementation of
[DALgo](https://dalgo.io/). It provides hierarchical keys, typed collections,
structured queries, records, database sessions, and transaction-only mutation
contracts without coupling application code to a database SDK.

The first adapter is the
[Firestore adapter](https://github.com/dal-go/dalgo-http-adapters/tree/main/packages/firestore),
which uses Firebase's modular Web SDK and therefore works directly in browsers.
The adapters are being migrated to the `@dalgo/*` scope separately; the
`@dalgo/core` package does not connect to a database by itself.

## Install

Install the published core package:

```sh
pnpm add @dalgo/core
```

For source development before or after publication, use the
[`dalgo-js` repository](https://github.com/dal-go/dalgo-js). Do not mix this
package with an adapter still importing `@dal-go/dalgo`: that would install
two different DALgo core module identities.

## Build a browser query

```ts
import { collection, key } from "@dalgo/core";

interface Item {
  title: string;
  done: boolean;
  rank: number;
}

const spaceKey = key("spaces", spaceId);
const items = collection<Item>("items").in(spaceKey);

const query = items.query()
  .where("done", "==", false)
  .orderBy("rank")
  .limit(25)
  .build();

// Pass query to an adapter updated for @dalgo/core.
```

Subcollections use DALgo's ordinary parent-key model:

```ts
import { collection, key } from "@dalgo/core";

const spaceKey = key("spaces", spaceId);
const items = collection<Item>("items").in(spaceKey);
```

Collection-group queries are explicit:

```ts
import { collectionGroup } from "@dalgo/core";

const query = collectionGroup<Item>("items")
  .where("done", "==", false)
  .limit(25)
  .build();
```

## Recursive DTQL joins

`parseDTQL` returns a distinct `JoinedDTQLQuery` for an aliased relation or a
relation tree. Execute it through `executeJoinedDTQLQuery`, passing the same
`DTQLSchema` used to parse the text when columns contain a source-qualified
wildcard. The executor expands wildcard fields in that schema's declared
order.

```ts
const parsed = parseDTQL(dtqlText, schema);
if (isJoinedDTQLQuery(parsed)) {
  const page = await executeJoinedDTQLQuery(adapter, parsed, { schema });
}
```

The generic executor scans each relation through `QueryExecutor.query` once;
it does not pass a joined query into an existing adapter. A relation with no
`schema` scans its collection name directly. A schema-qualified relation needs
an explicit `resolveSource` callback, which must preserve the complete
`schema` and `name` identity understood by that adapter:

```ts
await executeJoinedDTQLQuery(adapter, parsed, {
  schema,
  resolveSource: (relation) => ({
    kind: "collection",
    name: `${relation.schema}.${relation.name}`,
  }),
});
```

Each JOIN may carry an ordered `hints.algorithms` list. The case-sensitive
identifiers are `hash`, `merge`, `lookup`, `batchedLookup`, and `nestedLoop`.
The generic executor honors `hash` when its equality index applies and
`nestedLoop` when explicitly preferred; it skips the other three until they
are implemented. Hints never affect logical results or ordering. `nestedLoop`
deliberately evaluates bounded candidate pairs and can fail with `join_plan` at
the configured candidate limit.

A saved DTQL query may set `money: {minorUnitScale: 2, divisionScale: 4,
rounding: halfEven}` for the streaming aggregate plan. Amount inputs are
decimal strings or safe whole integers. `SUM` uses integer minor units, and
`SUM`, `AVG`, and per-capita division emit decimal strings. Excess fractional
digits, unsafe numbers, and zero divisors fail explicitly. Flat joined-row
streams accept `pageSize: 100` in `executeJoinedDTQLQueryPages` to yield a
visible-row page before requesting more source pages; the default is 500.

`@dalgo/core` currently ships no `QueryExecutor` adapter. Its in-repository
memory executor is tested with generic unqualified scans and with the explicit
schema mapping above. The local adapter inventory is:

| Adapter checkout or package | Imports current `@dalgo/core` and exposes `QueryExecutor.query` | Recursive JOIN coverage |
| --- | --- | --- |
| This package's memory test executor | Yes | Generic executor tests cover it. |
| `dalgo-http-adapters/packages/firestore` | Yes | No JOIN integration test or resolver. |
| `dalgo-http-adapters/packages/indexeddb` | Yes | No JOIN integration test or resolver. |
| Sibling `dalgo2firestore-js` and `dalgo2indexeddb-js` | No, both import legacy `@dal-go/dalgo` | No current-core JOIN support. |
| Sibling `dalgo2firebase-rtdb-js` | No package source is present in the local checkout | No current-core JOIN support. |
| `dalgo-http-adapters/packages/firebase-rtdb` and the remaining HTTP packages | No, they import legacy `@dal-go/dalgo` | No current-core JOIN support. |

The current-core Firestore and IndexedDB packages need adapter-owned resolver
and integration tests before they can claim generic JOIN support. Legacy and
untested adapters do not gain native or generic JOIN support from this package.
Their separate dependency pins make an adapter integration test inappropriate
in this repository; each adapter migration needs its own test. Without
`resolveSource`, a schema-qualified query fails with `join_plan` before any
output is returned.

## DTQL conditions, order keys, aliases and aggregates

A joined DTQL query follows the Go engine (`github.com/dal-go/dalgo`, `dtql`) for
conditions, ordering and aggregation. `test/parity/` proves it case by case (see
[Go parity suite](#go-parity-suite)); [Differences from Go](#differences-from-go) lists
every place the two still disagree.

**Conditions.** `where` and `having` take one condition: a comparison, or an `and` /
`or` group of conditions that nests to any depth. A comparison is `op`, `left` and
`right`, with an expression on each side (`field`, `value`, `values`, `binary`; in
`having` also aggregates), so a literal may stand on the left, two fields may be
compared, and either side may be arithmetic. A condition sets one form only, and a group
holds at least one condition.

```yaml
where:
  and:
    - {op: ==, left: {field: LastName, source: c}, right: {value: Lovelace}}
    - or:
        - {op: ==, left: {field: Name, source: ar}, right: {value: Miles Davis}}
        - {op: '>', left: {field: Total, source: i}, right: {binary: {op: '*', left: {field: Units, source: i}, right: {value: 2}}}}
```

A WHERE comparison with a null operand is *unknown*, and only a true condition keeps a
row: `x == null` never holds, `In` never matches a null, and `NotIn` over a list that
contains null never holds (over an empty list it always does). An `and` stops at its
first false child and an `or` at its first true one; an unknown child decides neither,
and a child that fails (`In` against something that is not a list, an aggregate or a
parameter in WHERE) fails the query only when a row reaches it. In HAVING, `==` is true
for two nulls and `<`, `<=`, `>`, `>=` are false when either side is null; `In` and
`NotIn` parse but fail when a group is evaluated.

**Null tests.** `isNull` and `isNotNull` take one expression and are true when it is,
respectively is not, null. They are the way to select or exclude nulls in a joined or
aggregated query, where `x == null` matches nothing, and they are the same documents Go
accepts (`dal.IsNullCondition`). They are valid wherever a condition is (`where`,
`having`, inside `and` / `or`, and in a nested query of `parseRecursiveDTQL`), never
unknown, and a field missing from a document counts as null; they are not valid in a
join's `on` list. The operand is a field, a literal, arithmetic over those (or, in
`parseRecursiveDTQL`, a scalar subquery); an aggregate is valid only in `having`, and
`values`, `star` and `param` are rejected at parse (`query_shape at where.isNull: ...`),
as Go rejects them.

A bare single source (no `alias`, `database` or `joins`) accepts a null test too, so one
spelling serves a parent query and the join derived from it, but it then parses to the
relation model (`kind: "joined-dtql"`, run with `executeJoinedDTQLQuery`), because the
legacy `StructuredQuery` filter (`field`, `operator`, `value`) has no way to carry one: a
legacy `QueryExecutor` such as the IndexedDB adapter would drop an unknown filter or
silently match no row. A bare query without a null test is still the legacy model.
`where: {field: x, op: ==, value: null}` on the legacy model keeps its adapter's meaning
(the IndexedDB adapter matches `null`, not a missing field), which is why a consumer that
joins such a parent must rewrite `== null` to `isNull` and `!= null` to `isNotNull` itself.

```yaml
where:
  and:
    - isNull: {field: Company, source: c}          # no company, or the field is absent
    - isNotNull: {field: InvoiceId, source: i}      # ...and it has an invoice
having:
  isNotNull: {aggregate: {function: max, args: [{field: Total, source: i}]}}
```

In code a null test parses to `DTQLNullTest` (`{ kind: "is-null" | "is-not-null", operand }`),
a member of the `DTQLCondition` union. Code that narrows a `DTQLCondition` by
`"kind" in condition` to find an `and` / `or` group must now check `kind === "and" || kind === "or"`.
`RecursiveDTQLCondition` gains the same `is-null` / `is-not-null` kinds.

The parsed query keeps the compact `DTQLQueryFilter` (`field`, `operator`, `value`) for a
top-level field-versus-literal `where`, as before, and uses `DTQLComparison` and
`DTQLConditionGroup` for every other shape; `having` is a `DTQLCondition`. Several
hand-built `filters` hold together and serialise as one `and` group.

**Order keys.** An `orderBy` item is either a field key (`field`, optional
`source`, optional `desc`) or an *expression key*: any DTQL expression
(`aggregate`, `binary`, `value`, `values`) plus an optional `desc`. Expression
keys are evaluated per group in an aggregate query and per row otherwise; null
sorts first ascending and last descending, and equal keys keep their input order.

```yaml
groupBy: [{field: alias, source: a}, {field: population, source: p}]
orderBy:
  - binary: {op: '/', left: {aggregate: {function: sum, args: [{field: Total, source: i}]}}, right: {field: population, source: p}}
    desc: true
  - {field: alias, source: a}
```

An unknown property on a key (`descending: true`, `direction: desc`, `as: x`,
`source` without `field`) is rejected at parse with its position, as is a `star`
or `param` key, instead of being ignored. `DTQLQueryOrder` is the union
`DTQLFieldOrder | DTQLExpressionOrder`: narrow on `order.expression`.

**Aliases.** A field with no `source` that names a column's `as` alias refers to that
column, as an `orderBy` key or a `having` operand, also inside arithmetic
(`orderBy: [{binary: {op: '-', left: {value: 0}, right: {field: purchases}}}]`) but not
inside an aggregate's argument, which reads the input row. The alias is resolved at parse
time to the expression it names, so the parsed query and its canonical serialisation carry
that expression. An alias never takes a `source`, and the default name of an unaliased
aggregate is not an alias.

**Column names.** A column without `as` is named by its field. An aggregate without `as`
is named by its text, as in Go: `COUNT(*)`, `SUM(s.qty)`, `COUNT(DISTINCT customer)`,
fields spelled as the document wrote them (the parser records that name as `as` when it
had to add a source). Any other column without `as` is rejected, and so is a duplicate name.

**Aggregate queries** (any `groupBy`, `having`, or aggregate in a column or key)
are validated at parse like Go's `ValidateAggregation`: every column and every
ORDER BY or HAVING operand must be an aggregate, a literal, or a `groupBy`
expression; aggregates take exactly one argument, cannot nest, and `DISTINCT`
is not allowed for `min`, `max`, `first`, `last`; `sum(*)` and `count(distinct *)`
are rejected; a wildcard cannot be selected. Without `columns` a grouped query
returns its group keys, and an ungrouped aggregate query returns one empty row.
HAVING accepts any expression (for example a `binary` ratio), not just a field or
an aggregate. Every aggregate of the query is accumulated over every group, so an
error in one (an overflow) is raised even when HAVING or `limit` would hide that group.
A group key treats a missing field and a null as the same value.

**Null and empty.** As in Go, `null` counts as absent for `where`, `having`, `orderBy`,
`groupBy`, `columns`, `limit`, `offset`, `money`, an order key's `desc`, an aggregate's
`distinct` and a column's `as`; an empty `groupBy` or `columns` is absent; `limit: 0` means no limit.

**Values.** These follow Go and changed in this release:

- Arithmetic is null for a null or non-numeric operand and for division by zero
  (it was `Infinity`, or an error for text). An overflow stays infinite in a comparison or
  a sort key and is an error where it would reach a result: a column, an aggregate's
  state, a group key, or the order key of an aggregate query.
- `sum` and `avg` fail with `SUM numeric overflow` (`AVG numeric overflow`) as soon as the
  running total leaves the finite range, even if later values would bring it back.
- Mixed-type comparison orders booleans, then numbers, then strings (null first; a
  missing field is null).
- `sum` and `avg` ignore non-numeric values; `sum` over no numbers is null (it was
  0). `first` and `last` keep a null value.
- A flat aggregate join streams through `scanPages` for every aggregate query
  (an aggregate that appears only in an order key included) except one that uses
  `DISTINCT`, which runs through the generic plan. `and` and `or` groups stream too.

### Differences from Go

What remains, each pinned by a test (`test/differences.test.ts`):

1. **`!=`.** `where` and `having` also accept `!=`; DTQL in Go has none. Here null is a
   value for it: `x != null` means "x is not null", `null != "a"` is true, `null != null`
   is false. Prefer `isNotNull` for that meaning: Go has it too.
2. **`groupBy` takes fields only.** Go accepts any scalar expression there.
3. **Schema-resolved fields.** `parseDTQL` takes a schema. A field without `source`
   resolves through it when exactly one relation has the field (ambiguity is an error),
   where Go requires a `source` in a join and reads an unqualified field of a single
   source as written. This includes a SELECT alias used as an `orderBy` key or `having`
   operand on a *joined* query, which Go rejects (`unqualified JOIN field requires schema
   metadata`), and on a single non-aggregate source, which Go hands to the provider. A
   field the schema does not list is rejected at parse, where Go would read null.
4. **Strings** compare by UTF-16 code unit, Go by UTF-8 byte; the two orders differ only
   for characters outside the Basic Multilingual Plane against U+E000 to U+FFFF.
5. **Subqueries are not supported** by the joined executor: `from.query`, a `query`
   expression, `exists` and `notExists` are rejected at parse. Go's join executor runs
   them; here `parseRecursiveDTQL` is the separate model for them.
6. **A bare single source** (no `alias`, `database` or `joins`) parses to the legacy
   `StructuredQuery`: its `where` is one field-versus-literal comparison (no groups or
   expressions), it has no `columns`, `groupBy`, `having` or expression keys, and it
   requires a positive `limit`. The one exception is a null test (`isNull` /
   `isNotNull`, alone or inside a group), which parses it to the relation model; Go has
   no such split. Go accepts the same document, but its single-source execution is the
   adapter's: only `dalgo2memory` evaluates a null test there, and every other Go adapter
   rejects the query ("unsupported condition") until it implements it.
7. **Bounds are this package's own.** `limit` above `maxLimit` (1000 unless the option
   says otherwise) is rejected at parse, and execution is bounded by `maxFetchedRows`,
   `maxResultRows`, `maxCandidateEvaluations` and `maxRetainedBytes`.
8. **Execution route.** Go passes a query with no join, aggregate or subquery straight
   to the database; this package always evaluates in memory, with the rules above.
9. **Null tests.** (a) `isNull` on a field the schema does not list is rejected at parse
   here; Go, when the executor has no field metadata, cannot tell it from a field the
   records lack and matches every row (`isNotNull` none). (b) An unqualified null-test
   operand in a join resolves through the schema (see 3); Go requires a `source`.
   (c) A `null` element of an `and` / `or` list is rejected here (`where.and[1] must be
   an object`); Go's YAML decoder drops it and runs the rest of the group. (d) A null
   test on a bare single source parses to the relation model (see 6).

### Go parity suite

`test/parity/cases/*.json` are queries, `test/parity/dataset.json` the in-memory tables,
and `test/parity/expected.json` the rows (or the error) that the Go engine returned for
each case, with the dalgo version and commit it ran at. `test/parity.test.ts` runs every case
through this package, generically and through `scanPages`, and compares exactly (numbers
within 1e-9); a case Go rejects at parse must be rejected by `parseDTQL`. CI needs no Go.
A case has to run through Go's own executor, so it uses a join or an aggregate: Go hands
a plain single-source query to the provider, and the harness's in-memory provider does
not filter.

To add a case, append it to a file in `test/parity/cases/` and run
`tools/parity/regenerate.sh` (Go and network access to the module proxy; see
`tools/parity/README.md`), then `pnpm test`. A difference is a regression in one of the
two engines, or a Go change to port. To move the reference to another dalgo revision give
the script the ref, `tools/parity/regenerate.sh v0.89.0` (a tag, commit or branch): it
repins `tools/parity/go.mod`, regenerates, and fails if anything but the `dalgo` block of
`test/parity/expected.json` changed. The Go program lives in `tools/parity` and is
not shipped.

## Recursive DTQL subqueries

`parseRecursiveDTQL` accepts one query shape at every nesting level. Use its
dedicated executor with the same schema used to bind fields; the executor sends
only ordinary table scans to `QueryExecutor.query`.

```ts
import { executeRecursiveDTQLQuery, parseRecursiveDTQL } from "@dalgo/core";

const parsed = parseRecursiveDTQL(savedDtqlText, schema);
const page = await executeRecursiveDTQLQuery(adapter, parsed, {
  signal: abortController.signal,
});
```

These checked-in documents show each placement and a full composition:

| Placement | Example |
| --- | --- |
| Scalar projection, including zero rows and NULL | [scalar values](test/testdata/subqueries/scalar-values.dtql.yaml) |
| Derived `from.query` | [derived FROM and JOIN](test/testdata/subqueries/derived-from-join.dtql.yaml) |
| Derived `joins[].from.query` | [derived FROM and JOIN](test/testdata/subqueries/derived-from-join.dtql.yaml) |
| `In` with `right.query` | [IN](test/testdata/subqueries/membership-in.dtql.yaml) |
| `NotIn` with `right.query` | [NOT IN](test/testdata/subqueries/membership-not-in.dtql.yaml) |
| `exists.query` | [EXISTS](test/testdata/subqueries/exists-short-circuit.dtql.yaml) |
| `notExists.query` | [NOT EXISTS](test/testdata/subqueries/not-exists.dtql.yaml) |
| Derived JOIN, EXISTS, IN, and scalar count together | [customer and invoice composition](test/testdata/subqueries/customer-invoice-composition.dtql.yaml) |

An uncorrelated nested result is reused within one root execution. Correlated
results are evaluated for each distinct outer row binding, so a query with many
different bindings can perform many leaf reads. The generic executor has one
root-wide limit of 10,000 fetched rows, 10,000 result rows, 100,000 JOIN
candidate evaluations, and 16 MiB retained data; each limit can be lowered
through execution options. A provider must return a complete, unpaginated leaf
page for a relation scan. EXISTS stops testing candidate rows after the first
match, but a legacy provider may already have materialized its whole
`QueryPage`; cancellation cannot interrupt that in-flight provider call.

The current package has no shipped `@dalgo/core` adapter. Browser adapter
checkouts still importing `@dal-go/dalgo` cannot be passed to this executor
without a version-aligned adapter update and integration test.

## Security boundary

DALgo does not turn browser code into a trusted backend. A Firestore browser
request runs as the current Firebase user and is authorized by Firestore
Security Rules. Use Firebase Authentication, least-privilege rules, and App
Check where appropriate. Never put service-account credentials in a browser.

## Status

The initial API covers point reads, hierarchical collections, collection-group
queries, filters, ordering, deterministic cursor pagination, and read-write
transactions. Adapters must reject unsupported capabilities explicitly rather
than silently changing query semantics.

## Releases

Releases use Changesets and a reviewed version pull request:

1. Add `pnpm changeset` to each pull request that should release the package.
2. After that pull request reaches `main`, the release workflow creates or
   updates `changeset-release/main` with the package version, `CHANGELOG.md`,
   and a generated release marker. The workflow uses the checked-in Changesets
   CLI plus `git` and `gh`; it does not depend on the Changesets GitHub Action.
   GitHub does not start workflows for a pull request update made by its own
   token, so the release workflow explicitly dispatches `ci.yml` against the
   updated version-PR head.
3. Review and merge the `chore: version @dalgo/core` pull request. Only that
   merge is eligible for npm trusted publishing. The workflow runs install,
   lint, tests, type-check/build, verifies the merged pull request and marker,
   publishes with npm OIDC, verifies npm's `gitHead`, and creates the
   `core@v<version>` tag.

The npm trusted publisher must be configured for this repository, the
`Release @dalgo/core` workflow, and the `npm` GitHub environment. Repository
Actions settings must also allow GitHub Actions to create pull requests.

The source manifest is currently `0.2.0`, while the last independently
verified npm release and repository tag are `@dalgo/core@0.1.0` and
`core@v0.1.0`. This setup deliberately does not publish that source-only
`0.2.0` baseline: only a later Changesets-generated version pull request gets
a release marker and can authorize publication. Do not hand-create or edit a
marker under `.changeset/releases/`.

## License

MIT

## Optional source data rights

Adapters may expose `sourceRights` on `CollectionMetadata` for tables/views and
on `QueryPage<T>`, with `usedSourceIds` on query pages. Each `SourceRight`
identifies a provider-defined source, its declaration (name/SPDX/URL/text), the
true authored scope and optional evidence/credits. Providers that do not know
source terms can omit these fields. Absence is unknown, not permission.

`sourceRights` is the authorized planned source inventory, not a licence of the
derived result. `usedSourceIds` records inputs actually read or considered,
including empty inputs and joins projected out of the output. It must not be
inferred from output rows. A known-empty array differs from an omitted array.
Inheritance, term validation, source admission, access control and evidence
budgets remain the provider's responsibility. IDs, scopes and evidence origins
are opaque and do not require OVDB.

Rights-aware adapters capture the complete immutable inventory before the first
page and retain it across pagination. `snapshotQueryMetadata` detaches metadata
from mutable configuration; `executeRecordLookupPages` preserves that captured
metadata and each cursor, including on empty pages. The caller's secured lookup
executor must preflight its lookup sources and supply their inventory and actual
use; a lookup callback's arbitrary return value cannot establish source rights.

Generic joined/recursive DTQL execution currently lacks source-rights preflight.
It fails with `UnsupportedError("source-rights-preflight")` when a scanned input
has either metadata field, rather than returning results without provenance.
For compliant adapters this refusal occurs before any joined result. A transport
that adds metadata only on a later page violates the first-page contract: that
page refuses, but already emitted rows cannot be undone. Use a provider executor
that preflights source rights for rights-bearing joins and aggregations.
