import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isJoinedDTQLQuery, parseDTQL, type DTQLSchema } from "../src/index.js";

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
