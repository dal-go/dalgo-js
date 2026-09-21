import { describe, expect, it } from "vitest";
import { executeJoinedDTQLQuery, isJoinedDTQLQuery, key, parseDTQL, type DTQLSchema, type ExistingRecord, type JoinedDTQLQuery, type QueryExecutor, type StructuredQuery } from "../src/index.js";

type Data = Record<string, unknown>;

const schema: DTQLSchema = {
  tables: [
    { schema: "main", name: "Invoice", fields: ["InvoiceId", "CustomerId"] },
    { schema: "main", name: "Customer", fields: ["CustomerId", "FirstName", "SupportRepId"] },
    { schema: "main", name: "Employee", fields: ["EmployeeId", "FirstName"] },
    { name: "A", fields: ["id"] },
    { name: "B", fields: ["id", "aId"] },
  ],
};

class MemoryExecutor implements QueryExecutor {
  public readonly calls: string[] = [];

  public constructor(private readonly tables: Readonly<Record<string, readonly ExistingRecord<Data>[]>>, private readonly paginated = false) {}

  public query<T>(query: StructuredQuery<T>): Promise<{ readonly records: readonly ExistingRecord<T>[]; readonly nextCursor?: { readonly values: readonly unknown[] } }> {
    this.calls.push(query.source.name);
    const records = (this.tables[query.source.name] ?? []) as readonly ExistingRecord<T>[];
    return Promise.resolve({ records, ...(this.paginated ? { nextCursor: { values: ["more"] } } : {}) });
  }
}

function record(collection: string, id: string, data: Data): ExistingRecord<Data> {
  return { key: key(collection, id), exists: true, data };
}

function joined(input: unknown) {
  const query = parseDTQL(input, schema);
  if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
  return query;
}

describe("executeJoinedDTQLQuery", () => {
  it("scans each relation once and preserves nested INNER/LEFT multiplicity and the root key", async () => {
    const query = joined({
      from: {
        schema: "main", name: "Invoice", alias: "i", joins: [{
          from: {
            schema: "main", name: "Customer", alias: "c", joins: [{
              type: "left", from: { schema: "main", name: "Employee", alias: "e" },
              on: [{ left: { field: "SupportRepId", source: "c" }, op: "==", right: { field: "EmployeeId", source: "e" } }],
            }],
          },
          on: [{ left: { field: "CustomerId", source: "i" }, op: "==", right: { field: "CustomerId", source: "c" } }],
        }],
      },
      orderBy: [{ field: "InvoiceId", source: "i", desc: true }],
      columns: [
        { field: "InvoiceId", source: "i", as: "invoice_id" },
        { field: "FirstName", source: "c", as: "customer" },
        { field: "FirstName", source: "e", as: "employee" },
      ],
      limit: 10,
    });
    const executor = new MemoryExecutor({
      "main.Invoice": [record("Invoice", "1", { InvoiceId: 1, CustomerId: 10 }), record("Invoice", "2", { InvoiceId: 2, CustomerId: 10 }), record("Invoice", "3", { InvoiceId: 3, CustomerId: 11 })],
      "main.Customer": [record("Customer", "10", { CustomerId: 10, FirstName: "Ada", SupportRepId: 50 }), record("Customer", "11", { CustomerId: 11, FirstName: "Bea", SupportRepId: null })],
      "main.Employee": [record("Employee", "50", { EmployeeId: 50, FirstName: "Evan" })],
    });

    const result = await executeJoinedDTQLQuery(executor, query);
    expect(executor.calls).toEqual(["main.Invoice", "main.Customer", "main.Employee"]);
    expect(result.records.map((row) => row.key.id)).toEqual(["3", "2", "1"]);
    expect(result.records.map((row) => row.data)).toEqual([
      { invoice_id: 3, customer: "Bea", employee: null },
      { invoice_id: 2, customer: "Ada", employee: "Evan" },
      { invoice_id: 1, customer: "Ada", employee: "Evan" },
    ]);
  });

  it("evaluates same-scope predicates over bounded candidates and distinguishes number from string keys", async () => {
    const sameScope = joined({
      from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      columns: [{ field: "id", source: "a", as: "a" }, { field: "id", source: "b", as: "b" }], limit: 10,
    });
    const executor = new MemoryExecutor({
      A: [record("A", "a1", { id: 1 }), record("A", "a2", { id: 2 })],
      B: [record("B", "b1", { id: 1, aId: 1 }), record("B", "b2", { id: "1", aId: 1 })],
    });
    expect((await executeJoinedDTQLQuery(executor, sameScope)).records.map((row) => row.data)).toEqual([{ a: 1, b: 1 }, { a: 2, b: 1 }]);
    await expect(executeJoinedDTQLQuery(executor, sameScope, { maxResultRows: 1 })).rejects.toThrow("result-row bound exceeded");
    await expect(executeJoinedDTQLQuery(executor, sameScope, { maxCandidateEvaluations: 1 })).rejects.toThrow("candidate-evaluation bound exceeded");
  });

  it("prevalidates malformed join keys and rejects partial paginated scans", async () => {
    const query = joined({
      from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      limit: 10,
    });
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({ A: [], B: [record("B", "bad", { id: 1, aId: { value: 1 } })] }), query)).rejects.toThrow("join_key_type");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({ A: [], B: [record("B", "unsafe", { id: 1, aId: 9_007_199_254_740_992 })] }), query)).rejects.toThrow("join_key_type");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({ A: [record("A", "a", { id: 1 })], B: [] }, true), query)).rejects.toThrow("relation scan is paginated");
  });

  it("allows finite fractional keys, validates direct-model scope, and aggregates HAVING's right expression", async () => {
    const fractional = joined({ from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] }, limit: 10 });
    expect((await executeJoinedDTQLQuery(new MemoryExecutor({ A: [record("A", "a", { id: 1.5 })], B: [record("B", "b", { id: 2, aId: 1.5 })] }), fractional)).records).toHaveLength(1);

    const forward: JoinedDTQLQuery = {
      kind: "joined-dtql", from: { name: "A", alias: "a", joins: [
        { type: "inner", from: { name: "B", alias: "b", joins: [] }, on: [{ left: { field: "id", source: "c" }, operator: "==", right: { field: "aId", source: "b" } }] },
        { type: "inner", from: { name: "B", alias: "c", joins: [] }, on: [{ left: { field: "id", source: "a" }, operator: "==", right: { field: "aId", source: "c" } }] },
      ] }, filters: [], orders: [],
    };
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({ A: [], B: [] }), forward)).rejects.toThrow("join_scope at from.joins[0].on[0].left.source");

    const havingRight = joined({ from: { name: "A", alias: "a" }, having: { op: "<", left: { value: 0 }, right: { aggregate: { function: "count", args: [{ star: true }] } } } });
    expect((await executeJoinedDTQLQuery(new MemoryExecutor({ A: [record("A", "a1", { id: 1 }), record("A", "a2", { id: 2 })] }), havingRight)).records).toHaveLength(1);
  });

  it("groups empty input into COUNT(*) = 0", async () => {
    const query = joined({
      from: { schema: "main", name: "Invoice", alias: "i" },
      columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "total" }],
      limit: 1,
    });
    const result = await executeJoinedDTQLQuery(new MemoryExecutor({ "main.Invoice": [] }), query);
    expect(result.records.map((row) => row.data)).toEqual([{ total: 0 }]);
  });

  it("applies LEFT JOIN, GROUP BY, HAVING, and COUNT(DISTINCT) after relation construction", async () => {
    const query = joined({
      from: { name: "A", alias: "a", joins: [{ type: "left", from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      groupBy: [{ field: "id", source: "a" }],
      having: { op: ">=", left: { aggregate: { function: "count", args: [{ field: "id", source: "b" }], distinct: true } }, right: { value: 0 } },
      orderBy: [{ field: "id", source: "a" }],
      columns: [
        { field: "id", source: "a", as: "a" },
        { aggregate: { function: "count", args: [{ field: "id", source: "b" }], distinct: true }, as: "distinct_b" },
      ],
    });
    const result = await executeJoinedDTQLQuery(new MemoryExecutor({
      A: [record("A", "a1", { id: 1 }), record("A", "a2", { id: 2 })],
      B: [record("B", "b1", { id: 10, aId: 1 }), record("B", "b2", { id: 10, aId: 1 }), record("B", "b3", { id: 20, aId: 1 })],
    }), query);
    expect(result.records.map((row) => row.data)).toEqual([{ a: 1, distinct_b: 2 }, { a: 2, distinct_b: 0 }]);
  });
});
