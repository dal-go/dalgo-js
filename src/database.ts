import type { Key } from "./key.js";
import type { Codec, RecordSnapshot } from "./record.js";
import type { QueryPage, StructuredQuery } from "./query.js";

export type UpdateData = Readonly<Record<string, unknown>>;

export interface ReadSession {
  get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>>;
  getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]>;
}

export interface QueryExecutor {
  query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>>;
}

export interface WriteSession {
  insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void>;
  set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void>;
  update(key: Key, data: UpdateData): Promise<void>;
  delete(key: Key): Promise<void>;
}

export interface ReadwriteTransaction extends ReadSession, WriteSession {}

export interface Database extends ReadSession, QueryExecutor {
  runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result>;
}
