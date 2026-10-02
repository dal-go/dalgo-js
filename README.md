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

## DTQL order keys, aliases and aggregates

A joined DTQL query follows the Go engine (`github.com/dal-go/dalgo`, `dtql`) for
ordering and aggregation. `test/parity/` proves it case by case (see
[Go parity suite](#go-parity-suite)).

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

**Aliases.** A field key or HAVING operand with no `source` that names a column's
`as` alias refers to that column (`orderBy: [{field: purchases, desc: true}]`,
`having: {left: {field: purchases}, op: '>', right: {value: 1}}`). The alias is
resolved at parse time to the expression it names, so the parsed query and its
canonical serialisation carry that expression. An alias never takes a `source`.

**Aggregate queries** (any `groupBy`, `having`, or aggregate in a column or key)
are validated at parse like Go's `ValidateAggregation`: every column and every
ORDER BY or HAVING operand must be an aggregate, a literal, or a `groupBy`
expression; aggregates take exactly one argument, cannot nest, and `DISTINCT`
is not allowed for `min`, `max`, `first`, `last`; `sum(*)` and `count(distinct *)`
are rejected; a wildcard cannot be selected. Without `columns` a grouped query
returns its group keys, and an ungrouped aggregate query returns one empty row.
HAVING accepts any expression (for example a `binary` ratio), not just a field or
an aggregate.

**Values.** These follow Go and changed in this release:

- Arithmetic is null for a null or non-numeric operand and for division by zero
  (it was `Infinity`, or an error for text); an overflow to infinity is an error.
- Mixed-type comparison orders booleans, then numbers, then strings (null first).
- `sum` and `avg` ignore non-numeric values; `sum` over no numbers is null (it was
  0). `first` and `last` keep a null value.
- HAVING `==` is true for two nulls; `<`, `<=`, `>`, `>=` are false when either side is null.
- A flat aggregate join streams through `scanPages` for every aggregate query
  (an aggregate that appears only in an order key included) except one that uses
  `DISTINCT`, which runs through the generic plan.

Deliberate differences from Go: `where` and `having` also accept `!=` (DTQL in Go has
no `!=`); `groupBy` takes fields only; and a field without `source` resolves through the
schema when exactly one relation has it (Go requires `source` in joins and aggregates);
`and`/`or` groups in `where`/`having` are not implemented yet; strings compare by UTF-16
code unit, Go by byte.

### Go parity suite

`test/parity/cases/*.json` are queries, `test/parity/dataset.json` the in-memory tables,
and `test/parity/expected.json` the rows (or the error) that the Go engine returned for
each case, with the dalgo version and commit it ran at. `test/parity.test.ts` runs every case
through this package, generically and through `scanPages`, and compares exactly (numbers
within 1e-9); a case Go rejects at parse must be rejected by `parseDTQL`. CI needs no Go.

To add a case, append it to a file in `test/parity/cases/` and run
`tools/parity/regenerate.sh` (Go and network access to the module proxy; see
`tools/parity/README.md`), then `pnpm test`. A difference is a regression in one of the
two engines, or a Go change to port; moving the reference to a newer dalgo is the same
script with the new revision. The Go program lives in `tools/parity` and is not shipped.

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
