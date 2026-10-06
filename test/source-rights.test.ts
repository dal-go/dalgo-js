import { describe, expect, it } from "vitest";
import fixture from "./testdata/source-rights-wire.json" with { type: "json" };
import {
  executeJoinedDTQLQuery, executeJoinedDTQLQueryPages, executeRecordLookupPages,
  executeRecursiveDTQLQuery, isJoinedDTQLQuery, key, parseDTQL, parseRecursiveDTQL,
  snapshotQueryMetadata, UnsupportedError,
  type CollectionMetadata, type JoinedDTQLQuery, type QueryExecutor, type QueryMetadata,
  type QueryPage, type SourceRight,
} from "../src/index.js";

function right(id: string): SourceRight {
  return { sourceId: id, source: { serverId: "custom-provider", databaseId: "db", recordset: id },
    declaration: { url: "https://example.com/terms", text: "source conditions" },
    declarationScope: "database", declaredAt: { serverId: "custom-provider", databaseId: "db" },
    evidenceOrigin: "provider-policy", pins: [], transformations: [], attribution: { text: "source credit" },
    freeSource: { text: "Original free source", url: "https://example.com/source" } };
}

const schema = { tables: [{ name: "A", fields: ["id"] }, { name: "B", fields: ["id"] }] };

function joined(): JoinedDTQLQuery {
  const parsed = parseDTQL({
    from: { name: "A", alias: "a", joins: [{ type: "inner", from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "id", source: "b" } }] }] },
    columns: [{ field: "id", source: "a", as: "id" }],
  }, schema);
  if (!isJoinedDTQLQuery(parsed)) throw new Error("expected join");
  return parsed;
}

function page(name: string, metadata: QueryMetadata = {}): QueryPage<Record<string, unknown>> {
  return { records: [{ key: key(name, "1"), exists: true, data: { id: 1 } }], ...metadata };
}

describe("optional source data rights", () => {
  it("matches the shared wire fixture and rejects explicit null arrays", () => {
    expect(snapshotQueryMetadata(fixture)).toEqual(fixture);
    for (const invalid of [
      { sourceRights: null }, { usedSourceIds: null }, { sourceRights: "invalid" },
      { sourceRights: [{ ...right("a"), pins: null }] },
      { sourceRights: [{ ...right("a"), transformations: null }] },
    ]) {
      expect(() => snapshotQueryMetadata(invalid as unknown as QueryMetadata)).toThrow(TypeError);
    }
  });

  it("keeps legacy pages and collection descriptors valid with omitted fields", () => {
    const legacy: QueryPage<unknown> = { records: [] };
    const table: CollectionMetadata = { name: "legacy" };
    expect(snapshotQueryMetadata(legacy)).toEqual({});
    expect(JSON.stringify(table)).toBe('{"name":"legacy"}');
    expect(JSON.stringify(legacy)).toBe('{"records":[]}');
  });

  it("snapshots multiple sources without inferring use or an output licence", () => {
    const sourceRights = [right("a"), right("b")];
    const usedSourceIds = ["a"];
    const captured = snapshotQueryMetadata({ sourceRights, usedSourceIds });
    sourceRights[0] = right("changed");
    usedSourceIds[0] = "changed";
    expect(captured.sourceRights?.map((r) => r.sourceId)).toEqual(["a", "b"]);
    expect(captured.usedSourceIds).toEqual(["a"]);
    expect(snapshotQueryMetadata({ usedSourceIds: [] })).toEqual({ usedSourceIds: [] });
    expect(JSON.parse(JSON.stringify(captured))).toEqual(captured);
    expect(captured).not.toHaveProperty("license");
    expect(captured.sourceRights?.[0]?.freeSource).toEqual({ text: "Original free source", url: "https://example.com/source" });
    expect(captured.sourceRights?.[0]?.attribution).toEqual({ text: "source credit" });
  });

  it("forwards captured terms and cursors through paged lookups including empty rows", async () => {
    const rights = [right("a"), right("b")];
    async function* pages(): AsyncIterable<QueryPage<{ id: number }>> {
      await Promise.resolve();
      yield { records: [{ key: key("a", "1"), exists: true, data: { id: 1 } }], nextCursor: { values: [1] }, sourceRights: rights, usedSourceIds: ["a"] };
      yield { records: [], sourceRights: [right("a"), right("b")], usedSourceIds: [] };
    }
    const output: QueryPage<{ id: number }>[] = [];
    for await (const item of executeRecordLookupPages(pages(), {
      keyOf: (record) => record.data.id,
      fetch: async (id) => { rights[0] = right("changed"); await Promise.resolve(); return id; },
      merge: (record) => record.data,
    })) output.push(item);
    expect(output[0]?.sourceRights?.[0]?.sourceId).toBe("a");
    expect(output[0]?.usedSourceIds).toEqual(["a"]);
    expect(output[0]?.nextCursor).toEqual({ values: [1] });
    expect(output[1]?.records).toEqual([]);
    expect(output[1]?.usedSourceIds).toEqual([]);
    expect(output[1]?.sourceRights).toHaveLength(2);
  });

  it("refuses a mixed annotated/unannotated join before any result", async () => {
    const executor: QueryExecutor = { query: <T>(query: { source: { name: string } }): Promise<QueryPage<T>> =>
      Promise.resolve({ records: [], ...(query.source.name === "B" ? { sourceRights: [right("b")] } : {}) }) };
    await expect(executeJoinedDTQLQuery(executor, joined())).rejects.toBeInstanceOf(UnsupportedError);
    const iterator = executeJoinedDTQLQueryPages(joined(), { scanPages: (relation) => ({
      async *[Symbol.asyncIterator]() { await Promise.resolve(); yield page(relation.name, relation.name === "B" ? { sourceRights: [right("b")] } : {}); },
    }) })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ capability: "source-rights-preflight" });
  });

  it("refuses late metadata from a nonconforming transport and stops further output", async () => {
    const iterator = executeJoinedDTQLQueryPages(joined(), { pageSize: 1, scanPages: (relation) => ({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve(); yield page(relation.name);
        if (relation.name === "A") yield page("A", { sourceRights: [right("a")] });
      },
    }) })[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done !== false) throw new Error("expected first page");
    expect(first.value.records).toHaveLength(1);
    await expect(iterator.next()).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("refuses annotated recursive leaf scans including empty results", async () => {
    const executor: QueryExecutor = { query: <T>(): Promise<QueryPage<T>> => Promise.resolve({ records: [], sourceRights: [right("a")] }) };
    const query = parseRecursiveDTQL("from: {name: A, alias: a}\ncolumns: [{field: id, source: a}]\n", schema);
    await expect(executeRecursiveDTQLQuery(executor, query)).rejects.toBeInstanceOf(UnsupportedError);
  });
});
