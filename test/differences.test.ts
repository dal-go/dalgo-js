import { describe, expect, it } from "vitest";
import {
  executeJoinedDTQLQuery,
  isJoinedDTQLQuery,
  key,
  parseDTQL,
  serializeJoinedDTQL,
  type DTQLSchema,
  type ExistingRecord,
  type JoinedDTQLQuery,
  type QueryExecutor,
  type StructuredQuery,
} from "../src/index.js";

/*
 * The places where this engine deliberately differs from the Go one, each
 * pinned by a test here because the parity suite (test/parity) cannot hold a
 * case whose two sides are meant to disagree. The README lists them.
 */

type Data = Record<string, unknown>;

const schema: DTQLSchema = {
  tables: [
    { name: "A", fields: ["id", "n", "d", "note", "s"] },
    { name: "B", fields: ["id", "aId", "w"] },
  ],
};

class MemoryExecutor implements QueryExecutor {
  public constructor(private readonly tables: Readonly<Record<string, readonly ExistingRecord<Data>[]>>) {}

  public query<T>(query: StructuredQuery<T>): Promise<{ readonly records: readonly ExistingRecord<T>[] }> {
    return Promise.resolve({ records: (this.tables[query.source.name] ?? []) as readonly ExistingRecord<T>[] });
  }
}

function rows(collection: string, items: readonly Data[]): ExistingRecord<Data>[] {
  return items.map((data, index) => ({ key: key(collection, String(index)), exists: true as const, data }));
}

function joined(input: unknown, options?: { maxLimit?: number }): JoinedDTQLQuery {
  const query = parseDTQL(input, schema, options);
  if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
  return query;
}

async function run(tables: Readonly<Record<string, readonly Data[]>>, query: JoinedDTQLQuery): Promise<Data[]> {
  const executor = new MemoryExecutor(Object.fromEntries(Object.entries(tables).map(([name, items]) => [name, rows(name, items)])));
  return (await executeJoinedDTQLQuery(executor, query)).records.map((row) => row.data);
}

const count = { aggregate: { function: "count", args: [{ star: true }] } };
const a = (field: string): { field: string; source: string } => ({ field, source: "a" });
const aData = [{ id: 1, n: 10, d: 1, note: "x", s: "b" }, { id: 2, n: 20, d: 1, note: null, s: "a" }, { id: 3, n: 5, d: 2, note: "y", s: "c" }];
const bData = [{ id: 1, aId: 1, w: 1 }, { id: 2, aId: 1, w: 2 }, { id: 3, aId: 3, w: 3 }];
const join = { from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: a("id"), op: "==", right: { field: "aId", source: "b" } }] }] } };

describe("schema-resolved fields (Go needs a source in a JOIN)", () => {
  it("resolves an unqualified field to the one relation that has it", () => {
    const query = joined({ ...join, where: { op: "==", left: { field: "n" }, right: { value: 10 } }, columns: [{ field: "w" }] });
    expect(query.filters).toEqual([{ field: { field: "n", source: "a" }, operator: "==", value: 10 }]);
    expect(query.columns).toEqual([{ expression: { kind: "field", field: { field: "w", source: "b" } } }]);
  });

  it("rejects an unqualified field that more than one relation has", () => {
    expect(() => joined({ ...join, columns: [{ field: "id" }] })).toThrow("ambiguous field id; specify source");
  });

  it("accepts a SELECT alias as an ORDER BY key on a joined aggregate query", async () => {
    const query = joined({ ...join, groupBy: [a("id")], columns: [a("id"), { ...count, as: "n" }], orderBy: [{ field: "n", desc: true }, a("id")] });
    expect(await run({ A: aData, B: bData }, query)).toEqual([{ id: 1, n: 2 }, { id: 3, n: 1 }]);
  });

  it("accepts a SELECT alias as an ORDER BY key on a joined row query", async () => {
    const query = joined({ ...join, columns: [{ ...a("n"), as: "amount" }, { field: "w", source: "b" }], orderBy: [{ field: "amount", desc: true }, { field: "w", source: "b", desc: true }] });
    expect(await run({ A: aData, B: bData }, query)).toEqual([{ amount: 10, w: 2 }, { amount: 10, w: 1 }, { amount: 5, w: 3 }]);
  });

  it("accepts an alias inside an expression key of a joined query", async () => {
    const query = joined({ ...join, groupBy: [a("id")], columns: [a("id"), { ...count, as: "n" }], orderBy: [{ binary: { op: "-", left: { value: 0 }, right: { field: "n" } } }, a("id")] });
    expect(await run({ A: aData, B: bData }, query)).toEqual([{ id: 1, n: 2 }, { id: 3, n: 1 }]);
  });

  it("names an unaliased aggregate over an unqualified field as written, not as resolved", () => {
    const query = joined({ ...join, columns: [{ aggregate: { function: "sum", args: [{ field: "n" }] } }, { aggregate: { function: "sum", args: [a("d")] } }] });
    expect(query.columns?.map((column) => column.as)).toEqual(["SUM(n)", undefined]);
  });

  it("resolves a SELECT alias of a single non-aggregate source (Go hands that query to the provider)", async () => {
    const query = joined({ from: { name: "A", alias: "a" }, columns: [{ field: "id", source: "a" }, { ...a("n"), as: "amount" }], orderBy: [{ field: "amount", desc: true }] });
    expect(await run({ A: aData }, query)).toEqual([{ id: 2, amount: 20 }, { id: 1, amount: 10 }, { id: 3, amount: 5 }]);
  });

  it("rejects a field the schema does not have, where Go reads null", () => {
    expect(() => joined({ from: { name: "A", alias: "a" }, where: { op: "==", left: a("nope"), right: { value: 1 } } })).toThrow("unknown field a.nope");
  });
});

describe("`!=` (DTQL in Go has no such operator)", () => {
  const where = (op: string, value: unknown): JoinedDTQLQuery => joined({ from: { name: "A", alias: "a" }, where: { op, left: a("note"), right: { value } }, columns: [a("id")], orderBy: [a("id")] });

  it("treats null as a value: x != null means not null, null != x is true", async () => {
    expect(await run({ A: aData }, where("!=", null))).toEqual([{ id: 1 }, { id: 3 }]);
    expect(await run({ A: aData }, where("!=", "x"))).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("works in HAVING and inside groups, and serialises as written", async () => {
    const query = joined({ from: { name: "A", alias: "a" }, groupBy: [a("d")], having: { and: [{ op: "!=", left: a("d"), right: { value: 2 } }, { op: ">=", left: count, right: { value: 1 } }] }, columns: [a("d")] });
    expect(await run({ A: aData }, query)).toEqual([{ d: 1 }]);
    expect(JSON.stringify(serializeJoinedDTQL(query))).toContain('"op":"!="');
  });
});

describe("limits", () => {
  it("refuses a limit above maxLimit (1000 by default); Go has no such cap", () => {
    expect(() => joined({ from: { name: "A", alias: "a" }, limit: 5000 })).toThrow("limit must not exceed 1000");
    expect(joined({ from: { name: "A", alias: "a" }, limit: 5000 }, { maxLimit: 10_000 }).limit).toBe(5000);
  });

  it("reads limit: 0 as no limit in the relation model, as Go does, and still requires one for a bare source", () => {
    expect(joined({ from: { name: "A", alias: "a" }, limit: 0 }).limit).toBeUndefined();
    expect(() => parseDTQL({ from: { name: "A" }, limit: 0 }, schema)).toThrow("limit must be a positive safe integer");
  });
});

describe("forms the joined executor does not support", () => {
  it.each([
    ["a subquery source", { from: { query: { as: "q", from: { name: "A" } } } }, "subquery sources are not supported"],
    ["a subquery expression", { from: { name: "A", alias: "a" }, where: { op: "==", left: { query: { as: "q", from: { name: "B" } } }, right: { value: 1 } } }, "subquery expressions are not supported"],
    ["exists", { from: { name: "A", alias: "a" }, where: { exists: { query: { from: { name: "B" } } } } }, "exists and notExists subqueries are not supported"],
    ["notExists inside a group", { from: { name: "A", alias: "a" }, where: { and: [{ notExists: { query: { from: { name: "B" } } } }] } }, "exists and notExists subqueries are not supported"],
    ["a groupBy expression", { from: { name: "A", alias: "a" }, groupBy: [{ binary: { op: "+", left: { value: 1 }, right: { value: 2 } } }] }, "unsupported groupBy[0] key binary"],
  ])("rejects %s at parse", (_label, document, message) => {
    expect(() => parseDTQL(document, schema)).toThrow(message);
  });

  it("keeps the plain field-versus-literal where for a bare single source and refuses groups there", () => {
    expect(parseDTQL({ from: { name: "A" }, where: { op: "==", left: { field: "n" }, right: { value: 1 } }, limit: 1 }, schema).filters).toEqual([{ field: "n", operator: "==", value: 1 }]);
    expect(() => parseDTQL({ from: { name: "A" }, where: { and: [{ op: "==", left: { field: "n" }, right: { value: 1 } }] }, limit: 1 }, schema)).toThrow("where groups require an aliased or joined relation model");
  });
});

describe("strings", () => {
  it("compare by UTF-16 code unit, where Go compares UTF-8 bytes", async () => {
    // U+1F600 is the surrogate pair D83D DE00 and U+FFFD is FFFD: by code unit the emoji sorts first, by UTF-8 byte last.
    const query = joined({ from: { name: "A", alias: "a" }, columns: [a("s")], orderBy: [a("s")] });
    expect(await run({ A: [{ s: "�" }, { s: "\u{1F600}" }] }, query)).toEqual([{ s: "\u{1F600}" }, { s: "�" }]);
  });
});

describe("conditions built by hand", () => {
  const filters = [
    { field: { field: "n", source: "a" }, operator: ">=" as const, value: 10 },
    { left: { kind: "field" as const, field: { field: "d", source: "a" } }, operator: "==" as const, right: { kind: "literal" as const, value: 1 } },
  ];
  const base: JoinedDTQLQuery = { kind: "joined-dtql", from: { name: "A", alias: "a", joins: [] }, filters, orders: [{ field: { field: "id", source: "a" }, direction: "asc" }], columns: [{ expression: { kind: "field", field: { field: "id", source: "a" } } }] };

  it("holds every top-level filter, and serialises several as one `and` group that parses back to the same rows", async () => {
    const expected = await run({ A: aData }, base);
    expect(expected).toEqual([{ id: 1 }, { id: 2 }]);
    const document = serializeJoinedDTQL(base);
    expect(document.where).toEqual({
      and: [
        { op: ">=", left: { field: "n", source: "a" }, right: { value: 10 } },
        { op: "==", left: { field: "d", source: "a" }, right: { value: 1 } },
      ],
    });
    expect(await run({ A: aData }, joined(document))).toEqual(expected);
  });

  it("refuses a hand-built query whose condition names an unknown alias, at any depth", async () => {
    const group: JoinedDTQLQuery = { ...base, filters: [{ kind: "or", conditions: [{ kind: "and", conditions: [{ left: { kind: "field", field: { field: "n", source: "zz" } }, operator: "==", right: { kind: "literal", value: 1 } }] }] }] };
    await expect(run({ A: aData }, group)).rejects.toThrow("join_scope at where[0].or[0].and[0].left.source: unknown alias zz");
  });

  it("evaluates a hand-built In whose right side is a literal as the error Go reports", async () => {
    const bad: JoinedDTQLQuery = { ...base, filters: [{ field: { field: "n", source: "a" }, operator: "in", value: 10 }] };
    await expect(run({ A: aData }, bad)).rejects.toThrow("IN requires an array");
  });

  it("names an unaliased aggregate by its text when the query was built by hand", async () => {
    const query: JoinedDTQLQuery = { ...base, filters: [], orders: [], columns: [
      { expression: { kind: "aggregate", function: "sum", args: [{ kind: "field", field: { field: "n", source: "a" } }] } },
      { expression: { kind: "aggregate", function: "count", distinct: true, args: [{ kind: "field", field: { field: "d", source: "a" } }] } },
      { expression: { kind: "aggregate", function: "count", args: [{ kind: "star" }] } },
    ] };
    expect(await run({ A: aData }, query)).toEqual([{ "SUM(a.n)": 35, "COUNT(DISTINCT a.d)": 2, "COUNT(*)": 3 }]);
  });
});
