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

After a version is published to npm, manually run the
[tagging workflow](.github/workflows/tag-published-package.yml) on `main` with
that version. It checks npm's published `gitHead` and the matching source
manifest, then tags that exact commit as `core@v<version>` (for example,
`core@v0.1.0`). Publishing alone does not trigger the tagging workflow yet.

## License

MIT
