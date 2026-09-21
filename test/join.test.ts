import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { executeJoinedDTQLQuery, isJoinedDTQLQuery, key, parseDTQL, selectJoinAlgorithm, type DTQLSchema, type ExistingRecord, type JoinedDTQLQuery, type QueryExecutor, type StructuredQuery } from "../src/index.js";

type Data = Record<string, unknown>;

const schema: DTQLSchema = {
  tables: [
    { schema: "main", name: "Invoice", fields: ["InvoiceId", "CustomerId"] },
    { schema: "main", name: "Customer", fields: ["CustomerId", "FirstName", "SupportRepId"] },
    { schema: "main", name: "Employee", fields: ["EmployeeId", "FirstName"] },
    { name: "A", fields: ["id"] },
    { name: "B", fields: ["id", "aId"] },
    { name: "C", fields: ["id", "bId"] },
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

function schemaSource(relation: { readonly name: string; readonly schema?: string }) {
  return { kind: "collection" as const, name: relation.schema === undefined ? relation.name : `${relation.schema}.${relation.name}` };
}

describe("executeJoinedDTQLQuery", () => {
  it("selects executable algorithm preferences in order", () => {
    expect(selectJoinAlgorithm(["nestedLoop", "hash"], true)).toBe("nestedLoop");
    expect(selectJoinAlgorithm(["hash", "nestedLoop"], true)).toBe("hash");
    expect(selectJoinAlgorithm(["merge", "lookup", "batchedLookup", "hash"], true)).toBe("hash");
    expect(selectJoinAlgorithm(["hash", "merge"], false)).toBe("nestedLoop");
    expect(selectJoinAlgorithm(undefined, true)).toBe("hash");
  });

  it("honors nestedLoop without retrying hash and keeps hinted output identical", async () => {
    const document = (algorithms: readonly string[] | undefined) => ({
      from: { name: "A", alias: "a", joins: [{ ...(algorithms === undefined ? {} : { hints: { algorithms } }), from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      columns: [{ field: "id", source: "a", as: "a" }, { field: "id", source: "b", as: "b" }],
    });
    const executor = new MemoryExecutor({
      A: [record("A", "a", { id: 1 })],
      B: [record("B", "match", { id: 10, aId: 1 }), record("B", "other", { id: 20, aId: 2 })],
    });
    const normal = await executeJoinedDTQLQuery(executor, joined(document(undefined)));
    const hashed = await executeJoinedDTQLQuery(executor, joined(document(["merge", "hash"])));
    const nested = await executeJoinedDTQLQuery(executor, joined(document(["nestedLoop", "hash"])));
    expect(hashed.records).toEqual(normal.records);
    expect(nested.records).toEqual(normal.records);
    await expect(executeJoinedDTQLQuery(executor, joined(document(["nestedLoop", "hash"])), { maxCandidateEvaluations: 1 })).rejects.toThrow("join_plan at from.joins[0]: candidate-evaluation bound exceeded");
    await expect(executeJoinedDTQLQuery(executor, joined(document(["hash", "nestedLoop"])), { maxCandidateEvaluations: 1 })).resolves.toMatchObject({ records: [{ data: { a: 1, b: 10 } }] });
  });

  it("snapshots validated hints before provider scans", async () => {
    const query = joined({
      from: { name: "A", alias: "a", joins: [{ hints: { algorithms: ["nestedLoop", "hash"] }, from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
    });
    const algorithms = query.from.joins[0]?.hints?.algorithms as unknown as string[];
    class MutatingExecutor extends MemoryExecutor {
      public override query<T>(source: StructuredQuery<T>) {
        algorithms.splice(0, algorithms.length, "hash");
        return super.query(source);
      }
    }
    const executor = new MutatingExecutor({
      A: [record("A", "a", { id: 1 })],
      B: [record("B", "match", { id: 10, aId: 1 }), record("B", "other", { id: 20, aId: 2 })],
    });
    await expect(executeJoinedDTQLQuery(executor, query, { maxCandidateEvaluations: 1 })).rejects.toThrow("join_plan at from.joins[0]: candidate-evaluation bound exceeded");
  });

  it("reports nested-loop candidate bounds at the full structural JOIN path", async () => {
    const query = joined({
      from: {
        name: "A", alias: "a", joins: [{
          from: { name: "B", alias: "b", joins: [{ hints: { algorithms: ["nestedLoop"] }, from: { name: "C", alias: "c" }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "bId", source: "c" } }] }] },
          on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }],
        }],
      },
    });
    const executor = new MemoryExecutor({
      A: [record("A", "a", { id: 1 })],
      B: [record("B", "b", { id: 10, aId: 1 })],
      C: [record("C", "c1", { id: 100, bId: 10 }), record("C", "c2", { id: 200, bId: 11 })],
    });
    await expect(executeJoinedDTQLQuery(executor, query, { maxCandidateEvaluations: 1 })).rejects.toThrow("join_plan at from.joins[0].from.joins[0]: candidate-evaluation bound exceeded");
  });

  it("reports nested JOIN result bounds at the full structural path", async () => {
    const query = joined({ from: { name: "A", alias: "a", joins: [{
      from: { name: "B", alias: "b", joins: [{ hints: { algorithms: ["nestedLoop"] }, from: { name: "C", alias: "c" }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "bId", source: "c" } }] }] },
      on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }],
    }] } });
    const executor = new MemoryExecutor({
      A: [record("A", "a", { id: 1 })],
      B: [record("B", "b1", { id: 10, aId: 1 }), record("B", "b2", { id: 10, aId: 1 })],
      C: [record("C", "c1", { id: 100, bId: 10 }), record("C", "c2", { id: 200, bId: 10 })],
    });
    await expect(executeJoinedDTQLQuery(executor, query, { maxResultRows: 2 })).rejects.toThrow("join_plan at from.joins[0].from.joins[0]: result-row bound exceeded");
  });

  it("rejects malformed direct-model algorithm hints before provider reads", async () => {
    const base: JoinedDTQLQuery = { kind: "joined-dtql", from: { name: "A", alias: "a", joins: [] }, filters: [], orders: [] };
    const malformed = (hints: unknown): JoinedDTQLQuery => ({
      ...base,
      from: { name: "A", alias: "a", joins: [{ type: "inner", hints: hints as never, from: { name: "B", alias: "b", joins: [] }, on: [{ left: { source: "a", field: "id" }, operator: "==", right: { source: "b", field: "aId" } }] }] },
    });
    for (const [hints, diagnostic] of [
      [{ algorithms: [] }, "join_algorithm at from.joins[0].hints.algorithms"],
      [{ algorithms: ["hash", "hash"] }, "join_algorithm at from.joins[0].hints.algorithms[1]"],
      [{ algorithms: ["HASH"] }, "join_algorithm at from.joins[0].hints.algorithms[0]"],
      [[], "join_algorithm at from.joins[0].hints.algorithms"],
    ] as const) {
      const executor = new MemoryExecutor({});
      await expect(executeJoinedDTQLQuery(executor, malformed(hints))).rejects.toThrow(diagnostic);
      expect(executor.calls).toHaveLength(0);
    }
    const sparse = new Array<string>(3);
    sparse[0] = "hash";
    sparse[2] = "nestedLoop";
    const executor = new MemoryExecutor({});
    await expect(executeJoinedDTQLQuery(executor, malformed({ algorithms: sparse }))).rejects.toThrow("join_algorithm at from.joins[0].hints.algorithms[1]");
    expect(executor.calls).toHaveLength(0);
  });

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

    const result = await executeJoinedDTQLQuery(executor, query, { resolveSource: schemaSource });
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

  it("validates direct-model clause aliases and malformed JOINs before scans", async () => {
    const base: JoinedDTQLQuery = { kind: "joined-dtql", from: { name: "A", alias: "a", joins: [] }, filters: [], orders: [] };
    const invalids: readonly [JoinedDTQLQuery, string][] = [
      [{ ...base, filters: [{ field: { source: "missing", field: "id" }, operator: "!=", value: 1 }] }, "join_scope at where[0].left.source"],
      [{ ...base, orders: [{ field: { source: "missing", field: "id" }, direction: "asc" }] }, "join_scope at orderBy[0].source"],
      [{ ...base, columns: [{ expression: { kind: "field", field: { source: "missing", field: "id" } }, as: "id" }] }, "join_scope at columns[0].source"],
      [{ ...base, groupBy: [{ kind: "field", field: { source: "missing", field: "id" } }] }, "join_scope at groupBy[0].source"],
      [{ ...base, having: { left: { kind: "field", field: { source: "missing", field: "id" } }, operator: "==", right: { kind: "literal", value: 1 } } }, "join_scope at having.left.source"],
    ];
    for (const [query, diagnostic] of invalids) {
      const executor = new MemoryExecutor({ A: [record("A", "a", { id: 1 })] });
      await expect(executeJoinedDTQLQuery(executor, query)).rejects.toThrow(diagnostic);
      expect(executor.calls).toHaveLength(0);
    }

    const malformedType: JoinedDTQLQuery = {
      ...base,
      from: { name: "A", alias: "a", joins: [{ type: "right" as never, from: { name: "B", alias: "b", joins: [] }, on: [{ left: { source: "a", field: "id" }, operator: "==", right: { source: "b", field: "aId" } }] }] },
    };
    const malformedOn: JoinedDTQLQuery = {
      ...base,
      from: { name: "A", alias: "a", joins: [{ type: "inner", from: { name: "B", alias: "b", joins: [] }, on: [] }] },
    };
    const missingFrom = {
      ...base,
      from: { name: "A", alias: "a", joins: [{ type: "inner", on: [{ left: { source: "a", field: "id" }, operator: "==", right: { source: "b", field: "aId" } }] }] },
    } as unknown as JoinedDTQLQuery;
    const missingOn = {
      ...base,
      from: { name: "A", alias: "a", joins: [{ type: "inner", from: { name: "B", alias: "b", joins: [] } }] },
    } as unknown as JoinedDTQLQuery;
    const missingRootName = { ...base, from: { alias: "a", joins: [] } } as unknown as JoinedDTQLQuery;
    const missingChildName = {
      ...base,
      from: { name: "A", alias: "a", joins: [{ type: "inner", from: { alias: "b", joins: [] }, on: [{ left: { source: "a", field: "id" }, operator: "==", right: { source: "b", field: "aId" } }] }] },
    } as unknown as JoinedDTQLQuery;
    const emptyChildAlias = {
      ...base,
      from: { name: "A", alias: "a", joins: [{ type: "inner", from: { name: "B", alias: "", joins: [] }, on: [{ left: { source: "a", field: "id" }, operator: "==", right: { source: "b", field: "aId" } }] }] },
    } as unknown as JoinedDTQLQuery;
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), malformedType)).rejects.toThrow("join_type at from.joins[0].type");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), malformedOn)).rejects.toThrow("join_shape at from.joins[0].on");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), missingFrom)).rejects.toThrow("join_shape at from.joins[0].from");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), missingOn)).rejects.toThrow("join_shape at from.joins[0].on");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), missingRootName)).rejects.toThrow("join_shape at from.name");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), missingChildName)).rejects.toThrow("join_shape at from.joins[0].from.name");
    await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), emptyChildAlias)).rejects.toThrow("join_shape at from.joins[0].from.alias");
  });

  it("keeps the full nested right subtree absent for LEFT/INNER and preserves B for LEFT/LEFT", async () => {
    const nested = (type: "inner" | "left") => joined({
      from: {
        name: "A", alias: "a", joins: [{
          type: "left",
          from: {
            name: "B", alias: "b", joins: [{
              type,
              from: { name: "C", alias: "c" },
              on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "bId", source: "c" } }],
            }],
          },
          on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }],
        }],
      },
      orderBy: [{ field: "id", source: "a" }],
      columns: [
        { field: "id", source: "a", as: "a" },
        { field: "id", source: "b", as: "b" },
        { field: "id", source: "c", as: "c" },
      ],
    });
    const executor = new MemoryExecutor({
      A: [record("A", "a1", { id: 1 }), record("A", "a2", { id: 2 })],
      B: [record("B", "b1", { id: 10, aId: 1 })],
      C: [],
    });
    expect((await executeJoinedDTQLQuery(executor, nested("inner"))).records.map((row) => row.data)).toEqual([
      { a: 1, b: null, c: null },
      { a: 2, b: null, c: null },
    ]);
    expect((await executeJoinedDTQLQuery(executor, nested("left"))).records.map((row) => row.data)).toEqual([
      { a: 1, b: 10, c: null },
      { a: 2, b: null, c: null },
    ]);
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
    const result = await executeJoinedDTQLQuery(new MemoryExecutor({ "main.Invoice": [] }), query, { resolveSource: schemaSource });
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

  it("expands source-qualified wildcard exclusions in schema order and rejects unavailable metadata or collisions", async () => {
    const query = joined({
      from: { name: "A", alias: "a", joins: [{ type: "left", from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      columns: [{ wildcard: { source: "b", exclude: ["aId", "missing"] } }],
      limit: 10,
    });
    const executor = new MemoryExecutor({
      A: [record("A", "a1", { id: 1 }), record("A", "a2", { id: 2 })],
      B: [record("B", "b1", { id: 10, aId: 1 })],
    });
    expect((await executeJoinedDTQLQuery(executor, query, { schema })).records.map((row) => row.data)).toEqual([{ id: 10 }, { id: null }]);
    await expect(executeJoinedDTQLQuery(executor, query)).rejects.toThrow("wildcard expansion requires ordered schema metadata");

    const collision: JoinedDTQLQuery = {
      ...query,
      columns: [
        { wildcard: { source: "b", exclude: ["aId"] } },
        { expression: { kind: "field", field: { source: "a", field: "id" } } },
      ],
    };
    await expect(executeJoinedDTQLQuery(executor, collision, { schema })).rejects.toThrow("duplicate output key id");
  });

  it("executes the shared schema-qualified Chinook wildcard fixture through an explicit adapter source mapping", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in canonical YAML fixture at runtime.
    const fixture = readFileSync(new URL("./testdata/joins/chinook-wildcard.dtql.yaml", import.meta.url), "utf8");
    const query = joined(fixture);
    const executor = new MemoryExecutor({
      "main.Invoice": [
        record("Invoice", "1", { InvoiceId: 1, CustomerId: 10 }),
        record("Invoice", "2", { InvoiceId: 2, CustomerId: 10 }),
        record("Invoice", "3", { InvoiceId: 3, CustomerId: 11 }),
      ],
      "main.Customer": [
        record("Customer", "10", { CustomerId: 10, FirstName: "Ada", SupportRepId: 50 }),
        record("Customer", "11", { CustomerId: 11, FirstName: "Bea", SupportRepId: null }),
      ],
      "main.Employee": [record("Employee", "50", { EmployeeId: 50, FirstName: "Evan" })],
    });
    await expect(executeJoinedDTQLQuery(executor, query, { schema })).rejects.toThrow("schema-qualified relation requires resolveSource");
    const result = await executeJoinedDTQLQuery(executor, query, {
      schema,
      resolveSource: schemaSource,
    });
    expect(result.records.map((row) => row.data)).toEqual([
      { invoice_id: 3, FirstName: "Bea", employee: null },
      { invoice_id: 2, FirstName: "Ada", employee: "Evan" },
      { invoice_id: 1, FirstName: "Ada", employee: "Evan" },
    ]);
  });

  it("executes the canonical hinted Chinook journey with the original ordered rows", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in canonical YAML fixture at runtime.
    const fixture = readFileSync(new URL("./testdata/joins/chinook-hinted.dtql.yaml", import.meta.url), "utf8");
    const query = joined(fixture);
    const result = await executeJoinedDTQLQuery(new MemoryExecutor({
      "main.Invoice": [
        record("Invoice", "1", { InvoiceId: 1, CustomerId: 10 }),
        record("Invoice", "2", { InvoiceId: 2, CustomerId: 10 }),
        record("Invoice", "3", { InvoiceId: 3, CustomerId: 11 }),
      ],
      "main.Customer": [
        record("Customer", "10", { CustomerId: 10, FirstName: "Ada", SupportRepId: 50 }),
        record("Customer", "11", { CustomerId: 11, FirstName: "Bea", SupportRepId: null }),
      ],
      "main.Employee": [record("Employee", "50", { EmployeeId: 50, FirstName: "Evan" })],
    }), query, { resolveSource: schemaSource });
    expect(result.records.map((row) => row.data)).toEqual([
      { invoice_id: 3, customer: "Bea", employee: null },
      { invoice_id: 2, customer: "Ada", employee: "Evan" },
      { invoice_id: 1, customer: "Ada", employee: "Evan" },
    ]);
  });
});
