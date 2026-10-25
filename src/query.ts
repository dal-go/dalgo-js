import type { Codec, ExistingRecord } from "./record.js";
import type { Key } from "./key.js";
import type { QueryMetadata } from "./source-rights.js";

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

/** Case-sensitive physical JOIN preferences retained on one relation edge. */
export type QueryJoinAlgorithm = "hash" | "merge" | "lookup" | "batchedLookup" | "nestedLoop";

/** Ordered physical JOIN preferences. Each edge owns an independent list. */
export interface QueryJoinHints {
  readonly algorithms: readonly QueryJoinAlgorithm[];
}

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
  /** Named database whose executor scans this relation. */
  readonly database?: string;
  /** Source ordering and bound, applied before the relation is joined. */
  readonly scan?: { readonly orderBy: readonly QueryOrder<Record<string, unknown>>[]; readonly limit: number };
  readonly schema?: string;
  readonly alias?: string;
  readonly joins: readonly QueryJoin[];
}

export interface QueryJoin {
  readonly type: QueryJoinType;
  readonly from: QueryRelation;
  readonly on: readonly QueryJoinPredicate[];
  readonly hints?: QueryJoinHints;
}

/** A structured expression reserved for join-aware TugQL pipeline clauses. */
export type TugQLExpression =
  | { readonly kind: "field"; readonly field: QueryFieldReference }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "values"; readonly values: readonly (string | number | boolean | null)[] }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "star" }
  | {
    readonly kind: "aggregate";
    readonly function: "count" | "sum" | "avg" | "min" | "max" | "first" | "last";
    readonly args: readonly TugQLExpression[];
    readonly distinct?: boolean;
  }
  | { readonly kind: "binary"; readonly operator: "+" | "-" | "*" | "/"; readonly left: TugQLExpression; readonly right: TugQLExpression };

/** A named projection in a TugQL query. */
export interface QueryColumn {
  readonly expression?: TugQLExpression;
  readonly wildcard?: { readonly source?: string; readonly exclude: readonly string[] };
  readonly as?: string;
}

/**
 * A comparison between two expressions, as Go's `dal.Comparison`: a WHERE or
 * HAVING predicate. WHERE accepts an expression on either side (a field, a
 * literal, arithmetic, a `values` list); HAVING resolves aggregates per group.
 */
export interface TugQLComparison {
  readonly left: TugQLExpression;
  readonly operator: QueryOperator;
  readonly right: TugQLExpression;
}

/** An `and` or `or` group of conditions, as Go's `dal.GroupCondition`. */
export interface TugQLConditionGroup {
  readonly kind: "and" | "or";
  readonly conditions: readonly TugQLCondition[];
}

/**
 * A null test, as Go's `dal.IsNullCondition`: `isNull` (`kind: "is-null"`) and
 * `isNotNull` (`kind: "is-not-null"`). It is true or false for every input,
 * never unknown, so it is the way to select or exclude nulls in a joined or
 * aggregated query where `x == null` matches nothing. A missing field is null.
 */
export interface TugQLNullTest {
  readonly kind: "is-null" | "is-not-null";
  readonly operand: TugQLExpression;
}

/** A WHERE or HAVING condition: a comparison, a null test or a nested `and`/`or` group. */
export type TugQLCondition = TugQLComparison | TugQLConditionGroup | TugQLNullTest;

/**
 * The compact form of the most common WHERE predicate: a field compared with a
 * literal (`In` and `NotIn` take the list as `value`). The parser emits it for
 * exactly that shape at the top level of `where`, and every other WHERE
 * condition is a `TugQLCondition`.
 */
export interface TugQLQueryFilter {
  readonly field: QueryFieldReference;
  readonly operator: QueryOperator;
  readonly value: unknown;
}

/** A structured HAVING predicate. */
export type TugQLHaving = TugQLComparison;

/** An ordering term on a plain field of a join-aware TugQL query. */
export interface TugQLFieldOrder {
  readonly field: QueryFieldReference;
  readonly expression?: undefined;
  readonly direction: OrderDirection;
}

/**
 * An ordering term on an arbitrary expression (for example a binary `/` over
 * aggregates), as the Go TugQL engine accepts. Plain field keys keep the
 * `TugQLFieldOrder` shape.
 */
export interface TugQLExpressionOrder {
  readonly expression: TugQLExpression;
  readonly field?: undefined;
  readonly direction: OrderDirection;
}

/** An ordering term in a join-aware TugQL query. */
export type TugQLQueryOrder = TugQLFieldOrder | TugQLExpressionOrder;

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
 * A parsed TugQL query that needs a join-aware execution entrypoint. It has no
 * `source` property, making it intentionally incompatible with legacy
 * `QueryExecutor.query(StructuredQuery)` implementations.
 */
export interface JoinedTugQLQuery {
  readonly kind: "joined-tugql";
  readonly money?: { readonly minorUnitScale: number; readonly divisionScale: number; readonly rounding: "halfEven" };
  readonly from: QueryRelation;
  /** Conditions that must all hold; the parser emits at most one (Go has a single `where`). */
  readonly filters: readonly (TugQLQueryFilter | TugQLCondition)[];
  readonly orders: readonly TugQLQueryOrder[];
  readonly columns?: readonly QueryColumn[];
  readonly limit?: number;
  readonly offset?: number;
  readonly groupBy?: readonly TugQLExpression[];
  readonly having?: TugQLCondition;
}

export type ParsedTugQLQuery<T> = StructuredQuery<T> | JoinedTugQLQuery;

/**
 * Recursive TugQL (TugQL) is intentionally a separate query model. It is executed by
 * `executeRecursiveTugQLQuery`, which only gives leaf StructuredQuery objects
 * to a provider's legacy QueryExecutor.
 */
export interface RecursiveTugQLQuery {
  readonly kind: "recursive-tugql";
  readonly as?: string;
  readonly from: RecursiveTugQLRelation;
  readonly where?: RecursiveTugQLCondition;
  readonly orderBy?: readonly TugQLFieldOrder[];
  readonly limit?: number;
  readonly offset?: number;
  readonly columns?: readonly RecursiveTugQLColumn[];
  readonly groupBy?: readonly TugQLExpression[];
  readonly having?: RecursiveTugQLCondition;
}

export interface RecursiveTugQLRelation {
  readonly kind: "table" | "query";
  readonly name?: string;
  readonly schema?: string;
  readonly alias?: string;
  readonly query?: RecursiveTugQLQuery;
  readonly joins: readonly RecursiveTugQLJoin[];
}

export interface RecursiveTugQLJoin {
  readonly type: QueryJoinType;
  readonly from: RecursiveTugQLRelation;
  readonly on: readonly QueryJoinPredicate[];
  readonly hints?: QueryJoinHints;
}

export type RecursiveTugQLExpression = TugQLExpression | { readonly kind: "query"; readonly query: RecursiveTugQLQuery };

export interface RecursiveTugQLColumn {
  readonly expression: RecursiveTugQLExpression;
  readonly as?: string;
}

export type RecursiveTugQLCondition =
  | { readonly kind: "comparison"; readonly left: RecursiveTugQLExpression; readonly operator: QueryOperator; readonly right: RecursiveTugQLExpression }
  | { readonly kind: "and" | "or"; readonly conditions: readonly RecursiveTugQLCondition[] }
  | { readonly kind: "is-null" | "is-not-null"; readonly operand: RecursiveTugQLExpression }
  | { readonly kind: "exists" | "not-exists"; readonly query: RecursiveTugQLQuery };

export type AnyParsedTugQLQuery<T> = ParsedTugQLQuery<T> | RecursiveTugQLQuery;

export function isJoinedTugQLQuery<T>(query: ParsedTugQLQuery<T>): query is JoinedTugQLQuery {
  return "kind" in query;
}

export function isRecursiveTugQLQuery<T>(query: AnyParsedTugQLQuery<T>): query is RecursiveTugQLQuery {
  return "kind" in query && query.kind === "recursive-tugql";
}

export interface QueryPage<T> extends QueryMetadata {
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
