import type { Codec, ExistingRecord } from "./record.js";
import type { Key } from "./key.js";

export const DOCUMENT_ID = "__name__" as const;

type ArbitraryFieldPath = string & { readonly __fieldPathBrand?: never };

export type FieldPath<T> = Extract<keyof T, string> | ArbitraryFieldPath;
export type QueryOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not-in"
  | "array-contains"
  | "array-contains-any";
export type OrderDirection = "asc" | "desc";

export interface CollectionSource<T> {
  readonly kind: "collection";
  readonly name: string;
  readonly parent?: Key;
  readonly codec?: Codec<T>;
}

export interface CollectionGroupSource<T> {
  readonly kind: "collection-group";
  readonly name: string;
  readonly codec?: Codec<T>;
}

export type QuerySource<T> = CollectionSource<T> | CollectionGroupSource<T>;

export interface QueryFilter<T> {
  readonly field: FieldPath<T>;
  readonly operator: QueryOperator;
  readonly value: unknown;
}

export interface QueryOrder<T> {
  readonly field: FieldPath<T>;
  readonly direction: OrderDirection;
}

export interface QueryCursor {
  readonly values: readonly unknown[];
}

export interface StructuredQuery<T> {
  readonly source: QuerySource<T>;
  readonly filters: readonly QueryFilter<T>[];
  readonly orders: readonly QueryOrder<T>[];
  readonly limit?: number;
  readonly offset?: number;
  readonly startAt?: QueryCursor | undefined;
  readonly startAfter?: QueryCursor | undefined;
  readonly endAt?: QueryCursor | undefined;
  readonly endBefore?: QueryCursor | undefined;
}

export interface QueryPage<T> {
  readonly records: readonly ExistingRecord<T>[];
  readonly nextCursor?: QueryCursor;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function cursor(values: readonly unknown[]): QueryCursor {
  if (values.length === 0) {
    throw new TypeError("a query cursor requires at least one value");
  }
  return { values: [...values] };
}

export class QueryBuilder<T> {
  readonly #query: StructuredQuery<T>;

  public constructor(source: QuerySource<T>, query?: StructuredQuery<T>) {
    this.#query = query ?? { source, filters: [], orders: [] };
  }

  public where(field: FieldPath<T>, operator: QueryOperator, value: unknown): QueryBuilder<T> {
    return this.with({ filters: [...this.#query.filters, { field, operator, value }] });
  }

  public orderBy(field: FieldPath<T>, direction: OrderDirection = "asc"): QueryBuilder<T> {
    return this.with({ orders: [...this.#query.orders, { field, direction }] });
  }

  public limit(value: number): QueryBuilder<T> {
    positiveInteger(value, "limit");
    return this.with({ limit: value });
  }

  public offset(value: number): QueryBuilder<T> {
    nonNegativeInteger(value, "offset");
    return this.with({ offset: value });
  }

  public startAt(...values: readonly unknown[]): QueryBuilder<T> {
    return this.with({ startAt: cursor(values), startAfter: undefined });
  }

  public startAfter(...values: readonly unknown[]): QueryBuilder<T> {
    return this.with({ startAfter: cursor(values), startAt: undefined });
  }

  public endAt(...values: readonly unknown[]): QueryBuilder<T> {
    return this.with({ endAt: cursor(values), endBefore: undefined });
  }

  public endBefore(...values: readonly unknown[]): QueryBuilder<T> {
    return this.with({ endBefore: cursor(values), endAt: undefined });
  }

  public build(): StructuredQuery<T> {
    return {
      ...this.#query,
      filters: [...this.#query.filters],
      orders: [...this.#query.orders],
    };
  }

  private with(changes: Partial<StructuredQuery<T>>): QueryBuilder<T> {
    return new QueryBuilder(this.#query.source, { ...this.#query, ...changes });
  }
}
