import { describe, expect, it } from "vitest";
import { executeJoinedDTQLQuery, isJoinedDTQLQuery, key, parseDTQL, type DTQLSchema, type ExistingRecord, type QueryExecutor, type StructuredQuery } from "../src/index.js";

type Row = Record<string, unknown>;
const schema: DTQLSchema = { tables: [
  { name: "Invoice", fields: ["id", "country_id", "amount"] },
  { name: "Country", fields: ["id", "name", "population"] },
] };

class TableExecutor implements QueryExecutor {
  readonly calls: StructuredQuery<Row>[] = [];
  constructor(readonly table: string, readonly rows: readonly ExistingRecord<Row>[]) {}
  query<T>(query: StructuredQuery<T>) {
    this.calls.push(query as StructuredQuery<Row>);
    if (query.source.name !== this.table) throw new Error(`wrong database for ${query.source.name}`);
    const order = query.orders[0];
    const sorted = [...this.rows].sort((a, b) => order === undefined ? 0 : (Number(a.data[order.field]) - Number(b.data[order.field])) * (order.direction === "desc" ? -1 : 1));
    return Promise.resolve({ records: sorted.slice(0, query.limit) as ExistingRecord<T>[] });
  }
}

describe("federated country sales", () => {
  it("validates same-named tables against their own database schemas", () => {
    const distinctSchemas: DTQLSchema = { tables: [
      { database: "north", name: "Country", fields: ["id", "northName"] },
      { database: "south", name: "Country", fields: ["id", "southName"] },
    ] };
    const query = { from: { database: "north", name: "Country", alias: "n", joins: [{
      from: { database: "south", name: "Country", alias: "s" },
      on: [{ left: { field: "id", source: "n" }, op: "==", right: { field: "id", source: "s" } }],
    }] }, columns: [{ field: "northName", source: "n" }, { field: "southName", source: "s" }] };
    expect(isJoinedDTQLQuery(parseDTQL(query, distinctSchemas))).toBe(true);
    expect(() => parseDTQL({ ...query, columns: [{ field: "southName", source: "n" }] }, distinctSchemas)).toThrow(/southName/);
  });
  it("streams 120,000 fact rows in pages and reports download and processing progress", async () => {
    const parsed = parseDTQL({
      from: { database: "orders", name: "Invoice", alias: "o", joins: [{
        from: { database: "countries", name: "Country", alias: "c" },
        on: [{ left: { field: "country_id", source: "o" }, op: "==", right: { field: "id", source: "c" } }],
      }] },
      groupBy: [{ field: "id", source: "c" }, { field: "name", source: "c" }, { field: "population", source: "c" }],
      columns: [
        { field: "name", source: "c", as: "country" },
        { aggregate: { function: "sum", args: [{ field: "amount", source: "o" }] }, as: "totalSales" },
        { binary: { op: "/", left: { aggregate: { function: "sum", args: [{ field: "amount", source: "o" }] } }, right: { field: "population", source: "c" } }, as: "salesPerCapita" },
      ],
    }, schema);
    if (!isJoinedDTQLQuery(parsed)) throw new Error("expected a join query");
    const progress: { phase: string; rows: number }[] = [];
    const result = await executeJoinedDTQLQuery(new TableExecutor("Invoice", []), parsed, {
      scanPages: async function* (relation) {
        await Promise.resolve();
        if (relation.database === "countries") {
          yield { records: [
            { key: key("Country", 1), exists: true, data: { id: 1, name: "Alpha", population: 100 } },
            { key: key("Country", 2), exists: true, data: { id: 2, name: "Beta", population: 200 } },
          ] };
          return;
        }
        for (let start = 1; start <= 120_000; start += 1000) {
          yield { records: Array.from({ length: 1000 }, (_, index) => {
            const id = start + index;
            return { key: key("Invoice", id), exists: true, data: { id, country_id: id % 2 + 1, amount: 10 } };
          }) };
        }
      },
      onProgress: (item) => progress.push(item),
    });
    expect(result.records.map((row) => row.data)).toEqual([
      { country: "Beta", totalSales: 600_000, salesPerCapita: 3000 },
      { country: "Alpha", totalSales: 600_000, salesPerCapita: 6000 },
    ]);
    expect(progress.at(-1)).toEqual({ phase: "process", rows: 120_000 });
    expect(progress.some((item) => item.phase === "download" && item.rows === 120_002)).toBe(true);
  });
  it("routes two database scans, selects the latest 100 orders first, then joins and calculates per capita", async () => {
    const invoice = new TableExecutor("Invoice", Array.from({ length: 102 }, (_, index) => {
      const id = index + 1;
      return { key: key("Invoice", id), exists: true as const, data: { id, country_id: id % 2 + 1, amount: id <= 2 ? 999 : id % 2 === 0 ? 10 : 20 } };
    }));
    const country = new TableExecutor("Country", [
      { key: key("Country", 1), exists: true, data: { id: 1, name: "Alpha", population: 100 } },
      { key: key("Country", 2), exists: true, data: { id: 2, name: "Beta", population: 200 } },
    ]);
    const document = {
      from: { database: "orders", name: "Invoice", alias: "o", scan: { orderBy: [{ field: "id", desc: true }], limit: 100 }, joins: [{
        from: { database: "countries", name: "Country", alias: "c" },
        on: [{ left: { field: "country_id", source: "o" }, op: "==", right: { field: "id", source: "c" } }],
      }] },
      groupBy: [{ field: "id", source: "c" }, { field: "name", source: "c" }, { field: "population", source: "c" }],
      columns: [
        { field: "name", source: "c", as: "country" },
        { aggregate: { function: "sum", args: [{ field: "amount", source: "o" }] }, as: "totalSales" },
        { binary: { op: "/", left: { aggregate: { function: "sum", args: [{ field: "amount", source: "o" }] } }, right: { field: "population", source: "c" } }, as: "salesPerCapita" },
      ],
    };
    const parsed = parseDTQL(document, schema);
    if (!isJoinedDTQLQuery(parsed)) throw new Error("expected a join query");
    const result = await executeJoinedDTQLQuery(invoice, parsed, {
      resolveExecutor: (relation) => relation.database === "orders" ? invoice : relation.database === "countries" ? country : (() => { throw new Error("unknown database"); })(),
    });
    expect(result.records.map((row) => row.data)).toEqual([
      { country: "Alpha", totalSales: 500, salesPerCapita: 5 },
      { country: "Beta", totalSales: 1000, salesPerCapita: 5 },
    ]);
    expect(invoice.calls).toHaveLength(1);
    expect(invoice.calls[0]?.limit).toBe(100);
    expect(invoice.calls[0]?.orders[0]).toEqual({ field: "id", direction: "desc" });
    expect(country.calls).toHaveLength(1);
  });
});
