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

/** A qualified field reference used by a relation join predicate. */
export interface QueryFieldReference {
  readonly field: string;
  readonly source: string;
}

/** The currently supported backend-independent relation join kinds. */
export type QueryJoinType = "inner" | "left";

/** A structured equality predicate between fields in two visible relations. */
export interface QueryJoinPredicate {
  readonly left: QueryFieldReference;
  readonly operator: "==";
  readonly right: QueryFieldReference;
}

/**
 * A recursive, ordered relation tree used by the distinct join-aware query
 * variant. Legacy single-source executors do not receive this model.
 */
export interface QueryRelation {
  readonly name: string;
  readonly schema?: string;
  readonly alias?: string;
  readonly joins: readonly QueryJoin[];
}

export interface QueryJoin {
  readonly type: QueryJoinType;
  readonly from: QueryRelation;
  readonly on: readonly QueryJoinPredicate[];
}

/** A structured expression reserved for join-aware DTQL pipeline clauses. */
export type DTQLExpression =
  | { readonly kind: "field"; readonly field: QueryFieldReference }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "values"; readonly values: readonly (string | number | boolean | null)[] }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "star" }
  | {
    readonly kind: "aggregate";
    readonly function: "count" | "sum" | "avg" | "min" | "max" | "first" | "last";
    readonly args: readonly DTQLExpression[];
    readonly distinct?: boolean;
  }
  | { readonly kind: "binary"; readonly operator: "+" | "-" | "*" | "/"; readonly left: DTQLExpression; readonly right: DTQLExpression };

/** A named projection in a DTQL query. */
export interface QueryColumn {
  readonly expression?: DTQLExpression;
  readonly wildcard?: { readonly source?: string; readonly exclude: readonly string[] };
  readonly as?: string;
}

/** A predicate in a join-aware DTQL query. */
export interface DTQLQueryFilter {
  readonly field: QueryFieldReference;
  readonly operator: QueryOperator;
  readonly value: unknown;
}

/** A structured HAVING predicate; operators may grow with the expression model. */
export interface DTQLHaving {
  readonly left: DTQLExpression;
  readonly operator: QueryOperator;
  readonly right: DTQLExpression;
}

/** An ordering term in a join-aware DTQL query. */
export interface DTQLQueryOrder {
  readonly field: QueryFieldReference;
  readonly direction: OrderDirection;
}

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

/**
 * A parsed DTQL query that needs a join-aware execution entrypoint. It has no
 * `source` property, making it intentionally incompatible with legacy
 * `QueryExecutor.query(StructuredQuery)` implementations.
 */
export interface JoinedDTQLQuery {
  readonly kind: "joined-dtql";
  readonly from: QueryRelation;
  readonly filters: readonly DTQLQueryFilter[];
  readonly orders: readonly DTQLQueryOrder[];
  readonly columns?: readonly QueryColumn[];
  readonly limit?: number;
  readonly offset?: number;
  readonly groupBy?: readonly DTQLExpression[];
  readonly having?: DTQLHaving;
}

export type ParsedDTQLQuery<T> = StructuredQuery<T> | JoinedDTQLQuery;

export function isJoinedDTQLQuery<T>(query: ParsedDTQLQuery<T>): query is JoinedDTQLQuery {
  return "kind" in query;
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
