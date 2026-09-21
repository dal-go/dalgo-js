import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isJoinedDTQLQuery, parseDTQL, serializeJoinedDTQL, stringifyJoinedDTQL, type DTQLSchema } from "../src/index.js";

const schema: DTQLSchema = {
  tables: [
    { schema: "main", name: "Invoice", fields: ["InvoiceId", "BillingCountry", "InvoiceDate", "CustomerId"] },
    { schema: "archive", name: "Invoice", fields: ["InvoiceId"] },
    { schema: "main", name: "Customer", fields: ["CustomerId", "City", "FirstName", "SupportRepId"] },
    { schema: "main", name: "Employee", fields: ["EmployeeId", "FirstName"] },
    { name: "A", fields: ["id"] },
    { name: "B", fields: ["id", "aId"] },
    { name: "C", fields: ["id", "bId", "aId"] },
    { name: "D", fields: ["id", "cId", "aId"] },
  ],
};

describe("parseDTQL", () => {
  it("parses canonical YAML into a schema-qualified DALgo query", () => {
    const query = parseDTQL(
      `from:\n  schema: main\n  name: Invoice\nwhere:\n  op: ==\n  left:\n    field: BillingCountry\n  right:\n    value: Brazil\norderBy:\n  - field: InvoiceDate\n    desc: true\nlimit: 30`,
      schema,
    );

    expect(query).toEqual({
      source: { kind: "collection", name: "main.Invoice" },
      filters: [{ field: "BillingCountry", operator: "==", value: "Brazil" }],
      orders: [{ field: "InvoiceDate", direction: "desc" }],
      limit: 30,
    });
  });

  it("accepts JSON and object input", () => {
    const input = { from: { name: "Customer" }, orderBy: [{ field: "CustomerId" }], limit: 2 };
    expect(parseDTQL(JSON.stringify(input), schema)).toEqual(parseDTQL(input, schema));
  });

  it("uses canonical In values and portable scalar values", () => {
    expect(parseDTQL({ from: { name: "Customer" }, where: { op: "In", left: { field: "City" }, right: { values: ["Prague"] } }, limit: 1 }, schema).filters)
      .toEqual([{ field: "City", operator: "in", value: ["Prague"] }]);
    expect(() => parseDTQL({ from: { name: "Customer" }, where: { op: "In", left: { field: "City" }, right: { value: ["Prague"] } }, limit: 1 }, schema)).toThrow("unsupported where.right key");
    expect(() => parseDTQL({ from: { name: "Customer" }, where: { op: "==", left: { field: "City" }, right: { value: ["Prague"] } }, limit: 1 }, schema)).toThrow("portable scalar");
  });

  it("rejects unbounded and unsupported DTQL before execution", () => {
    expect(() => parseDTQL({ from: { name: "Customer" } }, schema)).toThrow("limit");
    expect(() => parseDTQL({ from: { name: "Invoice" }, limit: 1 }, schema)).toThrow("ambiguous table");
    expect(() => parseDTQL({ from: { schema: "main", name: "Invoice" }, orderBy: [{ field: "Nope" }], limit: 1 }, schema)).toThrow("unknown field");
    expect(() => parseDTQL({ from: { name: "Customer" }, joins: [], limit: 1 }, schema)).toThrow("unsupported DTQL action key");
    expect(() => parseDTQL({ from: { name: "Customer" }, where: { op: "contains", left: { field: "City" }, right: { value: "a" } }, limit: 1 }, schema)).toThrow("unsupported where operator");
    expect(() => parseDTQL("from:\n  name: [\nlimit: 1", schema)).toThrow("invalid DTQL YAML");
    expect(() => parseDTQL("from: {name: Customer}\nlimit: 1\n---\nfrom: {name: Customer}\nlimit: 1", schema)).toThrow("multiple documents");
    expect(() => parseDTQL({ from: { name: "Customer" }, limit: 1001 }, schema)).toThrow("must not exceed 1000");
  });

  it("parses the shared nested Chinook fixture into a join-only execution model", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in shared YAML fixture at runtime.
    const fixture = readFileSync(new URL("./testdata/joins/chinook-nested.dtql.yaml", import.meta.url), "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Vitest's Node runtime provides the checked-in fixture digest.
    expect(createHash("sha256").update(fixture).digest("hex")).toBe("2eeef93ffb02a4272f06f6ab909b2db4cbbb9a2a1df280ae4c47851534f583b3");
    const query = parseDTQL(fixture, schema);

    expect(isJoinedDTQLQuery(query)).toBe(true);
    if (!isJoinedDTQLQuery(query)) throw new Error("expected joined DTQL query");
    expect("source" in query).toBe(false);
    expect(query.from).toMatchObject({
      schema: "main",
      name: "Invoice",
      alias: "i",
      joins: [{
        type: "inner",
        from: {
          schema: "main",
          name: "Customer",
          alias: "c",
          joins: [{ type: "left", from: { name: "Employee", alias: "e" } }],
        },
      }],
    });
    expect(query.from.joins[0]?.on).toEqual([{ left: { field: "CustomerId", source: "i" }, operator: "==", right: { field: "CustomerId", source: "c" } }]);
    expect(query.filters).toEqual([{ field: { field: "CustomerId", source: "c" }, operator: ">=", value: 10 }]);
    expect(query.columns).toEqual([
      { expression: { kind: "field", field: { field: "InvoiceId", source: "i" } }, as: "invoice_id" },
      { expression: { kind: "field", field: { field: "FirstName", source: "c" } }, as: "customer" },
      { expression: { kind: "field", field: { field: "FirstName", source: "e" } }, as: "employee" },
    ]);
    const serialized = serializeJoinedDTQL(query);
    expect(serialized.from).toHaveProperty("alias", "i");
    expect(JSON.stringify(serialized)).toContain('"op":"=="');
    expect(JSON.stringify(serialized)).not.toContain('"type":"inner"');
    expect(parseDTQL(JSON.stringify(serialized), schema)).toEqual(query);
    expect(parseDTQL(stringifyJoinedDTQL(query), schema)).toEqual(query);
  });

  it("pins every copied canonical JOIN fixture to the committed SHA-256 manifest", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in manifest at runtime.
    const manifestText: string = readFileSync(new URL("./testdata/joins/manifest.json", import.meta.url), "utf8");
    const manifest = JSON.parse(manifestText) as {
      readonly sourceCommit: string;
      readonly files: Readonly<Record<string, string>>;
    };
    expect(manifest.sourceCommit).toBe("d393914bf9f9fe4a09fbba3188219e24f86ea284");
    for (const [name, expected] of Object.entries(manifest.files)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in canonical fixture at runtime.
      const fixture = readFileSync(new URL(`./testdata/joins/${name}`, import.meta.url), "utf8");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Vitest's Node runtime provides the checked-in fixture digest.
      expect(createHash("sha256").update(fixture).digest("hex")).toBe(expected);
    }
  });

  it("validates ordered nested scopes and canonicalizes aliases and equality", () => {
    const query = parseDTQL({
      from: {
        name: "A", as: "a", joins: [
          { from: { name: "B", as: "b" }, on: [{ left: { field: "id", source: "a" }, op: "eq", right: { field: "aId", source: "b" } }] },
          { from: { name: "C", as: "c", joins: [{ from: { name: "D", as: "d" }, on: [{ left: { field: "aId", source: "d" }, op: "==", right: { field: "id", source: "a" } }] }] }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "bId", source: "c" } }] },
        ],
      },
      limit: 1,
    }, schema);
    expect(isJoinedDTQLQuery(query)).toBe(true);
    if (!isJoinedDTQLQuery(query)) throw new Error("expected joined DTQL query");
    expect(query.from.alias).toBe("a");
    expect(query.from.joins[0]?.type).toBe("inner");
    expect(query.from.joins[0]?.on[0]?.operator).toBe("==");
  });

  it("accepts same-scope ON predicates for bounded generic evaluation", () => {
    expect(() => parseDTQL({
      from: { name: "A", as: "a", joins: [{ from: { name: "B", as: "b" }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      limit: 1,
    }, schema)).not.toThrow();
  });

  it("resolves an unqualified joined field only when schema proves one owner", () => {
    const query = parseDTQL({
      from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      where: { op: "==", left: { field: "aId" }, right: { value: 1 } },
      columns: [{ field: "aId", as: "only_b" }],
      limit: 1,
    }, schema);
    expect(isJoinedDTQLQuery(query)).toBe(true);
    if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
    expect(query.filters[0]?.field).toEqual({ field: "aId", source: "b" });
    expect(query.columns?.[0]).toEqual({ expression: { kind: "field", field: { field: "aId", source: "b" } }, as: "only_b" });
    expect(() => parseDTQL({
      from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      columns: [{ field: "id", as: "ambiguous" }],
      limit: 1,
    }, schema)).toThrow("ambiguous field id");
  });

  it("matches the shared unknown and forward-alias diagnostic paths", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- these checked-in fixtures are shared with Go.
    const forward = readFileSync(new URL("./testdata/joins/forward-alias.dtql.yaml", import.meta.url), "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- these checked-in fixtures are shared with Go.
    const unknown = readFileSync(new URL("./testdata/joins/unknown-alias.dtql.yaml", import.meta.url), "utf8");
    expect(() => parseDTQL(forward, schema)).toThrow("join_scope at from.joins[0].on[0].right.source");
    expect(() => parseDTQL(unknown, schema)).toThrow("join_scope at from.joins[0].on[0].left.source");
  });

  it("round-trips Go-compatible aggregate, group, having, and offset forms", () => {
    const query = parseDTQL({
      from: { name: "A", alias: "a" },
      groupBy: [{ field: "id", source: "a" }],
      having: { op: ">", left: { aggregate: { function: "count", args: [{ star: true }] } }, right: { value: 0 } },
      columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "total" }],
      offset: 2,
      limit: 5,
    }, schema);
    expect(isJoinedDTQLQuery(query)).toBe(true);
    if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
    expect(serializeJoinedDTQL(query)).toMatchObject({
      offset: 2,
      columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "total" }],
    });
    expect(parseDTQL(JSON.stringify(serializeJoinedDTQL(query)), schema)).toEqual(query);
  });

  it("rejects malformed, cyclic, forward, unknown, and duplicate join references", () => {
    const join = { from: { name: "B", as: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] };
    expect(() => parseDTQL({ from: { name: "A", as: "a", joins: [{ ...join, on: [{ left: { field: "id", source: "c" }, op: "==", right: { field: "aId", source: "b" } }] }, { from: { name: "C", as: "c" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "c" } }] }] }, limit: 1 }, schema)).toThrow("join_scope at from.joins[0].on[0].left");
    expect(() => parseDTQL({ from: { name: "A", as: "a", joins: [{ from: { name: "B", as: "a" }, on: join.on }] }, limit: 1 }, schema)).toThrow("duplicate alias a");
    expect(() => parseDTQL({ from: { name: "A", as: "a", joins: [{ from: { name: "B", as: "b" }, on: [{ left: { field: "missing", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] }, limit: 1 }, schema)).toThrow("join_field");
    expect(() => parseDTQL({ from: { name: "A", joins: [{ from: { name: "B" }, on: [] }] }, limit: 1 }, schema)).toThrow("join_shape at from.joins[0].on");
    expect(() => parseDTQL({ from: { name: "A", joins: [{ ...join, type: "right" }] }, limit: 1 }, schema)).toThrow("join_type at from.joins[0].type");
    expect(() => parseDTQL({ from: { name: "A", joins: [{ ...join, on: [{ ...join.on[0], op: "ne" }] }] }, limit: 1 }, schema)).toThrow("join_operator at from.joins[0].on[0].op");

    const cyclic: { name: string; joins: unknown[] } = { name: "A", joins: [] };
    cyclic.joins.push({ from: cyclic, on: [{ left: { field: "id", source: "A" }, op: "==", right: { field: "id", source: "A" } }] });
    expect(() => parseDTQL({ from: cyclic, limit: 1 }, schema)).toThrow("join_cycle at from.joins[0].from");
  });
});
