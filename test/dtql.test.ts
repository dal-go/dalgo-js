import { describe, expect, it } from "vitest";
import { parseDTQL, type DTQLSchema } from "../src/index.js";

const schema: DTQLSchema = {
  tables: [
    { schema: "main", name: "Invoice", fields: ["InvoiceId", "BillingCountry", "InvoiceDate"] },
    { schema: "archive", name: "Invoice", fields: ["InvoiceId"] },
    { name: "Customer", fields: ["CustomerId", "City"] },
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
});
