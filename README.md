# DALgo for TypeScript

`@dal-go/dalgo` is the browser-neutral TypeScript implementation of
[DALgo](https://dalgo.io/). It provides hierarchical keys, typed collections,
structured queries, records, database sessions, and transaction-only mutation
contracts without coupling application code to a database SDK.

The first adapter is
[`@dal-go/dalgo2firestore`](https://github.com/dal-go/dalgo2firestore-js), which
uses Firebase's modular Web SDK and therefore works directly in browsers.

## Install

```sh
pnpm add @dal-go/dalgo @dal-go/dalgo2firestore firebase
```

## Query from a browser

```ts
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { collection } from "@dal-go/dalgo";
import { FirestoreDatabase } from "@dal-go/dalgo2firestore";

interface Item {
  title: string;
  done: boolean;
  rank: number;
}

const app = initializeApp(firebaseConfig);
const db = new FirestoreDatabase(getFirestore(app));
const items = collection<Item>("items").in(spaceKey);

const page = await db.query(
  items.query()
    .where("done", "==", false)
    .orderBy("rank")
    .limit(25)
    .build(),
);

for (const record of page.records) {
  console.log(record.key.id, record.data.title);
}
```

Subcollections use DALgo's ordinary parent-key model:

```ts
import { collection, key } from "@dal-go/dalgo";

const spaceKey = key("spaces", spaceId);
const items = collection<Item>("items").in(spaceKey);
```

Collection-group queries are explicit:

```ts
import { collectionGroup } from "@dal-go/dalgo";

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

## License

MIT
