import type { Key } from "./key.js";

export interface MissingRecord {
  readonly key: Key;
  readonly exists: false;
  readonly data?: never;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExistingRecord<T> {
  readonly key: Key;
  readonly exists: true;
  readonly data: T;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type RecordSnapshot<T> = MissingRecord | ExistingRecord<T>;

export interface Codec<T> {
  encode(value: T): unknown;
  decode(value: unknown): T;
}

export const identityCodec: Codec<unknown> = {
  encode: (value) => value,
  decode: (value) => value,
};
