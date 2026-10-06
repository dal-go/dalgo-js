import { describe, expect, it } from "vitest";
import {
  canonicalProviderEvidence, providerEvidenceDigest, requireUnannotatedQueryInput,
  snapshotQueryMetadata, validateProviderReads,
  type ProviderReadPlan, type ProviderReads,
  type QueryMetadata, type QueryPage, type SourceRight,
} from "../src/index.js";

const hash = "a".repeat(64);
const url = "https://example.com/original.xml";
const right: SourceRight = {
  sourceId: "ovdb:gateway/db/daily", source: { serverId: "gateway", databaseId: "db", recordset: "daily" },
  declaration: { name: "Synthetic terms", url: "https://example.com/terms" },
  declaredAt: { serverId: "gateway", databaseId: "db" }, declarationScope: "database",
  evidenceOrigin: "publisher-definition-verified", pins: [], transformations: ["Synthetic XML to rows"],
  attribution: { text: "Synthetic provider" }, freeSource: { text: "Free original", url },
};

async function fixture(mode: "direct" | "proxy" = "proxy"): Promise<{ metadata: QueryMetadata; plan: ProviderReadPlan }> {
  const sourceRight = structuredClone(right);
  Object.assign(sourceRight, { sourceId: mode === "direct" ? "direct:synthetic/daily" : right.sourceId });
  const execution = { id: "synthetic-execution", mode, executorId: mode === "direct" ? "admitted-browser" : "gateway" };
  const binding = {
    providerSourceId: "provider:synthetic/FxReferenceQuote", rightsSourceId: sourceRight.sourceId,
    resourceId: "synthetic-daily", definitionDigest: hash, decoderDigest: hash,
    rightsDigest: await providerEvidenceDigest({ format: "ovdb-rights-binding/1", right: sourceRight }),
  };
  const request = { resourceId: binding.resourceId, method: "GET" as const, upstreamUrl: url, params: {} };
  const observation = {
    resourceId: request.resourceId,
    requestDigest: await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request }),
    fetchedAt: "2026-10-06T09:00:00Z", upstreamUrl: url, status: 200, contentType: "text/xml",
    sha256: hash, bytes: 42, referenceDate: "2026-10-05", etag: '"synthetic"',
    lastModified: "Mon, 05 Oct 2026 13:00:00 GMT", attestation: `${mode}-executor-observed` as const,
  };
  const read = { ...observation, observationId: await providerEvidenceDigest({
    format: "ovdb-read-observation-id/1", execution, binding, read: observation,
  }) };
  const providerReads: ProviderReads = {
    format: "ovdb-provider-read/1", execution, bindings: [binding], reads: [read],
    usage: [{ providerSourceId: binding.providerSourceId, rightsSourceId: binding.rightsSourceId, observationIds: [read.observationId] }],
  };
  return {
    metadata: { sourceRights: [sourceRight], usedSourceIds: [sourceRight.sourceId], providerReads },
    plan: { execution, bindings: [binding], requests: [request], sourceRights: [sourceRight], usedSourceIds: [sourceRight.sourceId] },
  };
}

function evidence(metadata: QueryMetadata): ProviderReads {
  if (metadata.providerReads === undefined) throw new Error("fixture evidence missing");
  return metadata.providerReads;
}

describe("providerReads v1 consumer", () => {
  it("preserves absent legacy metadata but requires evidence for the explicit gate", async () => {
    const { plan } = await fixture();
    expect(snapshotQueryMetadata({})).toEqual({});
    expect(snapshotQueryMetadata({ usedSourceIds: [] })).toEqual({ usedSourceIds: [] });
    await expect(validateProviderReads({}, plan)).rejects.toThrow("plain JSON object");
  });

  it("verifies both authorities without conflating provider identity or attestations", async () => {
    const proxy = await fixture(); const direct = await fixture("direct");
    await expect(validateProviderReads(proxy.metadata, proxy.plan)).resolves.toEqual(proxy.metadata);
    await expect(validateProviderReads(direct.metadata, direct.plan)).resolves.toEqual(direct.metadata);
    expect(evidence(proxy.metadata).bindings[0]?.providerSourceId).toEqual(evidence(direct.metadata).bindings[0]?.providerSourceId);
    expect(evidence(proxy.metadata).reads[0]?.sha256).toEqual(evidence(direct.metadata).reads[0]?.sha256);
    expect(evidence(proxy.metadata).reads[0]?.observationId).not.toEqual(evidence(direct.metadata).reads[0]?.observationId);
    await expect(validateProviderReads(direct.metadata, proxy.plan)).rejects.toThrow("execution authority");
  });

  it("captures zero-row and projected-away sources from usage, not output", async () => {
    const { metadata, plan } = await fixture();
    const empty: QueryPage<unknown> = { records: [], ...metadata };
    const projected: QueryPage<unknown> = { records: [], ...metadata };
    expect(await validateProviderReads(empty, plan)).toEqual(await validateProviderReads(projected, plan));
    expect(snapshotQueryMetadata(empty).usedSourceIds).toEqual([right.sourceId]);
  });

  it("detaches before awaiting and preserves provider evidence through snapshots", async () => {
    const { metadata, plan } = await fixture();
    const pending = validateProviderReads(metadata, plan);
    const read = first(evidence(metadata).reads);
    Object.assign(read, { bytes: 900 });
    Object.assign(plan.execution, { executorId: "racing-change" });
    const captured = await pending;
    expect(evidence(captured).reads[0]?.bytes).toBe(42);
    expect(evidence(captured).execution.executorId).toBe("gateway");
    const snapshot = snapshotQueryMetadata(captured);
    Object.assign(first(evidence(captured).reads), { bytes: 700 });
    expect(evidence(snapshot).reads[0]?.bytes).toBe(42);
  });

  it("deduplicates identical self-join observations and usage; conflicts refuse", async () => {
    const { metadata, plan } = await fixture();
    const envelope = evidence(metadata);
    const read = first(envelope.reads);
    const usage = envelope.usage[0];
    if (usage === undefined) throw new Error("fixture usage missing");
    const duplicate = { ...metadata, providerReads: { ...envelope, reads: [read, structuredClone(read)], usage: [usage, structuredClone(usage)] } };
    expect(evidence(await validateProviderReads(duplicate, plan)).reads).toHaveLength(1);
    expect(evidence(snapshotQueryMetadata(duplicate)).usage).toHaveLength(1);
    duplicate.providerReads.reads[1] = { ...read, bytes: 43 };
    expect(() => snapshotQueryMetadata(duplicate)).toThrow("conflicting observation ID");
  });

  it("keeps distinct requests and instants as distinct observations", async () => {
    const { metadata, plan } = await fixture();
    const envelope = evidence(metadata); const firstRead = first(envelope.reads);
    const binding = envelope.bindings[0];
    const request = { resourceId: "synthetic-daily", method: "GET" as const, upstreamUrl: url, params: { variant: "second" } };
    const { observationId: ignored, ...initial } = firstRead;
    expect(ignored).toHaveLength(64);
    const read = { ...initial, fetchedAt: "2026-10-06T09:00:01Z", requestDigest: await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request }) };
    const second = { ...read, observationId: await providerEvidenceDigest({ format: "ovdb-read-observation-id/1", execution: envelope.execution, binding, read }) };
    const usage = envelope.usage[0]; if (usage === undefined) throw new Error("fixture usage missing");
    const input = { ...metadata, providerReads: { ...envelope, reads: [firstRead, second], usage: [{ ...usage, observationIds: [firstRead.observationId, second.observationId] }] } };
    const admitted = { ...plan, requests: [...plan.requests, request] };
    expect(evidence(await validateProviderReads(input, admitted)).reads).toHaveLength(2);
    await expect(validateProviderReads(input, plan)).rejects.toThrow("unplanned resource request");
  });

  it.each([
    ["unknown envelope key", (e: ProviderReads) => Object.assign(e, { rows: [] })],
    ["unsupported version", (e: ProviderReads) => Object.assign(e, { format: "ovdb-provider-read/2" })],
    ["unknown read key", (e: ProviderReads) => Object.assign(first(e.reads), { headers: {} })],
    ["invalid digest", (e: ProviderReads) => Object.assign(first(e.reads), { sha256: "A".repeat(64) })],
    ["unsafe size", (e: ProviderReads) => Object.assign(first(e.reads), { bytes: Number.MAX_SAFE_INTEGER + 1 })],
    ["fractional status", (e: ProviderReads) => Object.assign(first(e.reads), { status: 200.5 })],
    ["failed status", (e: ProviderReads) => Object.assign(first(e.reads), { status: 304 })],
    ["impossible date", (e: ProviderReads) => Object.assign(first(e.reads), { referenceDate: "2026-02-30" })],
    ["invalid UTC instant", (e: ProviderReads) => Object.assign(first(e.reads), { fetchedAt: "2026-02-30T09:00:00Z" })],
    ["header control", (e: ProviderReads) => Object.assign(first(e.reads), { etag: "line\nbreak" })],
    ["lone surrogate", (e: ProviderReads) => Object.assign(e.execution, { id: "\ud800" })],
    ["unsafe URL", (e: ProviderReads) => Object.assign(first(e.reads), { upstreamUrl: "https://secret@example.com/original.xml" })],
    ["wrong attestation", (e: ProviderReads) => Object.assign(first(e.reads), { attestation: "direct-executor-observed" })],
    ["unplanned resource", (e: ProviderReads) => Object.assign(first(e.reads), { resourceId: "other" })],
    ["unknown usage source", (e: ProviderReads) => Object.assign(e.usage[0] ?? {}, { providerSourceId: "other" })],
    ["missing observation", (e: ProviderReads) => Object.assign(e.usage[0] ?? {}, { observationIds: ["b".repeat(64)] })],
    ["unclaimed observation", (e: ProviderReads) => Object.assign(e, { usage: [] })],
    ["duplicate binding", (e: ProviderReads) => Object.assign(e, { bindings: [...e.bindings, ...e.bindings] })],
    ["overbound text", (e: ProviderReads) => Object.assign(e.execution, { id: "x".repeat(4097) })],
    ["overbound reads", (e: ProviderReads) => Object.assign(e, { reads: Array.from({ length: 65 }, () => e.reads[0]) })],
  ])("rejects %s", async (_label, change) => {
    const { metadata, plan } = await fixture();
    change(evidence(metadata));
    expect(() => snapshotQueryMetadata(metadata)).toThrow();
    await expect(validateProviderReads(metadata, plan)).rejects.toThrow();
  });

  it("rejects changed preflight facts, forged digests and missing legacy usage", async () => {
    for (const change of [
      (m: QueryMetadata) => Object.assign(m.sourceRights?.[0] ?? {}, { evidenceOrigin: "publisher-verified" }),
      (m: QueryMetadata) => Object.assign(evidence(m).bindings[0] ?? {}, { definitionDigest: "b".repeat(64) }),
      (m: QueryMetadata) => Object.assign(evidence(m).reads[0] ?? {}, { bytes: 43 }),
      (m: QueryMetadata) => Object.assign(m, { usedSourceIds: [] }),
      (m: QueryMetadata) => Object.assign(m, { usedSourceIds: ["unknown"] }),
      (m: QueryMetadata) => Object.assign(m, { sourceRights: [...(m.sourceRights ?? []), ...(m.sourceRights ?? [])] }),
    ]) {
      const { metadata, plan } = await fixture(); change(metadata);
      await expect(validateProviderReads(metadata, plan)).rejects.toThrow();
    }
    const { metadata, plan } = await fixture();
    const changed = structuredClone(plan);
    Object.assign(changed.bindings[0] ?? {}, { rightsDigest: "b".repeat(64) });
    Object.assign(evidence(metadata).bindings[0] ?? {}, { rightsDigest: "b".repeat(64) });
    await expect(validateProviderReads(metadata, changed)).rejects.toThrow("rights digest");
  });

  it("enforces smaller admitted budgets and refuses generic rights-unaware transforms", async () => {
    const { metadata, plan } = await fixture();
    await expect(validateProviderReads(metadata, { ...plan, maxReads: 0 })).rejects.toThrow("read budget");
    await expect(validateProviderReads(metadata, { ...plan, maxMetadataBytes: 10 })).rejects.toThrow("metadata budget");
    await expect(validateProviderReads(metadata, { ...plan, maxReads: 65 })).rejects.toThrow("unsafe count");
    expect(() => { requireUnannotatedQueryInput({ providerReads: evidence(metadata) }); }).toThrow("source-rights-preflight");
  });
});

describe("canonical provider evidence digests", () => {
  it("matches RFC 8785 scalar serialization and UTF-16 key ordering with independent SHA-256", async () => {
    const vector = { z: -0, a: [1e30, 4.50, 2e-3, '€\n"\\'], "\ud83d\ude00": true, "\ufffd": null };
    const canonical = String.raw`{"a":[1e+30,4.5,0.002,"€\n\"\\"],"z":0,"😀":true,"�":null}`;
    expect(canonicalProviderEvidence(vector)).toBe(canonical);
    expect(await providerEvidenceDigest(vector)).toBe("6e27eb4b8e4332bf78cc20af8e637ae42bf981d23e15ca2a2fde38c09b737ab2");
    expect(await providerEvidenceDigest({ b: 1, a: 2 })).toBe(await providerEvidenceDigest({ a: 2, b: 1 }));
  });

  it("does not normalize Unicode or recursively omit nested id/digest keys", async () => {
    expect(await providerEvidenceDigest({ id: { digest: "a" }, name: "é" })).not.toBe(await providerEvidenceDigest({ id: { digest: "b" }, name: "é" }));
    expect(await providerEvidenceDigest("é")).not.toBe(await providerEvidenceDigest("e\u0301"));
    for (const value of [undefined, NaN, Infinity, "\udfff", new Date(), Array(1), { a: undefined }]) {
      expect(() => canonicalProviderEvidence(value)).toThrow();
    }
  });
});

function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("missing fixture item");
  return value;
}
