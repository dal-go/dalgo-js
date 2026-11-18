import { describe, expect, it } from "vitest";
import {
  executeJoinedTugQLQuery,
  executeRecursiveTugQLQuery,
  isJoinedTugQLQuery,
  key,
  parseRecursiveTugQL,
  parseTugQLYaml,
  type ExistingRecord,
  type JoinedTugQLQuery,
  type QueryExecutor,
  type QueryPage,
  type QueryRelation,
  type StructuredQuery,
  type TugQLSchema,
} from "../src/index.js";

type Data = Record<string, unknown>;

const recursiveSchema: TugQLSchema = {
  tables: [{ name: "Native", fields: ["__proto__", "constructor", "prototype", "keep", "nil", "meta"] }],
};

const joinSchema: TugQLSchema = {
  tables: [
    { name: "NativeA", fields: ["id", "meta", "keep", "nil", "constructor", "prototype", "shared", "__proto__"] },
    { name: "NativeB", fields: ["id", "aId", "constructor", "prototype", "shared", "__proto__"] },
  ],
};

function nativeSource(): Data {
  return JSON.parse('{"__proto__":{"polluted":true},"constructor":"ctor-native","prototype":"prototype-native","keep":"ordinary","nil":null,"meta":{"nested":true}}') as Data;
}

function record(collection: string, id: string, data: Data): ExistingRecord<Data> {
  return { key: key(collection, id), exists: true, data };
}

function joined(input: unknown): JoinedTugQLQuery {
  const query = parseTugQLYaml(input, joinSchema);
  if (!isJoinedTugQLQuery(query)) throw new Error("expected joined query");
  return query;
}

function expectOwnEnumerableData(value: Data, field: PropertyKey, expected: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  expect(descriptor).toBeDefined();
  expect(descriptor?.enumerable).toBe(true);
  expect(descriptor?.writable).toBe(true);
  expect(descriptor?.configurable).toBe(true);
  expect(descriptor?.value).toEqual(expected);
}

function joinDocument() {
  return {
    from: {
      name: "NativeA",
      alias: "a",
      joins: [{
        from: { name: "NativeB", alias: "b" },
        on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }],
      }],
    },
    limit: 10,
  };
}

describe("native own data fields", () => {
  it("preserves native own fields when merging a recursive row without explicit columns", async () => {
    const source = nativeSource();
    const snapshot = JSON.stringify(source);
    const query = parseRecursiveTugQL("from: {name: Native, alias: n}\n", recursiveSchema);
    const executor: QueryExecutor = {
      query<T>(leaf: StructuredQuery<T>) {
        if (leaf.source.kind !== "collection" || leaf.source.name !== "Native") throw new Error("unexpected source");
        return Promise.resolve({ records: [{ key: key("Native", "1"), exists: true as const, data: source as T }] });
      },
    };

    const records = (await executeRecursiveTugQLQuery(executor, query)).records;
    expect(records).toHaveLength(1);
    const row = records[0]?.data;
    if (row === undefined) throw new Error("missing recursive row");

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expectOwnEnumerableData(row, "__proto__", { polluted: true });
    expectOwnEnumerableData(row, "constructor", "ctor-native");
    expectOwnEnumerableData(row, "prototype", "prototype-native");
    expectOwnEnumerableData(row, "keep", "ordinary");
    expectOwnEnumerableData(row, "nil", null);
    expect(Object.keys(row)).toEqual(Object.keys(source));
    expect(JSON.parse(JSON.stringify(row))).toEqual(source);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(Object.getPrototypeOf(source)).toBe(Object.prototype);
  });

  it("preserves an explicit recursive projection alias named __proto__", async () => {
    const source = nativeSource();
    const snapshot = JSON.stringify(source);
    const query = parseRecursiveTugQL(`
from: {name: Native, alias: n}
columns:
  - {field: meta, source: n, as: __proto__}
  - {field: constructor, source: n}
  - {field: prototype, source: n}
  - {field: keep, source: n}
  - {field: nil, source: n}
`, recursiveSchema);
    const executor: QueryExecutor = {
      query<T>(leaf: StructuredQuery<T>) {
        if (leaf.source.kind !== "collection" || leaf.source.name !== "Native") throw new Error("unexpected source");
        return Promise.resolve({ records: [{ key: key("Native", "1"), exists: true as const, data: source as T }] });
      },
    };

    const row = (await executeRecursiveTugQLQuery(executor, query)).records[0]?.data;
    if (row === undefined) throw new Error("missing recursive row");

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expectOwnEnumerableData(row, "__proto__", { nested: true });
    expectOwnEnumerableData(row, "constructor", "ctor-native");
    expectOwnEnumerableData(row, "prototype", "prototype-native");
    expectOwnEnumerableData(row, "keep", "ordinary");
    expectOwnEnumerableData(row, "nil", null);
    expect(JSON.parse(JSON.stringify(row))).toEqual(JSON.parse('{"__proto__":{"nested":true},"constructor":"ctor-native","prototype":"prototype-native","keep":"ordinary","nil":null}') as unknown);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(Object.getPrototypeOf(source)).toBe(Object.prototype);
  });

  it("preserves native own fields and later-alias overwrites when materializing a joined row", async () => {
    const aData = JSON.parse('{"__proto__":{"from":"a"},"constructor":"ctor-a","prototype":"proto-a","shared":"shared-a","keep":"keep-a","meta":{"nested":true},"nil":null,"id":1}') as Data;
    const bData: Data = { constructor: "ctor-b", prototype: "proto-b", shared: "shared-b", id: 1, aId: 1 };
    Object.defineProperty(bData, "__proto__", { value: { from: "b" }, enumerable: true, writable: true, configurable: true });
    const aSnapshot = JSON.stringify(aData);
    const bSnapshot = JSON.stringify(bData);
    const executor: QueryExecutor = {
      query<T>(leaf: StructuredQuery<T>) {
        const rows = leaf.source.name === "NativeA" ? [aData] : leaf.source.name === "NativeB" ? [bData] : undefined;
        if (rows === undefined) throw new Error("unexpected source");
        return Promise.resolve({ records: rows.map((value, index) => ({ key: key(leaf.source.name, index.toString()), exists: true as const, data: value as T })) });
      },
    };

    const row = (await executeJoinedTugQLQuery(executor, joined(joinDocument()))).records[0]?.data;
    if (row === undefined) throw new Error("missing joined row");

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expectOwnEnumerableData(row, "__proto__", { from: "b" });
    expectOwnEnumerableData(row, "constructor", "ctor-b");
    expectOwnEnumerableData(row, "prototype", "proto-b");
    expectOwnEnumerableData(row, "shared", "shared-b");
    expectOwnEnumerableData(row, "keep", "keep-a");
    expectOwnEnumerableData(row, "meta", { nested: true });
    expectOwnEnumerableData(row, "nil", null);
    expect(JSON.parse(JSON.stringify(row))).toMatchObject({ "__proto__": { from: "b" }, constructor: "ctor-b", prototype: "proto-b", shared: "shared-b", keep: "keep-a", nil: null });
    expect(JSON.stringify(aData)).toBe(aSnapshot);
    expect(JSON.stringify(bData)).toBe(bSnapshot);
    expect(Object.getPrototypeOf(aData)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(bData)).toBe(Object.prototype);
  });

  it("preserves an explicit joined projection alias named __proto__", async () => {
    const aData = JSON.parse('{"__proto__":{"from":"a"},"constructor":"ctor-a","prototype":"proto-a","shared":"shared-a","keep":"keep-a","meta":{"nested":true},"nil":null,"id":1}') as Data;
    const bData: Data = { constructor: "ctor-b", prototype: "proto-b", shared: "shared-b", id: 1, aId: 1 };
    Object.defineProperty(bData, "__proto__", { value: { from: "b" }, enumerable: true, writable: true, configurable: true });
    const aSnapshot = JSON.stringify(aData);
    const bSnapshot = JSON.stringify(bData);
    const query = joined({
      ...joinDocument(),
      columns: [
        { field: "meta", source: "a", as: "__proto__" },
        { field: "constructor", source: "b" },
        { field: "prototype", source: "b" },
        { field: "shared", source: "b" },
        { field: "keep", source: "a" },
        { field: "nil", source: "a" },
      ],
    });
    const executor: QueryExecutor = {
      query<T>(leaf: StructuredQuery<T>) {
        const rows = leaf.source.name === "NativeA" ? [aData] : leaf.source.name === "NativeB" ? [bData] : undefined;
        if (rows === undefined) throw new Error("unexpected source");
        return Promise.resolve({ records: rows.map((value, index) => ({ key: key(leaf.source.name, index.toString()), exists: true as const, data: value as T })) });
      },
    };

    const row = (await executeJoinedTugQLQuery(executor, query)).records[0]?.data;
    if (row === undefined) throw new Error("missing joined row");

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expectOwnEnumerableData(row, "__proto__", { nested: true });
    expectOwnEnumerableData(row, "constructor", "ctor-b");
    expectOwnEnumerableData(row, "prototype", "proto-b");
    expectOwnEnumerableData(row, "shared", "shared-b");
    expectOwnEnumerableData(row, "keep", "keep-a");
    expectOwnEnumerableData(row, "nil", null);
    expect(JSON.parse(JSON.stringify(row))).toEqual(JSON.parse('{"__proto__":{"nested":true},"constructor":"ctor-b","prototype":"proto-b","shared":"shared-b","keep":"keep-a","nil":null}') as unknown);
    expect(JSON.stringify(aData)).toBe(aSnapshot);
    expect(JSON.stringify(bData)).toBe(bSnapshot);
    expect(Object.getPrototypeOf(aData)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(bData)).toBe(Object.prototype);
  });

  it("preserves an explicit streaming aggregate projection alias named __proto__", async () => {
    const aData: Data = { id: 1, meta: { nested: true }, keep: "keep-a", nil: null };
    const bData: Data = { id: 1, aId: 1 };
    const query = joined({
      ...joinDocument(),
      columns: [
        { aggregate: { function: "count", args: [{ star: true }] }, as: "total" },
        { aggregate: { function: "first", args: [{ field: "meta", source: "a" }] }, as: "__proto__" },
        { aggregate: { function: "first", args: [{ field: "keep", source: "a" }] }, as: "keep" },
        { aggregate: { function: "first", args: [{ field: "nil", source: "a" }] }, as: "nil" },
      ],
    });
    const pages: Readonly<Record<string, readonly ExistingRecord<Data>[]>> = {
      NativeA: [record("NativeA", "a1", aData)],
      NativeB: [record("NativeB", "b1", bData)],
    };
    const scanPages = (relation: QueryRelation): AsyncIterable<QueryPage<Data>> => ({
      [Symbol.asyncIterator](): AsyncIterator<QueryPage<Data>> {
        let done = false;
        return {
          next(): Promise<IteratorResult<QueryPage<Data>>> {
            if (done) return Promise.resolve<IteratorResult<QueryPage<Data>>>({ done: true, value: undefined });
            done = true;
            return Promise.resolve<IteratorResult<QueryPage<Data>>>({ done: false, value: { records: pages[relation.name] ?? [] } });
          },
        };
      },
    });
    const executor: QueryExecutor = {
      query() { throw new Error("streaming aggregate must use scanPages"); },
    };

    const row = (await executeJoinedTugQLQuery(executor, query, { scanPages })).records[0]?.data;
    if (row === undefined) throw new Error("missing streaming row");

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expectOwnEnumerableData(row, "__proto__", { nested: true });
    expectOwnEnumerableData(row, "total", 1);
    expectOwnEnumerableData(row, "keep", "keep-a");
    expectOwnEnumerableData(row, "nil", null);
    expect(JSON.parse(JSON.stringify(row))).toEqual(JSON.parse('{"total":1,"__proto__":{"nested":true},"keep":"keep-a","nil":null}') as unknown);
  });

  it("preserves own enumerable symbol fields when merging a recursive wildcard row", async () => {
    const visible = Symbol("visible");
    const nonEnumerable = Symbol("nonEnumerable");
    const inherited = Symbol("inherited");
    const source: Data = { keep: "recursive" };
    Object.defineProperty(source, visible, { value: "recursive-symbol", enumerable: true, writable: true, configurable: true });
    Object.defineProperty(source, nonEnumerable, { value: "hidden-symbol", enumerable: false, writable: true, configurable: true });
    Object.setPrototypeOf(source, { [inherited]: "inherited-symbol" });
    const query = parseRecursiveTugQL("from: {name: Native, alias: n}\n", recursiveSchema);
    const executor: QueryExecutor = {
      query<T>(leaf: StructuredQuery<T>) {
        if (leaf.source.kind !== "collection" || leaf.source.name !== "Native") throw new Error("unexpected source");
        return Promise.resolve({ records: [{ key: key("Native", "1"), exists: true as const, data: source as T }] });
      },
    };

    const row = (await executeRecursiveTugQLQuery(executor, query)).records[0]?.data;
    if (row === undefined) throw new Error("missing recursive row");

    expect(Object.getOwnPropertySymbols(row)).toEqual([visible]);
    expectOwnEnumerableData(row, visible, "recursive-symbol");
    expect(row.keep).toBe("recursive");
    expect(Object.prototype.hasOwnProperty.call(row, nonEnumerable)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, inherited)).toBe(false);
  });

  it("preserves own enumerable symbol fields and later-alias overwrites when materializing a joined wildcard row", async () => {
    const shared = Symbol("shared");
    const nonEnumerable = Symbol("nonEnumerable");
    const inherited = Symbol("inherited");
    const aData: Data = { id: 1, keep: "keep-a" };
    const bData: Data = { id: 1, aId: 1, keep: "keep-b" };
    Object.defineProperty(aData, shared, { value: "symbol-a", enumerable: true, writable: true, configurable: true });
    Object.defineProperty(bData, shared, { value: "symbol-b", enumerable: true, writable: true, configurable: true });
    Object.defineProperty(aData, nonEnumerable, { value: "hidden-a", enumerable: false, writable: true, configurable: true });
    Object.setPrototypeOf(aData, { [inherited]: "inherited-a" });
    const executor: QueryExecutor = {
      query<T>(leaf: StructuredQuery<T>) {
        const rows = leaf.source.name === "NativeA" ? [aData] : leaf.source.name === "NativeB" ? [bData] : undefined;
        if (rows === undefined) throw new Error("unexpected source");
        return Promise.resolve({ records: rows.map((value, index) => ({ key: key(leaf.source.name, index.toString()), exists: true as const, data: value as T })) });
      },
    };

    const row = (await executeJoinedTugQLQuery(executor, joined(joinDocument()))).records[0]?.data;
    if (row === undefined) throw new Error("missing joined row");

    expect(Object.getOwnPropertySymbols(row)).toEqual([shared]);
    expectOwnEnumerableData(row, shared, "symbol-b");
    expect(row.keep).toBe("keep-b");
    expect(Object.prototype.hasOwnProperty.call(row, nonEnumerable)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, inherited)).toBe(false);
  });
});
