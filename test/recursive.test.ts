/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeRecursiveDTQLQuery, key, parseRecursiveDTQL, serializeRecursiveDTQL, type DTQLSchema, type QueryExecutor, type StructuredQuery } from "../src/index.js";

const root = new URL("./testdata/subqueries/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { readonly sourceCommit: string; readonly files: Readonly<Record<string, string>> };
const schemaDocument = JSON.parse(readFileSync(new URL("schema.json", root), "utf8")) as { readonly tables: Readonly<Record<string, readonly string[]>> };
const data = JSON.parse(readFileSync(new URL("dataset.json", root), "utf8")) as { readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>> };
const schema: DTQLSchema = { tables: Object.entries(schemaDocument.tables).map(([name, fields]) => ({ name, fields })) };
const suite = JSON.parse(readFileSync(new URL("suite.json", root), "utf8")) as { readonly cases: readonly { readonly name: string; readonly input?: string; readonly rows?: string; readonly error?: string; readonly expectation?: string }[] };

class MemoryExecutor implements QueryExecutor {
  public readonly calls: string[] = [];
  public async query<T>(query: StructuredQuery<T>) {
    if (query.source.kind !== "collection") throw new Error("unexpected source");
    this.calls.push(query.source.name);
    return { records: (data.tables[query.source.name] ?? []).map((value, index) => ({ key: key(query.source.name, index.toString()), exists: true as const, data: value as T })) };
  }
}

function fixture(name: string): string { return readFileSync(new URL(name, root), "utf8"); }

describe("recursive DTQL fixtures", () => {
  it("pins every vendored byte to the Go manifest and source commit", () => {
    expect(manifest.sourceCommit).toBe("da4e671be46e9c2c4906cb645d9e16c0fd90d590");
    expect(readdirSync(root).sort()).toContain("suite.json");
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(fixture(name)).digest("hex")).toBe(digest);
    }
  });

  it("executes every positive fixture and rejects every negative fixture", async () => {
    for (const entry of suite.cases) {
      const input = entry.input;
      if (input === undefined) continue;
      if (entry.error !== undefined) {
        const expected = JSON.parse(fixture(entry.error)) as { readonly category: string; readonly path: string; readonly message: string };
        if (expected.category === "cardinality") {
          await expect(executeRecursiveDTQLQuery(new MemoryExecutor(), parseRecursiveDTQL(fixture(input), schema))).rejects.toThrow(expected.message);
        } else {
          expect(() => parseRecursiveDTQL(fixture(input), schema)).toThrow(`${expected.category} at ${expected.path}`);
          expect(() => parseRecursiveDTQL(fixture(input), schema)).toThrow(expected.message);
        }
        continue;
      }
      const query = parseRecursiveDTQL(fixture(input), schema);
      expect(serializeRecursiveDTQL(query)).toEqual(serializeRecursiveDTQL(parseRecursiveDTQL(JSON.stringify(serializeRecursiveDTQL(query)), schema)));
      const actual = (await executeRecursiveDTQLQuery(new MemoryExecutor(), query)).records.map((record) => record.data);
      if (entry.rows === undefined) throw new Error(`positive fixture ${entry.name} has no rows`);
      expect(actual).toEqual(JSON.parse(fixture(entry.rows)) as unknown);
    }
  });

  it("keeps nested ASTs away from QueryExecutor after an abort", async () => {
    const controller = new AbortController(); controller.abort(new Error("stopped"));
    const executor = new MemoryExecutor();
    await expect(executeRecursiveDTQLQuery(executor, parseRecursiveDTQL(fixture("scalar-values.dtql.yaml"), schema), { signal: controller.signal })).rejects.toThrow("stopped");
    expect(executor.calls).toEqual([]);
  });

  it("reports every root-wide generic execution budget", async () => {
    const scalar = parseRecursiveDTQL(fixture("scalar-values.dtql.yaml"), schema);
    await expect(executeRecursiveDTQLQuery(new MemoryExecutor(), scalar, { maxFetchedRows: 1 })).rejects.toThrow("fetched_rows");
    await expect(executeRecursiveDTQLQuery(new MemoryExecutor(), scalar, { maxResultRows: 1 })).rejects.toThrow("result_rows");
    await expect(executeRecursiveDTQLQuery(new MemoryExecutor(), scalar, { maxRetainedBytes: 1 })).rejects.toThrow("retained_bytes");
    const derived = parseRecursiveDTQL(fixture("derived-from-join.dtql.yaml"), schema);
    await expect(executeRecursiveDTQLQuery(new MemoryExecutor(), derived, { maxCandidateEvaluations: 1 })).rejects.toThrow("candidate_evaluations");
  });

  it("short-circuits EXISTS after its first qualifying row", async () => {
    const query = parseRecursiveDTQL(fixture("exists-short-circuit.dtql.yaml"), schema);
    const executor = new MemoryExecutor();
    await executeRecursiveDTQLQuery(executor, query);
    // The fixture has three outer customers. Each correlated EXISTS needs one
    // Invoice scan only; it must not evaluate a projected nested result.
    expect(executor.calls.filter((name) => name === "Invoice")).toHaveLength(3);
  });

  it("does not evaluate a later EXISTS candidate once an earlier candidate is TRUE", async () => {
    const query = parseRecursiveDTQL(fixture("exists-short-circuit.dtql.yaml"), schema);
    const explosive = new Proxy({ InvoiceId: 99, CustomerId: 1, Total: 1, InvoiceDate: "2099-01-01" }, {
      get: (_target, property) => {
        if (property === "toJSON") return () => ({});
        throw new Error("later EXISTS candidate was evaluated");
      },
    });
    const executor: QueryExecutor = {
      async query<T>(leaf: StructuredQuery<T>) {
        const rows = leaf.source.name === "Customer"
          ? [{ key: key("Customer", "1"), exists: true as const, data: { CustomerId: 1, FirstName: "Ada", Country: "IE" } }]
          : [{ key: key("Invoice", "1"), exists: true as const, data: { InvoiceId: 10, CustomerId: 1, Total: 1, InvoiceDate: "2024-01-01" } }, { key: key("Invoice", "2"), exists: true as const, data: explosive }];
        return { records: rows as never };
      },
    };
    await expect(executeRecursiveDTQLQuery(executor, query)).resolves.toMatchObject({ records: [{ data: { CustomerId: 1 } }] });
  });

  it("checks the vendored membership truth-table sidecar", async () => {
    const table = JSON.parse(fixture("membership-null-table.expect.json")) as { readonly cases: readonly { readonly name: string; readonly whereIn: boolean; readonly whereNotIn: boolean }[] };
    const run = async (name: string): Promise<Set<string>> => new Set((await executeRecursiveDTQLQuery(new MemoryExecutor(), parseRecursiveDTQL(fixture(name), schema))).records.map((record) => String(record.data.Name)));
    const [inRows, notInRows] = await Promise.all([run("membership-in.dtql.yaml"), run("membership-not-in.dtql.yaml")]);
    const fixtureName = (name: string): string => name.replace(/^in-/, "");
    expect([...inRows].sort()).toEqual(table.cases.filter((item) => item.whereIn).map((item) => fixtureName(item.name)).sort());
    expect([...notInRows].sort()).toEqual(table.cases.filter((item) => item.whereNotIn).map((item) => fixtureName(item.name)).sort());
  });

  it("binds unqualified local fields without changing their serialized form", async () => {
    const query = parseRecursiveDTQL("from: {name: Customer, alias: c}\nlimit: 1\ncolumns: [{field: CustomerId}]\n", schema);
    expect(serializeRecursiveDTQL(query)).toMatchObject({ columns: [{ field: "CustomerId" }] });
    await expect(executeRecursiveDTQLQuery(new MemoryExecutor(), query)).resolves.toMatchObject({ records: [{ data: { CustomerId: 1 } }] });
  });

  it("rejects an unbound caller-constructed AST before its executor is called", async () => {
    const executor = new MemoryExecutor();
    await expect(executeRecursiveDTQLQuery(executor, { kind: "recursive-dtql", from: { kind: "table", name: "Customer", alias: "c", joins: [] } }))
      .rejects.toThrow("caller-constructed recursive query requires schema validation");
    await expect(executeRecursiveDTQLQuery(executor, {
      kind: "recursive-dtql",
      from: { kind: "table", name: "Customer", alias: "c", joins: [] },
      columns: [{ expression: { kind: "field", field: { source: "c", field: "Missing" } } }],
    }, { schema })).rejects.toThrow("unknown field Missing");
    expect(executor.calls).toEqual([]);
  });

  it("memoizes scalar queries per distinct outer binding, including unqualified outer fields", async () => {
    const scopedSchema: DTQLSchema = { tables: [{ name: "Outer", fields: ["id", "needle"] }, { name: "Inner", fields: ["value"] }] };
    const query = parseRecursiveDTQL("from: {name: Outer, alias: o}\norderBy: [{field: id, source: o}]\ncolumns:\n  - {field: id, source: o}\n  - query:\n      as: matched\n      from: {name: Inner, alias: i}\n      where:\n        op: '=='\n        left: {field: value, source: i}\n        right: {field: needle}\n      columns: [{field: value, source: i}]\n", scopedSchema);
    const executor: QueryExecutor = {
      async query<T>(leaf: StructuredQuery<T>) {
        const records = leaf.source.name === "Outer"
          ? [{ key: key("Outer", "1"), exists: true as const, data: { id: 1, needle: 1 } }, { key: key("Outer", "2"), exists: true as const, data: { id: 2, needle: 2 } }]
          : [{ key: key("Inner", "1"), exists: true as const, data: { value: 1 } }];
        return { records: records as never };
      },
    };
    const rows = (await executeRecursiveDTQLQuery(executor, query)).records.map((record) => record.data);
    expect(rows).toEqual([{ id: 1, matched: 1 }, { id: 2, matched: null }]);
  });

  it("rebinds a parsed AST after mutation before reading a leaf", async () => {
    const query = parseRecursiveDTQL("from: {name: Customer, alias: c}\nlimit: 1\ncolumns: [{field: CustomerId, source: c}]\n", schema);
    (query.from as unknown as { name: string }).name = "Missing";
    const executor = new MemoryExecutor();
    await expect(executeRecursiveDTQLQuery(executor, query)).rejects.toThrow("unknown table Missing");
    expect(executor.calls).toEqual([]);
  });
});
