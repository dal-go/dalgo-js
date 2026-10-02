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
    { database: "geo", name: "country_aliases", fields: ["alias", "country", "population"] },
    { database: "geo", name: "population_wb", fields: ["country", "year", "population"] },
    { name: "A", fields: ["id", "n", "d", "note"] },
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
      expect(() => joined({ ...base, orderBy: [{ desc: true }] })).toThrow("join_shape at orderBy[0]: expression must set exactly one form");
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
      // No columns and no group key: the single group projects an empty row, as in Go.
      expect(result.records.map((row) => row.data)).toEqual([{}]);
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
      })).rejects.toThrow("join_plan at orderBy: expression order keys are not supported in exact money mode");
    });
  });
});

describe("order keys, aliases and aggregate rules (parity with the Go DTQL engine)", () => {
  const sale = { from: { name: "A", alias: "a" }, groupBy: [{ field: "id", source: "a" }] };
  const count = { aggregate: { function: "count", args: [{ star: true }] } };
  const sumN = { aggregate: { function: "sum", args: [{ field: "n", source: "a" }] } };

  describe("unknown properties on an order key", () => {
    const withKey = (key: Record<string, unknown>): unknown => ({ ...sale, columns: [{ field: "id", source: "a" }], orderBy: [key] });

    it.each([
      ["descending: true", { ...count, descending: true }, "unsupported orderBy[0] key descending"],
      ["direction: desc", { ...count, direction: "desc" }, "unsupported orderBy[0] key direction"],
      ["as: x", { ...count, as: "x" }, "unsupported orderBy[0] key as"],
      ["a misspelt key beside a binary key", { binary: { op: "+", left: { value: 1 }, right: { value: 2 } }, dsc: true }, "unsupported orderBy[0] key dsc"],
      ["a literal key with a stray property", { value: 1, desc: true, extra: 1 }, "unsupported orderBy[0] key extra"],
    ])("rejects %s at parse, naming the key and its position", (_label, key, message) => {
      expect(() => joined(withKey(key))).toThrow(message);
    });

    it("rejects source without field", () => {
      expect(() => joined(withKey({ ...count, source: "a" }))).toThrow("orderBy[0]: source is valid only with field");
    });

    it("rejects star and parameter keys at parse instead of failing at run time", () => {
      expect(() => joined(withKey({ star: true }))).toThrow("join_shape at orderBy[0]: star is only valid as an aggregate argument");
      expect(() => joined(withKey({ param: "p" }))).toThrow("join_shape at orderBy[0]: parameters are not bound in an order key");
    });

    it("locates a stray property inside a nested expression", () => {
      expect(() => joined(withKey({ binary: { op: "+", left: { value: 1, extra: true }, right: { value: 2 } } }))).toThrow("unsupported orderBy[0].binary.left key extra");
      expect(() => joined(withKey({ aggregate: { function: "sum", args: [{ field: "n", source: "a", as: "x" }] } }))).toThrow("unsupported orderBy[0].aggregate.args[0] key as");
    });

    it("keeps a column's own `as` and rejects it on other expression positions", () => {
      expect(joined({ ...sale, columns: [{ field: "id", source: "a", as: "ident" }] }).columns).toHaveLength(1);
      expect(() => joined({ ...sale, columns: [{ field: "id", source: "a", extra: 1 }] })).toThrow("unsupported columns[0] key extra");
      expect(() => joined({ ...sale, columns: [{ value: 1, as: "one", extra: 1 }] })).toThrow("unsupported columns[0] key extra");
    });
  });

  describe("grouped ORDER BY validation", () => {
    const grouped = (orderBy: unknown, extra: Record<string, unknown> = {}): unknown => ({ ...sale, columns: [{ field: "id", source: "a" }], orderBy, ...extra });

    it.each([
      ["a field that is not a group key", [{ field: "n", source: "a" }], "join_aggregate at orderBy[0]: a.n is neither an aggregate, SELECT alias, nor GROUP BY expression"],
      ["an expression over a non-grouped field", [{ binary: { op: "-", left: { value: 0 }, right: { field: "n", source: "a" } } }], "join_aggregate at orderBy[0].binary.right: a.n is neither an aggregate"],
      ["a nested aggregate", [{ aggregate: { function: "sum", args: [sumN] } }], "join_aggregate at orderBy[0]: nested aggregates are not supported"],
      ["sum(*)", [{ aggregate: { function: "sum", args: [{ star: true }] } }], "join_aggregate at orderBy[0]: SUM(*) is not supported"],
      ["count(distinct *)", [{ aggregate: { function: "count", distinct: true, args: [{ star: true }] } }], "COUNT(DISTINCT *) is not supported"],
      ["min(distinct x)", [{ aggregate: { function: "min", distinct: true, args: [{ field: "n", source: "a" }] } }], "DISTINCT is not supported for MIN"],
      ["a two-argument aggregate", [{ aggregate: { function: "sum", args: [{ field: "n", source: "a" }, { value: 1 }] } }], "SUM requires exactly one argument"],
      ["a values key", [{ values: [1, 2] }], "join_aggregate at orderBy[0]: (1,2) is neither an aggregate"],
    ])("rejects %s at parse", (_label, orderBy, message) => {
      expect(() => joined(grouped(orderBy))).toThrow(message);
    });

    it("accepts group keys, aggregates, literals and arithmetic over them", () => {
      const query = joined(grouped([
        { field: "id", source: "a" },
        { binary: { op: "*", left: sumN, right: { field: "id", source: "a" } }, desc: true },
        { value: 1 },
      ]));
      expect(query.orders).toHaveLength(3);
    });

    it("rejects a plain column beside an aggregate-only key", () => {
      expect(() => joined({ from: { name: "A", alias: "a" }, columns: [{ field: "id", source: "a" }], orderBy: [count] }))
        .toThrow("join_aggregate at columns[0]: a.id is neither aggregated nor present in GROUP BY");
    });

    it("rejects the other aggregate column mistakes the Go engine rejects", () => {
      expect(() => joined({ ...sale, columns: [{ field: "n", source: "a" }, { ...count, as: "c" }] })).toThrow("join_aggregate at columns[0]: a.n is neither aggregated nor present in GROUP BY");
      expect(() => joined({ ...sale, columns: [{ value: 1, as: "one" }] })).toThrow("join_aggregate at columns[0]: 1 is neither aggregated nor present in GROUP BY");
      expect(() => joined({ ...sale, columns: [{ wildcard: { source: "a", exclude: ["id"] } }] })).toThrow("join_aggregate at columns[0]: a wildcard cannot be selected from an aggregate query");
      expect(() => joined({ from: { name: "A", alias: "a" }, groupBy: [{ field: "id", source: "a" }], columns: [{ field: "id", source: "a" }], having: { left: { field: "n", source: "a" }, op: ">", right: { value: 1 } } }))
        .toThrow("join_aggregate at having.left: a.n is neither an aggregate");
    });

    it("does not validate a query without aggregation", () => {
      expect(joined({ from: { name: "A", alias: "a" }, columns: [{ field: "id", source: "a" }, { field: "n", source: "a" }], orderBy: [{ field: "n", source: "a" }, { values: [1] }] }).orders).toHaveLength(2);
    });
  });

  describe("SELECT aliases in ORDER BY and HAVING", () => {
    const aliased = {
      from: { name: "A", alias: "a" },
      groupBy: [{ field: "id", source: "a" }],
      columns: [{ field: "id", source: "a", as: "who" }, { ...count, as: "purchases" }],
    };

    it("resolves an alias key to the aggregate it names, in both directions", () => {
      const query = joined({ ...aliased, orderBy: [{ field: "purchases", desc: true }, { field: "who" }] });
      expect(query.orders).toEqual([
        { expression: { kind: "aggregate", function: "count", args: [{ kind: "star" }] }, direction: "desc" },
        { field: { field: "id", source: "a" }, direction: "asc" },
      ]);
    });

    it("resolves aliases in HAVING, on either side", () => {
      const query = joined({ ...aliased, having: { left: { field: "purchases" }, op: ">", right: { value: 1 } } });
      expect(query.having).toEqual({ left: { kind: "aggregate", function: "count", args: [{ kind: "star" }] }, operator: ">", right: { kind: "literal", value: 1 } });
      expect(joined({ ...aliased, having: { left: { value: 1 }, op: "<", right: { field: "purchases" } } }).having?.right).toEqual({ kind: "aggregate", function: "count", args: [{ kind: "star" }] });
    });

    it("serialises a resolved alias as the expression it names, and that round-trips", () => {
      const query = joined({ ...aliased, orderBy: [{ field: "purchases", desc: true }] });
      expect(serializeJoinedDTQL(query).orderBy).toEqual([{ ...count, desc: true }]);
      expect(parseDTQL(stringifyJoinedDTQL(query), schema)).toEqual(query);
    });

    it("names the unknown alias, and does not accept an alias with a source", () => {
      expect(() => joined({ ...aliased, orderBy: [{ field: "nope" }] })).toThrow("orderBy[0]: unknown field nope");
      expect(() => joined({ ...aliased, orderBy: [{ field: "purchases", source: "a" }] })).toThrow("unknown field a.purchases");
    });

    it("sorts and filters by alias", async () => {
      const rows = [["x", 1], ["y", 2], ["x", 3], ["z", 4], ["y", 5], ["y", 6]].map(([id, n], index) => record("A", String(index), { id, n }));
      const executor = new MemoryExecutor({ A: rows });
      const run = async (extra: Record<string, unknown>): Promise<unknown[]> =>
        (await executeJoinedDTQLQuery(executor, joined({ ...aliased, ...extra }))).records.map((row) => row.data);
      expect(await run({ orderBy: [{ field: "purchases", desc: true }, { field: "who", desc: true }] })).toEqual([
        { who: "y", purchases: 3 }, { who: "x", purchases: 2 }, { who: "z", purchases: 1 },
      ]);
      expect(await run({ having: { left: { field: "purchases" }, op: ">", right: { value: 1 } }, orderBy: [{ field: "who" }] })).toEqual([
        { who: "x", purchases: 2 }, { who: "y", purchases: 3 },
      ]);
    });
  });

  describe("HAVING over any expression", () => {
    const rows = [["a", 10, 5], ["b", 9, 0], ["c", 3, 3], ["d", null, 4]].map(([id, n, d], index) => record("A", String(index), { id, n, d }));
    const havingSchema: DTQLSchema = { tables: [{ name: "A", fields: ["id", "n", "d"] }] };
    const run = async (having: unknown, orderBy: unknown[] = []): Promise<unknown[]> => {
      const query = parseDTQL({
        from: { name: "A", alias: "a" },
        groupBy: [{ field: "id", source: "a" }],
        columns: [{ field: "id", source: "a" }],
        having,
        orderBy: [...orderBy, { field: "id", source: "a" }],
      }, havingSchema);
      if (!isJoinedDTQLQuery(query)) throw new Error("expected joined query");
      return (await executeJoinedDTQLQuery(new MemoryExecutor({ A: rows }), query)).records.map((row) => row.data.id);
    };
    const ratio = { binary: { op: "/", left: { aggregate: { function: "sum", args: [{ field: "n", source: "a" }] } }, right: { aggregate: { function: "sum", args: [{ field: "d", source: "a" }] } } } };

    it("accepts a binary expression on the left or the right", async () => {
      expect(await run({ left: ratio, op: ">", right: { value: 0.5 } })).toEqual(["a", "c"]);
      expect(await run({ left: { value: 0.5 }, op: "<", right: ratio })).toEqual(["a", "c"]);
    });

    it("drops a null (division by zero, or a null input) from every ordering comparison", async () => {
      expect(await run({ left: ratio, op: "<", right: { value: 100 } })).toEqual(["a", "c"]);
      expect(await run({ left: ratio, op: ">=", right: { value: 0 } })).toEqual(["a", "c"]);
    });

    it("keeps `==` true for two nulls, like the Go engine", async () => {
      expect(await run({ left: ratio, op: "==", right: ratio })).toEqual(["a", "b", "c", "d"]);
    });

    it("rejects membership operators and the non-grouped fields it cannot evaluate", () => {
      expect(() => joined({ ...aliasedBase(), having: { left: ratio, op: "In", right: { values: [1] } } })).toThrow("unsupported having operator In");
      expect(() => joined({ ...aliasedBase(), having: { left: { star: true }, op: "==", right: { value: 1 } } })).toThrow("join_aggregate at having.left: * is neither an aggregate");
    });

    function aliasedBase(): Record<string, unknown> {
      return { from: { name: "A", alias: "a" }, groupBy: [{ field: "id", source: "a" }], columns: [{ field: "id", source: "a" }] };
    }
  });

  describe("arithmetic and ordering semantics", () => {
    const data = [
      record("A", "1", { id: 1, n: 4, d: 2, note: "x" }),
      record("A", "2", { id: 2, n: 3, d: 0, note: null }),
      record("A", "3", { id: 3, n: null, d: 1, note: 7 }),
      record("A", "4", { id: 4, n: 2, d: 4, note: true }),
      record("A", "5", { id: 5, n: 8, d: 2, note: "y" }),
    ];
    const run = async (document: Record<string, unknown>): Promise<unknown[]> =>
      (await executeJoinedDTQLQuery(new MemoryExecutor({ A: data }), joined({ from: { name: "A", alias: "a" }, ...document }))).records.map((row) => row.data);
    const field = (name: string): Record<string, unknown> => ({ field: name, source: "a" });
    const over = (op: string, left: unknown, right: unknown): Record<string, unknown> => ({ binary: { op, left, right } });

    it("division by zero is null in a column and as a key, and null sorts first ascending, last descending", async () => {
      const columns = [{ ...field("id") }, { ...over("/", field("n"), field("d")), as: "ratio" }];
      expect(await run({ columns, orderBy: [over("/", field("n"), field("d")), field("id")] })).toEqual([
        { id: 2, ratio: null }, { id: 3, ratio: null }, { id: 4, ratio: 0.5 }, { id: 1, ratio: 2 }, { id: 5, ratio: 4 },
      ]);
      expect(await run({ columns, orderBy: [{ ...over("/", field("n"), field("d")), desc: true }, field("id")] })).toEqual([
        { id: 5, ratio: 4 }, { id: 1, ratio: 2 }, { id: 4, ratio: 0.5 }, { id: 2, ratio: null }, { id: 3, ratio: null },
      ]);
    });

    it("a literal division by zero is null, never Infinity or an error", async () => {
      expect(await run({ columns: [{ ...over("/", { value: 1 }, { value: 0 }), as: "z" }, { ...over("/", { value: 0 }, { value: 5 }), as: "zero" }], limit: 1 })).toEqual([{ z: null, zero: 0 }]);
    });

    it("grouped division by zero is null in HAVING-free projection and ordering", async () => {
      const total = (name: string): Record<string, unknown> => ({ aggregate: { function: "sum", args: [field(name)] } });
      expect(await run({
        groupBy: [field("id")],
        columns: [field("id"), { ...over("/", total("n"), total("d")), as: "ratio" }],
        orderBy: [{ ...over("/", total("n"), total("d")), desc: true }, field("id")],
      })).toEqual([{ id: 5, ratio: 4 }, { id: 1, ratio: 2 }, { id: 4, ratio: 0.5 }, { id: 2, ratio: null }, { id: 3, ratio: null }]);
    });

    it("arithmetic on a non-numeric operand is null (it used to throw), and sorts first", async () => {
      expect(await run({ columns: [field("id"), { ...over("+", field("note"), { value: 1 }), as: "x" }], orderBy: [over("+", field("note"), { value: 1 }), { ...field("id"), desc: true }] })).toEqual([
        { id: 5, x: null }, { id: 4, x: null }, { id: 2, x: null }, { id: 1, x: null }, { id: 3, x: 8 },
      ]);
    });

    it("orders mixed types as booleans, then numbers, then strings, with null first", async () => {
      expect(await run({ columns: [field("id")], orderBy: [field("note")] })).toEqual([{ id: 2 }, { id: 4 }, { id: 3 }, { id: 1 }, { id: 5 }]);
      expect(await run({ columns: [field("id")], orderBy: [{ ...field("note"), desc: true }] })).toEqual([{ id: 5 }, { id: 1 }, { id: 3 }, { id: 4 }, { id: 2 }]);
    });

    it("min and max follow that order over mixed values", async () => {
      expect(await run({
        groupBy: [field("d")],
        columns: [field("d")],
        orderBy: [field("d")],
      })).toEqual([{ d: 0 }, { d: 1 }, { d: 2 }, { d: 4 }]);
      expect(await run({
        columns: [
          { aggregate: { function: "min", args: [field("note")] }, as: "lo" },
          { aggregate: { function: "max", args: [field("note")] }, as: "hi" },
        ],
      })).toEqual([{ lo: true, hi: "y" }]);
    });

    it("sum over an all-null group is null, not 0, and ignores non-numeric values", async () => {
      const result = await run({
        columns: [
          { aggregate: { function: "sum", args: [field("n")] }, as: "s" },
          { aggregate: { function: "sum", args: [field("note")] }, as: "notes" },
          { aggregate: { function: "avg", args: [field("note")] }, as: "mean" },
          { aggregate: { function: "count", args: [field("note")] }, as: "present" },
        ],
      });
      expect(result).toEqual([{ s: 17, notes: 7, mean: 7, present: 4 }]);
      const empty = await executeJoinedDTQLQuery(new MemoryExecutor({ A: [record("A", "1", { id: 1, n: null, note: "x" })] }), joined({
        from: { name: "A", alias: "a" },
        columns: [{ aggregate: { function: "sum", args: [field("n")] }, as: "s" }, { aggregate: { function: "sum", args: [field("note")] }, as: "t" }],
      }));
      expect(empty.records.map((row) => row.data)).toEqual([{ s: null, t: null }]);
    });

    it("FIRST and LAST keep a null value instead of skipping it", async () => {
      expect(await run({ columns: [{ aggregate: { function: "first", args: [field("note")] }, as: "f" }, { aggregate: { function: "last", args: [field("n")] }, as: "l" }] })).toEqual([{ f: "x", l: 8 }]);
      expect(await run({ where: { left: field("id"), op: ">=", right: { value: 2 } }, columns: [{ aggregate: { function: "first", args: [field("note")] }, as: "f" }] })).toEqual([{ f: null }]);
    });

    it("an aggregate-only key with no columns returns exactly one empty row", async () => {
      const result = await executeJoinedDTQLQuery(new MemoryExecutor({ A: data }), joined({ from: { name: "A", alias: "a" }, orderBy: [{ aggregate: { function: "count", args: [{ star: true }] } }] }));
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.data).toEqual({});
      expect(Object.keys(result.records[0]?.data ?? { present: true })).toEqual([]);
    });

    it("a grouped query without columns projects only its group keys", async () => {
      expect(await run({ groupBy: [field("d")], orderBy: [{ ...field("d"), desc: true }], limit: 2 })).toEqual([{ d: 4 }, { d: 2 }]);
    });

    it("locates the errors that remain, at the key or column that caused them", async () => {
      const huge = over("*", over("*", { value: 1e308 }, field("n")), { value: 100 });
      await expect(run({ columns: [field("id")], orderBy: [huge] })).rejects.toThrow("join_plan at orderBy[0].binary.left: arithmetic overflow");
      await expect(run({ columns: [field("id"), { ...huge, as: "big" }] })).rejects.toThrow("join_plan at columns[1].binary.left: arithmetic overflow");
      // A parameter column cannot be parsed, but a hand-built query can still carry one.
      const unbound: JoinedDTQLQuery = { ...joined({ from: { name: "A", alias: "a" } }), columns: [{ expression: { kind: "param", name: "p" }, as: "x" }] };
      await expect(executeJoinedDTQLQuery(new MemoryExecutor({ A: data }), unbound)).rejects.toThrow("join_plan at columns[0]: parameters are not bound by generic execution");
    });
  });

  describe("aliased single sources and WHERE", () => {
    const rows = [["r1", 1], ["r2", 2], ["r3", null], ["r4", 4]].map(([id, n]) => record("A", String(id), { id, n }));

    it("resolves unqualified fields on an aliased single source in where, columns and orderBy", async () => {
      const query = joined({
        from: { name: "A", alias: "a" },
        where: { op: ">=", left: { field: "n" }, right: { value: 2 } },
        columns: [{ field: "id" }],
        orderBy: [{ field: "n", desc: true }],
      });
      expect(query.filters).toEqual([{ field: { field: "n", source: "a" }, operator: ">=", value: 2 }]);
      const result = await executeJoinedDTQLQuery(new MemoryExecutor({ A: rows }), query);
      expect(result.records.map((row) => row.data)).toEqual([{ id: "r4" }, { id: "r2" }]);
    });

    it("an ordering comparison never matches a null value, whichever the operator", async () => {
      const run = async (op: string, value: number): Promise<unknown[]> =>
        (await executeJoinedDTQLQuery(new MemoryExecutor({ A: rows }), joined({ from: { name: "A", alias: "a" }, where: { op, left: { field: "n", source: "a" }, right: { value } }, columns: [{ field: "id", source: "a" }] }))).records.map((row) => row.data.id);
      expect(await run("<", 3)).toEqual(["r1", "r2"]);
      expect(await run("<=", 2)).toEqual(["r1", "r2"]);
      expect(await run(">", 0)).toEqual(["r1", "r2", "r4"]);
      expect(await run(">=", 0)).toEqual(["r1", "r2", "r4"]);
    });
  });

  describe("streaming (scanPages) flat aggregate joins", () => {
    const dimension = [
      record("country_aliases", "1", { alias: "Brazil", country: "BRA" }),
      record("country_aliases", "2", { alias: "USA", country: "USA" }),
      record("country_aliases", "3", { alias: "Chile", country: "CHI" }),
      record("country_aliases", "4", { alias: "Malta", country: "MAL" }),
    ];
    const facts = [
      record("Invoice", "1", { InvoiceId: 1, BillingCountry: "Brazil", Total: 5 }),
      record("Invoice", "2", { InvoiceId: 2, BillingCountry: "USA", Total: 10 }),
      record("Invoice", "3", { InvoiceId: 3, BillingCountry: "Chile", Total: 8 }),
      record("Invoice", "4", { InvoiceId: 4, BillingCountry: "Malta", Total: 10 }),
      record("Invoice", "5", { InvoiceId: 5, BillingCountry: "USA", Total: 20 }),
    ];
    const flat = { database: "chinook", name: "Invoice", alias: "i", joins: [{ from: { database: "geo", name: "country_aliases", alias: "a" }, on: [{ left: { field: "BillingCountry", source: "i" }, op: "==", right: { field: "alias", source: "a" } }] }] };
    const total = { aggregate: { function: "sum", args: [{ field: "Total", source: "i" }] } };
    const country = { field: "country", source: "a" };

    async function stream(document: Record<string, unknown>, rows: readonly ExistingRecord<Data>[] = facts): Promise<{ readonly records: readonly ExistingRecord<Data>[]; readonly scans: number }> {
      let scans = 0;
      const result = await executeJoinedDTQLQuery(new MemoryExecutor({}), joined({ from: flat, ...document }), {
        scanPages: async function* (relation) {
          await Promise.resolve();
          scans += 1;
          yield { records: relation.name === "Invoice" ? rows : dimension };
        },
      });
      return { records: result.records, scans };
    }

    it("sorts a field key by the group value even when `columns` renames or omits it", async () => {
      const renamed = await stream({ groupBy: [country], columns: [{ ...country, as: "iso" }, { ...total, as: "total" }], orderBy: [{ ...country, desc: true }] });
      expect(renamed.records.map((row) => row.data.iso)).toEqual(["USA", "MAL", "CHI", "BRA"]);
      const omitted = await stream({ groupBy: [country], columns: [{ ...total, as: "total" }], orderBy: [country] });
      expect(omitted.records.map((row) => row.data.total)).toEqual([5, 8, 10, 30]);
    });

    it("mixes field keys and expression keys in one ORDER BY", async () => {
      const result = await stream({
        groupBy: [country],
        columns: [{ ...country, as: "iso" }, { ...total, as: "total" }],
        orderBy: [{ aggregate: { function: "count", args: [{ star: true }] }, desc: true }, { ...country, desc: true }, total],
      });
      expect(result.records.map((row) => row.data.iso)).toEqual(["USA", "MAL", "CHI", "BRA"]);
    });

    it("returns bare { key, exists, data } records: no sortKeys leak, with or without ORDER BY", async () => {
      for (const orderBy of [[], [{ aggregate: { function: "count", args: [{ star: true }] } }, country]]) {
        const result = await stream({ groupBy: [country], columns: [{ ...country, as: "iso" }], orderBy });
        expect(result.records.length).toBeGreaterThan(0);
        for (const item of result.records) {
          expect(Object.keys(item).sort()).toEqual(["data", "exists", "key"]);
          expect(Object.keys(item.data)).toEqual(["iso"]);
        }
      }
    });

    it("takes the streaming plan for an aggregate that only appears in an order key", async () => {
      const result = await stream({ orderBy: [{ aggregate: { function: "count", args: [{ star: true }] } }] });
      expect(result.scans).toBe(2);
      expect(result.records.map((row) => row.data)).toEqual([{}]);
    });

    it("keeps one group, with null aggregates, when no row survives and there is no GROUP BY", async () => {
      const result = await stream({
        where: { left: { field: "BillingCountry", source: "i" }, op: "==", right: { value: "Nowhere" } },
        columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "n" }, { ...total, as: "total" }],
      });
      expect(result.records.map((row) => row.data)).toEqual([{ n: 0, total: null }]);
    });

    it("answers DISTINCT aggregates with the generic plan instead of refusing them", async () => {
      let genericScans = 0;
      const executor = new MemoryExecutor({ Invoice: facts, country_aliases: dimension });
      const result = await executeJoinedDTQLQuery(executor, joined({
        from: flat,
        groupBy: [country],
        columns: [{ ...country, as: "iso" }, { aggregate: { function: "count", distinct: true, args: [{ field: "Total", source: "i" }] }, as: "distinct" }],
        orderBy: [{ aggregate: { function: "count", distinct: true, args: [{ field: "Total", source: "i" }] }, desc: true }, country],
      }), {
        resolveExecutor: () => executor,
        scanPages: async function* () { genericScans += 1; await Promise.resolve(); yield { records: [] }; },
      });
      expect(genericScans).toBe(0);
      expect(result.records.map((row) => row.data)).toEqual([{ iso: "USA", distinct: 2 }, { iso: "BRA", distinct: 1 }, { iso: "CHI", distinct: 1 }, { iso: "MAL", distinct: 1 }]);
    });

    it("keeps division by zero null and ordered in the streaming plan", async () => {
      const zero = [record("country_aliases", "1", { alias: "Brazil", country: "BRA", population: 0 }), record("country_aliases", "2", { alias: "USA", country: "USA", population: 300 })];
      const perPerson = { binary: { op: "/", left: total, right: { field: "population", source: "a" } } };
      let scans = 0;
      const result = await executeJoinedDTQLQuery(new MemoryExecutor({}), joined({
        from: { ...flat, joins: [{ ...flat.joins[0], from: { database: "geo", name: "country_aliases", alias: "a" } }] },
        groupBy: [country, { field: "population", source: "a" }],
        columns: [{ ...country, as: "iso" }, { ...perPerson, as: "ratio" }],
        orderBy: [perPerson, country],
      }), {
        scanPages: async function* (relation) { await Promise.resolve(); scans += 1; yield { records: relation.name === "Invoice" ? facts : zero }; },
        schema: { tables: [{ database: "chinook", name: "Invoice", fields: ["InvoiceId", "BillingCountry", "Total"] }, { database: "geo", name: "country_aliases", fields: ["alias", "country", "population"] }] },
      });
      expect(scans).toBe(2);
      expect(result.records.map((row) => row.data)).toEqual([{ iso: "BRA", ratio: null }, { iso: "USA", ratio: 0.1 }]);
    });
  });
});
