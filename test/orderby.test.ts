import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  executeJoinedDTQLQuery,
  isJoinedDTQLQuery,
  key,
  parseDTQL,
  serializeJoinedDTQL,
  stringifyJoinedDTQL,
  type DTQLSchema,
  type ExistingRecord,
  type JoinedDTQLQuery,
  type QueryExecutor,
  type StructuredQuery,
} from "../src/index.js";

type Data = Record<string, unknown>;

const schema: DTQLSchema = {
  tables: [
    { database: "chinook", name: "Invoice", fields: ["InvoiceId", "BillingCountry", "Total"] },
    { database: "geo", name: "country_aliases", fields: ["alias", "country"] },
    { database: "geo", name: "population_wb", fields: ["country", "year", "population"] },
    { name: "A", fields: ["id", "n"] },
    { name: "B", fields: ["id", "aId"] },
  ],
};

class MemoryExecutor implements QueryExecutor {
  public constructor(private readonly tables: Readonly<Record<string, readonly ExistingRecord<Data>[]>>) {}

  public query<T>(query: StructuredQuery<T>): Promise<{ readonly records: readonly ExistingRecord<T>[] }> {
    return Promise.resolve({ records: (this.tables[query.source.name] ?? []) as readonly ExistingRecord<T>[] });
  }
}

function record(collection: string, id: string, data: Data): ExistingRecord<Data> {
  return { key: key(collection, id), exists: true, data };
}

function joined(input: unknown): JoinedDTQLQuery {
  const query = parseDTQL(input, schema);
  if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
  return query;
}

function perCapitaYaml(): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in fixture at runtime.
  const text: string = readFileSync(new URL("./testdata/orderby/chinook-sales-per-capita.dtql.yaml", import.meta.url), "utf8");
  return text;
}

const perCapitaOrder = {
  binary: {
    op: "*",
    left: { binary: { op: "/", left: { aggregate: { function: "sum", args: [{ field: "Total", source: "i" }] } }, right: { field: "population", source: "p" } } },
    right: { value: 1000000 },
  },
};

describe("expression orderBy keys (parity with the Go DTQL engine)", () => {
  describe("parsing and serialisation", () => {
    it("parses a binary key over an aggregate and keeps field keys in their existing shape", () => {
      const query = joined({
        from: { name: "A", alias: "a" },
        groupBy: [{ field: "id", source: "a" }],
        columns: [{ field: "id", source: "a" }, { aggregate: { function: "count", args: [{ star: true }] }, as: "n" }],
        orderBy: [
          { aggregate: { function: "count", args: [{ star: true }] }, desc: true },
          { binary: { op: "+", left: { field: "id", source: "a" }, right: { value: 1 } } },
          { field: "id", source: "a" },
        ],
      });
      expect(query.orders).toEqual([
        { expression: { kind: "aggregate", function: "count", args: [{ kind: "star" }] }, direction: "desc" },
        { expression: { kind: "binary", operator: "+", left: { kind: "field", field: { field: "id", source: "a" } }, right: { kind: "literal", value: 1 } }, direction: "asc" },
        { field: { field: "id", source: "a" }, direction: "asc" },
      ]);
    });

    it("round-trips expression keys losslessly through object, JSON and YAML forms", () => {
      const fixture = perCapitaYaml();
      const query = parseDTQL(fixture, schema);
      if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
      expect(query.orders).toHaveLength(1);
      const serialized = serializeJoinedDTQL(query);
      expect(serialized.orderBy).toEqual([{ ...perCapitaOrder, desc: true }]);
      expect(parseDTQL(JSON.stringify(serialized), schema)).toEqual(query);
      expect(parseDTQL(stringifyJoinedDTQL(query), schema)).toEqual(query);
    });

    it("round-trips a mixed field and expression key list in order", () => {
      const document = {
        from: { name: "A", alias: "a" },
        orderBy: [{ field: "n", source: "a", desc: true }, { binary: { op: "-", left: { value: 0 }, right: { field: "id", source: "a" } } }],
      };
      const query = joined(document);
      expect(serializeJoinedDTQL(query).orderBy).toEqual([
        { field: "n", source: "a", desc: true },
        { binary: { op: "-", left: { value: 0 }, right: { field: "id", source: "a" } } },
      ]);
      expect(parseDTQL(stringifyJoinedDTQL(query), schema)).toEqual(query);
    });

    it("still rejects malformed order keys with a precise location", () => {
      const base = { from: { name: "A", alias: "a" } };
      expect(() => joined({ ...base, orderBy: [{ field: "id", source: "a", binary: {} }] })).toThrow("unsupported orderBy[0] key binary");
      expect(() => joined({ ...base, orderBy: [{ binary: { op: "%", left: { value: 1 }, right: { value: 2 } } }] })).toThrow("orderBy[0].binary.op");
      expect(() => joined({ ...base, orderBy: [{ binary: { op: "+", left: { value: 1 }, right: { value: 2 } }, desc: "yes" }] })).toThrow("orderBy[0].desc must be boolean");
      expect(() => joined({ ...base, orderBy: [{ binary: { op: "+", left: { value: 1 }, right: { field: "id", source: "nope" } } }] })).toThrow("unknown alias nope");
      expect(() => joined({ ...base, orderBy: [{ binary: { op: "+", left: { value: 1 }, right: { field: "missing", source: "a" } } }] })).toThrow("unknown field a.missing");
      expect(() => joined({ ...base, orderBy: [{ desc: true }] })).toThrow("orderBy[0]");
    });

    it("rejects expression keys on the legacy single-source model", () => {
      expect(() => parseDTQL({ from: { name: "A" }, orderBy: [{ binary: { op: "+", left: { field: "id" }, right: { value: 1 } } }], limit: 1 }, schema)).toThrow("orderBy expressions require an aliased or joined relation model");
    });
  });

  describe("execution", () => {
    const invoices = [
      record("Invoice", "1", { InvoiceId: 1, BillingCountry: "Brazil", Total: 5 }),
      record("Invoice", "2", { InvoiceId: 2, BillingCountry: "USA", Total: 10 }),
      record("Invoice", "3", { InvoiceId: 3, BillingCountry: "Chile", Total: 8 }),
      record("Invoice", "4", { InvoiceId: 4, BillingCountry: "Malta", Total: 10 }),
      record("Invoice", "5", { InvoiceId: 5, BillingCountry: "Iceland", Total: 4 }),
      record("Invoice", "6", { InvoiceId: 6, BillingCountry: "USA", Total: 20 }),
      record("Invoice", "7", { InvoiceId: 7, BillingCountry: "Atlantis", Total: 99 }),
      record("Invoice", "8", { InvoiceId: 8, BillingCountry: "Peru", Total: 5 }),
    ];
    const aliases = ["Brazil", "USA", "Chile", "Malta", "Iceland"].map((name, index) => record("country_aliases", String(index), { alias: name, country: name.slice(0, 3).toUpperCase() }));
    const populations = [
      record("population_wb", "BRA", { country: "BRA", year: 2023, population: 200 }),
      record("population_wb", "USA", { country: "USA", year: 2023, population: 300 }),
      record("population_wb", "CHI", { country: "CHI", year: 2023, population: 0 }),
      record("population_wb", "MAL", { country: "MAL", year: 2023, population: 100 }),
      record("population_wb", "ICE", { country: "ICE", year: 2023, population: 4 }),
    ];
    const executor = new MemoryExecutor({ Invoice: invoices, country_aliases: aliases, population_wb: populations });
    const withExecutor = { resolveExecutor: () => executor };

    function perCapita(desc: boolean | undefined): JoinedDTQLQuery {
      const fixture = perCapitaYaml();
      const query = parseDTQL(fixture, schema);
      if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
      const [order] = query.orders;
      if (order === undefined) throw new Error("expected an order key");
      return { ...query, orders: [{ ...order, direction: desc === false ? "asc" : "desc" }] };
    }

    it("runs the saved per-capita query: desc order, tie keeps first-seen group order, NULL (zero population) sorts last", async () => {
      const result = await executeJoinedDTQLQuery(executor, perCapita(true), withExecutor);
      expect(result.records.map((row) => row.data.country)).toEqual(["Iceland", "USA", "Malta", "Brazil", "Chile"]);
      expect(result.records.map((row) => row.data.salesPerMillion)).toEqual([1_000_000, 100_000, 100_000, 25_000, null]);
    });

    it("sorts the same expression ascending with NULL first and the tie still in first-seen order", async () => {
      const result = await executeJoinedDTQLQuery(executor, perCapita(false), withExecutor);
      expect(result.records.map((row) => row.data.country)).toEqual(["Chile", "Brazil", "USA", "Malta", "Iceland"]);
    });

    it("applies offset and limit after ordering by the expression", async () => {
      const result = await executeJoinedDTQLQuery(executor, { ...perCapita(true), offset: 1, limit: 2 }, withExecutor);
      expect(result.records.map((row) => row.data.country)).toEqual(["USA", "Malta"]);
    });

    it("orders by an aggregate that is not projected, with a field key breaking the Brazil/Peru tie", async () => {
      const query = joined({
        from: { database: "chinook", name: "Invoice", alias: "i" },
        groupBy: [{ field: "BillingCountry", source: "i" }],
        columns: [{ field: "BillingCountry", source: "i", as: "country" }],
        orderBy: [
          { aggregate: { function: "sum", args: [{ field: "Total", source: "i" }] }, desc: true },
          { field: "BillingCountry", source: "i" },
        ],
      });
      const result = await executeJoinedDTQLQuery(executor, query, withExecutor);
      expect(result.records.map((row) => row.data.country)).toEqual(["Atlantis", "USA", "Malta", "Chile", "Brazil", "Peru", "Iceland"]);
    });

    it("evaluates an expression key over plain (ungrouped) rows, nested join included", async () => {
      const query = joined({
        from: {
          database: "geo", name: "country_aliases", alias: "a",
          joins: [{ from: { database: "geo", name: "population_wb", alias: "p" }, on: [{ left: { field: "country", source: "a" }, op: "==", right: { field: "country", source: "p" } }] }],
        },
        columns: [{ field: "alias", source: "a", as: "country" }],
        orderBy: [{ binary: { op: "-", left: { value: 0 }, right: { field: "population", source: "p" } } }],
      });
      const result = await executeJoinedDTQLQuery(executor, query, withExecutor);
      expect(result.records.map((row) => row.data.country)).toEqual(["USA", "Brazil", "Malta", "Iceland", "Chile"]);
    });

    it("keeps equal keys in input order for a constant expression (stable sort)", async () => {
      const query = joined({
        from: { name: "A", alias: "a" },
        columns: [{ field: "id", source: "a" }],
        orderBy: [{ value: 1, desc: true }],
      });
      const rows = ["x", "y", "z", "w"].map((id) => record("A", id, { id }));
      const result = await executeJoinedDTQLQuery(new MemoryExecutor({ A: rows }), query);
      expect(result.records.map((row) => row.data.id)).toEqual(["x", "y", "z", "w"]);
    });

    it("treats an aggregate-only order key as aggregation, like the Go engine", async () => {
      const query = joined({
        from: { name: "A", alias: "a" },
        orderBy: [{ aggregate: { function: "count", args: [{ star: true }] } }],
      });
      const rows = ["x", "y"].map((id) => record("A", id, { id }));
      const result = await executeJoinedDTQLQuery(new MemoryExecutor({ A: rows }), query);
      expect(result.records).toHaveLength(1);
    });

    it("rejects an expression key naming an unknown alias before scanning", async () => {
      const query: JoinedDTQLQuery = {
        ...joined({ from: { name: "A", alias: "a" } }),
        orders: [{ expression: { kind: "field", field: { field: "id", source: "ghost" } }, direction: "asc" }],
      };
      await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), query)).rejects.toThrow("join_scope at orderBy[0].source");
    });

    it("sorts a streamed (scanPages) flat aggregate join by an expression key", async () => {
      const query = joined({
        from: {
          database: "chinook", name: "Invoice", alias: "i",
          joins: [{
            from: { database: "geo", name: "population_wb", alias: "p" },
            on: [{ left: { field: "BillingCountry", source: "i" }, op: "==", right: { field: "country", source: "p" } }],
          }],
        },
        groupBy: [{ field: "country", source: "p" }, { field: "population", source: "p" }],
        columns: [
          { field: "country", source: "p", as: "country" },
          { aggregate: { function: "sum", args: [{ field: "Total", source: "i" }] }, as: "total" },
        ],
        orderBy: [{ binary: { op: "/", left: { aggregate: { function: "sum", args: [{ field: "Total", source: "i" }] } }, right: { field: "population", source: "p" } }, desc: true }],
      });
      const result = await executeJoinedDTQLQuery(new MemoryExecutor({}), query, {
        scanPages: async function* (relation) {
          await Promise.resolve();
          if (relation.name === "population_wb") {
            yield { records: [
              record("population_wb", "1", { country: "A", population: 10 }),
              record("population_wb", "2", { country: "B", population: 1 }),
              record("population_wb", "3", { country: "C", population: 0 }),
            ] };
          } else {
            yield { records: [
              record("Invoice", "1", { BillingCountry: "A", Total: 5 }),
              record("Invoice", "2", { BillingCountry: "B", Total: 2 }),
              record("Invoice", "3", { BillingCountry: "C", Total: 9 }),
              record("Invoice", "4", { BillingCountry: "A", Total: 5 }),
            ] };
          }
        },
      });
      expect(result.records.map((row) => row.data.country)).toEqual(["B", "A", "C"]);
    });

    it("refuses expression keys in exact money mode instead of comparing decimal text", async () => {
      const query = joined({
        from: {
          database: "chinook", name: "Invoice", alias: "i",
          joins: [{
            from: { database: "geo", name: "population_wb", alias: "p" },
            on: [{ left: { field: "BillingCountry", source: "i" }, op: "==", right: { field: "country", source: "p" } }],
          }],
        },
        groupBy: [{ field: "country", source: "p" }],
        columns: [{ field: "country", source: "p" }, { aggregate: { function: "sum", args: [{ field: "Total", source: "i" }] }, as: "total" }],
        orderBy: [{ aggregate: { function: "sum", args: [{ field: "Total", source: "i" }] } }],
        money: { minorUnitScale: 2, divisionScale: 4, rounding: "halfEven" },
      });
      await expect(executeJoinedDTQLQuery(new MemoryExecutor({}), query, {
        scanPages: async function* () { await Promise.resolve(); yield { records: [] }; },
      })).rejects.toThrow("orderBy");
    });
  });
});
