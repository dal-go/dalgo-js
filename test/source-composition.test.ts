import { describe, expect, it } from "vitest";
import {
  captureSourceLeaf, executeJoinedDTQLQuery, executeJoinedDTQLQueryPages, executeRecordLookupPages,
  executeRecursiveDTQLQuery, executeSourceComposedJoinedDTQLQuery, isJoinedDTQLQuery, key,
  parseDTQL, parseRecursiveDTQL, providerEvidenceDigest, requireNoSourceComposition,
  requireSourceCompositionConsumer, snapshotQueryMetadata, snapshotSourceComposition, snapshotSourceLeafAdmission,
  validateProviderReads, type AdmittedMaterializedJoinInput, type JoinedDTQLQuery, type ProviderReadPlan,
  type ProviderReads, type QueryExecutor, type QueryMetadata, type QueryPage, type QueryRelation,
  type SourceComposition, type SourceCompositionJoinOptions, type SourceLeafAdmission, type SourceRight, type StructuredQuery,
} from "../src/index.js";

type Data = Record<string, unknown>;
const schema = { tables: ["A", "B", "C"].map((name) => ({ name, fields: ["currency", "name", "rate", "referenceDate"] })) };
const sourceRight: SourceRight = {
  sourceId: "a", source: { serverId: "synthetic-provider", recordset: "daily" },
  declaration: { text: "Synthetic terms\n\t preserve whitespace", url: "https://example.com/terms#reuse" },
  declarationScope: "recordset", declaredAt: { serverId: "synthetic-provider", recordset: "daily" },
  evidenceOrigin: "synthetic-fixture", pins: [], transformations: ["Synthetic native string quotes"],
  attribution: { text: "Synthetic credit" }, freeSource: { text: "Synthetic original", url: "https://example.com/feed.xml" },
};

function joined(type: "inner" | "left" = "inner"): JoinedDTQLQuery {
  const parsed = parseDTQL({
    from: { name: "A", alias: "a", joins: [{ type, from: { name: "B", alias: "b" },
      on: [{ left: { field: "currency", source: "a" }, op: "==", right: { field: "currency", source: "b" } }] }] },
    columns: [{ field: "name", source: "b", as: "name" }],
  }, schema);
  if (!isJoinedDTQLQuery(parsed)) throw new Error("expected join");
  return parsed;
}

class FixtureExecutor implements QueryExecutor {
  readonly calls: StructuredQuery<Data>[] = [];
  beforeRead?: () => void;
  constructor(readonly rows: readonly Data[], readonly metadata: QueryMetadata = {}, readonly cursor = false) {}
  query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    this.calls.push(structuredClone(query) as StructuredQuery<Data>);
    this.beforeRead?.();
    return Promise.resolve({ ...this.metadata,
      records: this.rows.map((data, index) => ({ key: key(query.source.name, index.toString()), exists: true as const, data: data as T })),
      ...(this.cursor ? { nextCursor: { values: ["more"] } } : {}),
    });
  }
}

function localInput(relation: QueryRelation, executor: FixtureExecutor, admission: SourceLeafAdmission = { kind: "unknown-local" }): AdmittedMaterializedJoinInput {
  const limit = Math.max(executor.rows.length, 1);
  return { executor, source: { serverId: "synthetic-local", databaseId: relation.database ?? "demo", recordset: relation.name },
    semanticRef: "synthetic-currency-descriptors/native-code/1",
    scanQuery: { source: { kind: "collection", name: relation.name }, filters: [], orders: [], limit },
    scope: { kind: "complete", contractRef: "synthetic-immutable-array/1", proof: "immutable-local-array", requestedLimit: limit, maxRows: executor.rows.length }, admission };
}

function options(a: FixtureExecutor, b: FixtureExecutor): SourceCompositionJoinOptions {
  return { compositionId: "composition-fixture", resolveInput: (relation) => localInput(relation, relation.name === "A" ? a : b) };
}

async function liveFixture(executorId = "synthetic-one"): Promise<{ metadata: QueryMetadata; plan: ProviderReadPlan }> {
  const right = structuredClone(sourceRight);
  const execution = { id: "run", mode: "direct" as const, executorId };
  const binding = { providerSourceId: "provider-a", rightsSourceId: "a", resourceId: "daily", definitionDigest: "a".repeat(64), decoderDigest: "b".repeat(64),
    rightsDigest: await providerEvidenceDigest({ format: "ovdb-rights-binding/1", right }) };
  const request = { resourceId: "daily", method: "GET" as const, upstreamUrl: "https://example.com/feed.xml", params: {} };
  const observation = { resourceId: "daily", requestDigest: await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request }),
    fetchedAt: "2026-10-07T08:00:00Z", upstreamUrl: request.upstreamUrl, status: 200, contentType: "text/xml", sha256: "c".repeat(64), bytes: 42,
    referenceDate: "2026-10-06", attestation: "direct-executor-observed" as const };
  const read = { ...observation, observationId: await providerEvidenceDigest({ format: "ovdb-read-observation-id/1", execution, binding, read: observation }) };
  const providerReads: ProviderReads = { format: "ovdb-provider-read/1", execution, bindings: [binding], reads: [read],
    usage: [{ providerSourceId: binding.providerSourceId, rightsSourceId: "a", observationIds: [read.observationId] }] };
  return { metadata: { sourceRights: [right], usedSourceIds: ["a"], providerReads },
    plan: { execution, bindings: [binding], requests: [request], sourceRights: [right], usedSourceIds: ["a"] } };
}

function liveInput(relation: QueryRelation, executor: FixtureExecutor, plan: ProviderReadPlan): AdmittedMaterializedJoinInput {
  return { ...localInput(relation, executor), source: { serverId: plan.execution.executorId, recordset: relation.name },
    semanticRef: "synthetic-native-currency-quote/date-and-decimal-string/1",
    scanQuery: { source: { kind: "collection", name: relation.name }, filters: [], orders: [], limit: 256 },
    scope: { kind: "complete", contractRef: "synthetic-ECB-decoder-max256/1", proof: "ecb-full-decoded-feed", requestedLimit: 256 },
    admission: { kind: "provider-get", plan } };
}

function composition(page: QueryMetadata): SourceComposition {
  if (page.sourceComposition === undefined) throw new Error("missing composition");
  return page.sourceComposition;
}

describe("JS-local materialized source composition", () => {
  it("retains GET evidence and unknown currency descriptors even when the provider columns are projected away", async () => {
    const live = await liveFixture();
    const a = new FixtureExecutor([{ currency: "USD", rate: "1.2345", referenceDate: "2026-10-06" }], live.metadata);
    const b = new FixtureExecutor([{ currency: "USD", name: "Fabricated Dollar" }]);
    const result = await executeSourceComposedJoinedDTQLQuery(joined(), {
      compositionId: "native-currency-join", resolveInput: (relation) => relation.name === "A" ? liveInput(relation, a, live.plan) : localInput(relation, b),
    });
    expect(result.records.map((record) => record.data)).toEqual([{ name: "Fabricated Dollar" }]);
    expect(result).not.toHaveProperty("sourceRights"); expect(result).not.toHaveProperty("providerReads");
    expect(a.calls[0]).toMatchObject({ filters: [], limit: 256 });
    expect(composition(result).inputs.map((input) => input.rightsStatus)).toEqual(["provided", "unknown"]);
    expect(composition(result).inputs[0]?.metadata).toEqual(live.metadata);
    expect(composition(result).inputs[1]?.metadata).toEqual({});
    expect(snapshotQueryMetadata(result)).toEqual({ sourceComposition: composition(result) });
  });

  it.each(["empty-side", "where-removal"])("retains all scans, original notices and live observations with %s zero output", async (variant) => {
    const live = await liveFixture();
    const a = new FixtureExecutor([{ currency: "USD", rate: "1.23" }], live.metadata);
    const b = new FixtureExecutor(variant === "empty-side" ? [] : [{ currency: "USD", name: "Fabricated Dollar" }]);
    const query = joined();
    const filtered = variant === "where-removal" ? { ...query, filters: [{ field: { source: "b", field: "name" }, operator: "==" as const, value: "Never" }] } : query;
    const result = await executeSourceComposedJoinedDTQLQuery(filtered, { compositionId: "empty-output", resolveInput: (relation) => relation.name === "A" ? liveInput(relation, a, live.plan) : localInput(relation, b) });
    expect(result.records).toEqual([]); expect(composition(result).inputs).toHaveLength(2);
    expect(composition(result).inputs[0]?.metadata.sourceRights?.[0]?.attribution).toEqual(sourceRight.attribution);
    expect(composition(result).inputs[0]?.metadata.providerReads).toEqual(live.metadata.providerReads);
    expect(composition(result).inputs[1]?.rightsStatus).toBe("unknown");
  });

  it("retains both dependencies for null-producing LEFT joins and empty roots", async () => {
    const live = await liveFixture();
    for (const rows of [[{ currency: "USD" }], []]) {
      const a = new FixtureExecutor(rows); const b = new FixtureExecutor([{ currency: "GBP" }], live.metadata);
      const result = await executeSourceComposedJoinedDTQLQuery(joined("left"), { compositionId: "left", resolveInput: (relation) => relation.name === "A" ? localInput(relation, a) : liveInput(relation, b, live.plan) });
      expect(result.records.map((record) => record.data)).toEqual(rows.length === 0 ? [] : [{ name: null }]);
      expect(composition(result).inputs).toHaveLength(2); expect(b.calls).toHaveLength(1);
    }
  });

  it("scopes colliding source/resource/execution IDs without renaming or unioning observations", async () => {
    const first = await liveFixture("one"); const second = await liveFixture("two");
    const a = new FixtureExecutor([{ currency: "USD" }], first.metadata); const b = new FixtureExecutor([{ currency: "USD" }], second.metadata);
    const result = await executeSourceComposedJoinedDTQLQuery(joined(), { compositionId: "collisions", resolveInput: (relation) => relation.name === "A" ? liveInput(relation, a, first.plan) : liveInput(relation, b, second.plan) });
    const inputs = composition(result).inputs;
    expect(inputs.map((input) => input.metadata.sourceRights?.[0]?.sourceId)).toEqual(["a", "a"]);
    expect(inputs.map((input) => input.metadata.providerReads?.execution.id)).toEqual(["run", "run"]);
    expect(inputs.map((input) => input.metadata.providerReads?.execution.executorId)).toEqual(["one", "two"]);
    expect(inputs[0]?.scanId).not.toBe(inputs[1]?.scanId);
    expect(inputs[0]?.metadata.providerReads?.reads[0]?.observationId).not.toBe(inputs[1]?.metadata.providerReads?.reads[0]?.observationId);
  });

  it("keeps self-join scans separate and binds identically named collections in different databases", async () => {
    const live = await liveFixture();
    const a = new FixtureExecutor([{ currency: "USD", name: "One" }], live.metadata);
    const b = new FixtureExecutor([{ currency: "USD", name: "Two" }], live.metadata);
    const original = joined(); const edge = original.from.joins[0];
    if (edge === undefined) throw new Error("missing edge");
    const query = { ...original, from: { ...original.from, database: "one", joins: [{ ...edge, from: { ...edge.from, database: "two", name: "A" } }] } };
    const result = await executeSourceComposedJoinedDTQLQuery(query, { compositionId: "same-name", resolveInput: (relation) => liveInput(relation, relation.database === "one" ? a : b, live.plan) });
    expect(result.records[0]?.data.name).toBe("Two");
    expect(a.calls).toHaveLength(1); expect(b.calls).toHaveLength(1);
    expect(composition(result).inputs.map((input) => input.relationPath)).toEqual(["from", "from.joins[0].from"]);
    const self = await executeSourceComposedJoinedDTQLQuery(query, { compositionId: "self", resolveInput: (relation) => liveInput(relation, a, live.plan) });
    expect(a.calls).toHaveLength(3);
    expect(composition(self).inputs).toHaveLength(2);
    expect(composition(self).inputs.map((input) => input.metadata.providerReads)).toEqual([live.metadata.providerReads, live.metadata.providerReads]);
  });

  it("retains every executed nested relation-tree leaf without accepting recursive or composed leaves", async () => {
    const original = joined(); const edge = original.from.joins[0];
    if (edge === undefined) throw new Error("missing edge");
    const query: JoinedDTQLQuery = { ...original, from: { ...original.from, joins: [{ ...edge, from: { ...edge.from, joins: [{
      type: "inner", from: { name: "C", alias: "c", joins: [] }, on: [{ operator: "==", left: { source: "b", field: "currency" }, right: { source: "c", field: "currency" } }],
    }] } }] } };
    const empty = new FixtureExecutor([]);
    const result = await executeSourceComposedJoinedDTQLQuery(query, { compositionId: "tree", resolveInput: (relation) => localInput(relation, empty) });
    expect(composition(result).inputs.map((input) => input.relationPath)).toEqual(["from", "from.joins[0].from", "from.joins[0].from.joins[0].from"]);
    expect(empty.calls).toHaveLength(3);
    const composed = new FixtureExecutor([], { sourceComposition: composition(result) });
    await expect(executeSourceComposedJoinedDTQLQuery(original, options(empty, composed))).rejects.toThrow("source-composition");
    await expect(executeSourceComposedJoinedDTQLQuery(original, { ...options(empty, empty), scanPages: () => [] } as unknown as SourceCompositionJoinOptions)).rejects.toThrow("unsupported composed join option");
  });

  it("preserves declaration-only terms longer than the GET contract and treats a provided empty inventory as provided", async () => {
    const long = { ...sourceRight, declaration: { text: `${"a".repeat(6000)}\n\tLast line`, url: "https://example.com/terms#reuse" } };
    const metadata = { sourceRights: [long], usedSourceIds: ["a"] };
    expect(await captureSourceLeaf(metadata, { kind: "declaration", ...metadata })).toEqual(metadata);
    const a = new FixtureExecutor([], { sourceRights: [] }); const b = new FixtureExecutor([]);
    const result = await executeSourceComposedJoinedDTQLQuery(joined(), { compositionId: "declared-empty", resolveInput: (relation) => localInput(relation, relation.name === "A" ? a : b, relation.name === "A" ? { kind: "declaration", sourceRights: [] } : { kind: "unknown-local" }) });
    expect(composition(result).inputs.map((input) => input.rightsStatus)).toEqual(["provided", "unknown"]);
  });

  it("captures all executor methods, source resolvers, exact scan plans and admissions before the first source I/O", async () => {
    const live = await liveFixture(); const events: string[] = [];
    const admittedPlan = structuredClone(live.plan);
    const a = new FixtureExecutor([{ currency: "USD" }]); const b = new FixtureExecutor([{ currency: "USD", name: "Original" }], live.metadata);
    const opts: SourceCompositionJoinOptions = { compositionId: "mutation", resolveInput: (relation) => {
      events.push(`resolve-${relation.name}`); return relation.name === "A" ? localInput(relation, a) : liveInput(relation, b, admittedPlan);
    } };
    a.beforeRead = () => {
      events.push("read-A"); Object.assign(opts, { resolveInput: () => { throw new Error("racing resolver"); } });
      Object.assign(b, { query: () => { throw new Error("racing executor method"); } });
      Object.assign(admittedPlan.execution, { executorId: "racing authority" });
    };
    const result = await executeSourceComposedJoinedDTQLQuery(joined(), opts);
    expect(events).toEqual(["resolve-A", "resolve-B", "read-A"]);
    expect(result.records[0]?.data.name).toBe("Original");
    expect(composition(result).inputs[1]?.metadata.providerReads?.execution.executorId).toBe("synthetic-one");
  });

  it("validates later preflights, query equality and completeness proofs before any source I/O", async () => {
    const a = new FixtureExecutor([]); const b = new FixtureExecutor([]);
    for (const bad of [
      (input: AdmittedMaterializedJoinInput) => ({ ...input, scope: { ...input.scope, proof: "no-cursor" } }),
      (input: AdmittedMaterializedJoinInput) => ({ ...input, scanQuery: { ...input.scanQuery, filters: [{ field: "currency", operator: "==", value: "USD" }] } }),
      (input: AdmittedMaterializedJoinInput) => ({ ...input, admission: { kind: "declaration", sourceRights: [sourceRight], usedSourceIds: ["unplanned"] } }),
    ]) {
      const opts = { compositionId: "bad-preflight", resolveInput: (relation: QueryRelation) => relation.name === "B" ? bad(localInput(relation, b)) : localInput(relation, a) } as SourceCompositionJoinOptions;
      await expect(executeSourceComposedJoinedDTQLQuery(joined(), opts)).rejects.toThrow();
      expect(a.calls).toHaveLength(0); expect(b.calls).toHaveLength(0);
    }
    const live = await liveFixture(); Object.assign(live.plan.bindings[0] ?? {}, { rightsDigest: "d".repeat(64) });
    await expect(executeSourceComposedJoinedDTQLQuery(joined(), { compositionId: "digest", resolveInput: (relation) => relation.name === "A" ? localInput(relation, a) : liveInput(relation, b, live.plan) })).rejects.toThrow("rights digest");
    expect(a.calls).toHaveLength(0);
  });

  it("captures each admitted executor's query getter exactly once", async () => {
    const a = new FixtureExecutor([{ currency: "USD" }]); const b = new FixtureExecutor([{ currency: "USD", name: "Captured" }]);
    const method = b.query; let calls = 0;
    Object.defineProperty(b, "query", { get() {
      calls++; return calls === 1 ? method : () => { throw new Error("racing method getter"); };
    } });
    const result = await executeSourceComposedJoinedDTQLQuery(joined(), options(a, b));
    expect(result.records[0]?.data.name).toBe("Captured"); expect(calls).toBe(1);
  });

  it("requires explicit bounded relation semantics and preserves ordering instead of claiming exhaustion", async () => {
    const a = new FixtureExecutor([{ currency: "USD" }]); const b = new FixtureExecutor([{ currency: "USD", name: "Prefix" }]);
    const query = joined(); const bounded = { ...query, from: { ...query.from, scan: { orderBy: [], limit: 1 } } };
    const opts: SourceCompositionJoinOptions = { compositionId: "bounded", resolveInput: (relation) => {
      const input = localInput(relation, relation.name === "A" ? a : b);
      return relation.name === "A" ? { ...input, scope: { kind: "bounded", requestedLimit: 1, contractRef: "synthetic-prefix/1", ordering: "unspecified" } } : input;
    } };
    await expect(executeSourceComposedJoinedDTQLQuery(query, opts)).rejects.toThrow("explicit relation scan");
    const result = await executeSourceComposedJoinedDTQLQuery(bounded, opts);
    expect(composition(result).inputs[0]?.scope).toEqual({ kind: "bounded", requestedLimit: 1, contractRef: "synthetic-prefix/1", ordering: "unspecified" });
  });

  it("rejects paged transport and incorrect immutable row counts even on a short empty page", async () => {
    const a = new FixtureExecutor([], {}, true); const b = new FixtureExecutor([]);
    await expect(executeSourceComposedJoinedDTQLQuery(joined(), options(a, b))).rejects.toThrow("paginated");
    const short = new FixtureExecutor([]);
    await expect(executeSourceComposedJoinedDTQLQuery(joined(), { compositionId: "short", resolveInput: (relation) => {
      const input = localInput(relation, short); return { ...input, scope: { kind: "complete", contractRef: "array/1", proof: "immutable-local-array", requestedLimit: 1, maxRows: 1 } };
    } })).rejects.toThrow("completeness mismatch");
  });

  it("enforces scan, cumulative row, retained-data and metadata budgets", async () => {
    const a = new FixtureExecutor([{ currency: "USD", name: "x".repeat(100) }]); const b = new FixtureExecutor([{ currency: "USD" }]);
    await expect(executeSourceComposedJoinedDTQLQuery(joined(), { ...options(a, b), maxFetchedRows: 1 })).rejects.toThrow("fetched-row bound");
    await expect(executeSourceComposedJoinedDTQLQuery(joined(), { ...options(a, b), maxRetainedBytes: 10 })).rejects.toThrow("retained-byte bound");
    await expect(executeSourceComposedJoinedDTQLQuery(joined(), { ...options(a, b), maxMetadataBytes: 10 })).rejects.toThrow("metadata budget");
    await expect(executeSourceComposedJoinedDTQLQuery(joined(), { ...options(a, b), maxMetadataBytes: 262145 })).rejects.toThrow("invalid metadata bound");
  });

  it("rejects changed rights, unexpected evidence and invalid declared usage before result rows are accessed", async () => {
    const live = await liveFixture(); const changed = structuredClone(live.metadata);
    Object.assign(changed.sourceRights?.[0]?.declaration ?? {}, { text: "Changed terms" });
    await expect(captureSourceLeaf(changed, { kind: "provider-get", plan: live.plan })).rejects.toThrow("source rights preflight");
    await expect(captureSourceLeaf(live.metadata, { kind: "unknown-local" })).rejects.toThrow("unknown local metadata mismatch");
    await expect(captureSourceLeaf(live.metadata, { kind: "declaration", sourceRights: [sourceRight], usedSourceIds: ["a"] })).rejects.toThrow("unexpected live evidence");
    await expect(captureSourceLeaf({ sourceRights: [sourceRight], usedSourceIds: ["unknown"] }, { kind: "declaration", sourceRights: [sourceRight] })).rejects.toThrow("unknown used source");
    const trap = Object.defineProperty({ ...changed }, "records", { get() { throw new Error("rows accessed"); } });
    await expect(captureSourceLeaf(trap, { kind: "provider-get", plan: live.plan })).rejects.toThrow("source rights preflight");
  });
});

describe("composition capture and fail-closed consumer boundary", () => {
  async function emptyComposition(): Promise<SourceComposition> {
    const empty = new FixtureExecutor([]); return composition(await executeSourceComposedJoinedDTQLQuery(joined(), options(empty, empty)));
  }

  it("detaches a composition getter once without reading rows and preserves the captured checked object", async () => {
    const original = await emptyComposition(); let reads = 0;
    const parent = Object.defineProperty({}, "sourceComposition", { get() { reads++; return reads === 1 ? original : { rows: [] }; } });
    Object.defineProperty(parent, "records", { get() { throw new Error("rows accessed"); } });
    const captured = snapshotQueryMetadata(parent);
    Object.assign(original.inputs[0]?.source ?? {}, { serverId: "changed" });
    expect(reads).toBe(1); expect(composition(captured).inputs[0]?.source.serverId).toBe("synthetic-local");
  });

  it("rejects mixed, nested, malformed, duplicate and overbound captures", async () => {
    const valid = await emptyComposition(); const live = await liveFixture();
    for (const value of [null, undefined, { ...valid, format: "dalgo-source-composition/2" }, { ...valid, rows: [] },
      { ...valid, inputs: [valid.inputs[0], valid.inputs[0]] }, { ...valid, inputs: Array.from({ length: 65 }, () => valid.inputs[0]) },
      { ...valid, inputs: valid.inputs.map((input) => ({ ...input, rightsStatus: "provided" })) },
      { ...valid, inputs: valid.inputs.map((input) => ({ ...input, metadata: { sourceComposition: valid } })) },
    ]) expect(() => snapshotQueryMetadata({ sourceComposition: value } as QueryMetadata)).toThrow();
    expect(() => snapshotQueryMetadata({ ...live.metadata, sourceComposition: valid })).toThrow("mixed");
    await expect(validateProviderReads({ ...live.metadata, sourceComposition: valid }, live.plan)).rejects.toThrow("source-composition");
    await expect(captureSourceLeaf({ ...live.metadata, sourceComposition: valid }, { kind: "provider-get", plan: live.plan })).rejects.toThrow("source-composition");
    const oversized = { ...valid, compositionId: "x".repeat(4097) };
    expect(() => snapshotSourceComposition(oversized)).toThrow("overbound");
    expect(() => snapshotSourceLeafAdmission({ kind: "declaration", sourceRights: [{ ...sourceRight, body: "forbidden" }] } as SourceLeafAdmission)).toThrow("unknown body");
  });

  it.each(["save", "export", "indexeddb", "recordset", "go", "ovdb", "enrichment"])("refuses raw composition at unsupported %s sinks before row access", async (sink) => {
    const valid = await emptyComposition();
    for (const raw of [valid, null, undefined, { format: "unsupported" }]) {
      const page = Object.defineProperty({ sourceComposition: raw }, "records", { get() { throw new Error("rows accessed"); } });
      expect(() => { requireSourceCompositionConsumer(page, sink); }).toThrow("source-composition");
      expect(() => { requireNoSourceComposition(page); }).toThrow("source-composition");
    }
    expect(() => { requireSourceCompositionConsumer({ sourceComposition: valid }, "in-memory-viewer"); }).not.toThrow();
  });

  it("keeps legacy materialized, streaming, recursive and enrichment routes closed before rows", async () => {
    const valid = await emptyComposition();
    for (const raw of [valid, null, undefined]) {
      const page = Object.defineProperty({ sourceComposition: raw }, "records", { get() { throw new Error("rows accessed"); } }) as QueryPage<Data>;
      const executor: QueryExecutor = { query: <T>() => Promise.resolve(page as QueryPage<T>) };
      await expect(executeJoinedDTQLQuery(executor, joined())).rejects.toThrow("source-rights-preflight");
      const iterator = executeJoinedDTQLQueryPages(joined(), { scanPages: () => ({ async *[Symbol.asyncIterator]() { await Promise.resolve(); yield page; } }) })[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow("source-rights-preflight");
      const recursive = parseRecursiveDTQL({ from: { name: "A", alias: "a" }, columns: [{ field: "currency", source: "a" }] }, schema);
      await expect(executeRecursiveDTQLQuery(executor, recursive)).rejects.toThrow("source-rights-preflight");
      const enriched = executeRecordLookupPages({ async *[Symbol.asyncIterator]() { await Promise.resolve(); yield page; } }, { keyOf: () => "x", fetch: () => Promise.reject(new Error("fetch accessed")), merge: (record) => record.data })[Symbol.asyncIterator]();
      await expect(enriched.next()).rejects.toThrow("source-composition");
    }
  });
});
