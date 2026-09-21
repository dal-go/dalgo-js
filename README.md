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
