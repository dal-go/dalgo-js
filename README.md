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
