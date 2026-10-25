import { validateSourceRightsInventory } from "./source-declarations.js";
import { requireNoSourceComposition } from "./source-composition.js";
import { snapshotQueryMetadata, type QueryMetadata, type SourceRight } from "./source-rights.js";

/** Consumer capability only: does not authorize reads, copies or activation. */
export const PROVIDER_READS_FORMAT = "ovdb-provider-read/1" as const;
const MAX_ITEMS = 64;
const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 4096;
const digestPattern = /^[a-f0-9]{64}$/;

export interface ProviderExecution {
  readonly id: string;
  readonly mode: "direct" | "proxy";
  readonly executorId: string;
}

/** The verified immutable definition includes model/meaning artifact bindings. */
export interface ProviderReadBinding {
  readonly providerSourceId: string;
  readonly rightsSourceId: string;
  readonly resourceId: string;
  readonly definitionDigest: string;
  readonly decoderDigest: string;
  readonly rightsDigest: string;
}

export interface ProviderReadObservation {
  readonly observationId: string;
  readonly resourceId: string;
  readonly requestDigest: string;
  /** UTC observation time, distinct from the source's reference date. */
  readonly fetchedAt: string;
  readonly upstreamUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly referenceDate?: string;
  readonly lastModified?: string;
  readonly etag?: string;
  readonly attestation: "direct-executor-observed" | "proxy-executor-observed";
}

export interface ProviderReadUsage {
  readonly providerSourceId: string;
  readonly rightsSourceId: string;
  readonly observationIds: readonly string[];
}

/** Contains observations only, never response bodies, rows or replay data. */
export interface ProviderReads {
  readonly format: typeof PROVIDER_READS_FORMAT;
  readonly execution: ProviderExecution;
  readonly bindings: readonly ProviderReadBinding[];
  readonly reads: readonly ProviderReadObservation[];
  readonly usage: readonly ProviderReadUsage[];
}

export type ProviderRequestValue = string | number | boolean | null;
export interface ProviderResourceRequest {
  readonly resourceId: string;
  readonly method: "GET";
  readonly upstreamUrl: string;
  /** Reviewed, typed non-secret values only. No credentials are admitted. */
  readonly params: Readonly<Record<string, ProviderRequestValue | readonly ProviderRequestValue[]>>;
}

/** Capture before reading; the caller supplies independently admitted facts. */
export interface ProviderReadPlan {
  readonly execution: ProviderExecution;
  readonly bindings: readonly ProviderReadBinding[];
  readonly requests: readonly ProviderResourceRequest[];
  readonly sourceRights: readonly SourceRight[];
  /** Actual legacy usage, supplied by the trusted execution preflight. */
  readonly usedSourceIds: readonly string[];
  readonly maxReads?: number;
  readonly maxMetadataBytes?: number;
}

/** Structural transport check. Digest/admission verification requires validateProviderReads. */
export function snapshotProviderReads(metadata: QueryMetadata): ProviderReads {
  requireNoSourceComposition(metadata);
  const sourceRights = metadata.sourceRights;
  const usedSourceIds = metadata.usedSourceIds;
  const providerReads = metadata.providerReads;
  const captured: QueryMetadata = structuredClone({
    ...(sourceRights === undefined ? {} : { sourceRights }),
    ...(usedSourceIds === undefined ? {} : { usedSourceIds }),
    ...(providerReads === undefined ? {} : { providerReads }),
  });
  validateStructure(captured);
  // Normalize identical repeated read IDs and self-join usage without retaining bytes.
  const envelope = present(captured.providerReads);
  return {
    ...envelope,
    reads: uniqueObjects(envelope.reads, (read) => read.observationId),
    usage: uniqueObjects(envelope.usage, usageKey).map((usage) => ({
      ...usage, observationIds: [...new Set(usage.observationIds)],
    })),
  };
}

/**
 * Fail before output on absent, malformed, changed or unplanned evidence. Uses
 * Web Crypto in browsers/Node; returns a detached inventory, never a signature
 * or publisher verification of future live bytes. Legacy absence remains valid
 * for snapshotQueryMetadata but cannot pass this explicitly required gate.
 */
export async function validateProviderReads(metadata: QueryMetadata, plan: ProviderReadPlan): Promise<QueryMetadata> {
  // Detach both before the first await so callers cannot race admission checks.
  requireNoSourceComposition(metadata);
  const captured = snapshotQueryMetadata(metadata);
  const reads = present(captured.providerReads);
  const admitted = structuredClone(plan);
  validateProviderReadPlan(admitted);
  equal(reads.execution, admitted.execution, "execution authority");
  equal(captured.sourceRights, admitted.sourceRights, "source rights preflight");
  equal(captured.usedSourceIds, admitted.usedSourceIds, "used sources preflight");
  equal(reads.bindings, admitted.bindings, "immutable bindings preflight");
  if (reads.reads.length > (admitted.maxReads ?? MAX_ITEMS)) fail("read budget exceeded");
  if (encodedSize(captured) > (admitted.maxMetadataBytes ?? MAX_BYTES)) fail("metadata budget exceeded");
  const rights = new Map(admitted.sourceRights.map((right) => [right.sourceId, right]));
  for (const binding of reads.bindings) {
    const right = rights.get(binding.rightsSourceId);
    if (right === undefined) fail("binding source rights missing");
    equal(binding.rightsDigest, await providerEvidenceDigest({ format: "ovdb-rights-binding/1", right }), "rights digest");
  }
  const requestDigests = new Map<string, ProviderResourceRequest>();
  for (const request of admitted.requests) {
    const digest = await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request });
    if (requestDigests.has(digest)) fail("duplicate planned request");
    requestDigests.set(digest, request);
  }
  for (const read of reads.reads) {
    const request = requestDigests.get(read.requestDigest);
    if (request?.resourceId !== read.resourceId || request.upstreamUrl !== read.upstreamUrl) {
      fail("unplanned resource request");
    }
    const binding = reads.bindings.find((candidate) => candidate.resourceId === read.resourceId);
    if (binding === undefined) fail("unplanned resource binding");
    const { observationId, ...observation } = read;
    equal(observationId, await providerEvidenceDigest({
      format: "ovdb-read-observation-id/1", execution: reads.execution, binding, read: observation,
    }), "observation digest");
  }
  return captured;
}

/** RFC 8785 canonical UTF-8 JSON / SHA-256; no Unicode normalization or key removal. */
export async function providerEvidenceDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalProviderEvidence(value));
  const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalProviderEvidence(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    unicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("nonfinite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    jsonArray(value);
    return `[${value.map((item: unknown) => canonicalProviderEvidence(item)).join(",")}]`;
  }
  const object = plain(value);
  return `{${Object.keys(object).sort().map((key) => {
    unicode(key);
    return `${JSON.stringify(key)}:${canonicalProviderEvidence(object[key])}`;
  }).join(",")}}`;
}

function validateStructure(metadata: QueryMetadata): void {
  const envelope = closed(metadata.providerReads, ["format", "execution", "bindings", "reads", "usage"]);
  if (envelope.format !== PROVIDER_READS_FORMAT) fail("unsupported providerReads format");
  const execution = validateExecution(envelope.execution);
  const bindings = items(envelope.bindings);
  const bindingMap = new Map<string, ProviderReadBinding>();
  for (const raw of bindings) {
    const binding = validateBinding(raw);
    // v1 permits one logical binding per resource, ensuring observationId is unambiguous.
    if (bindingMap.has(binding.resourceId)) fail("duplicate resource binding");
    bindingMap.set(binding.resourceId, binding);
  }
  const rights = validateRights(metadata.sourceRights);
  const usedIds = ids(metadata.usedSourceIds);
  if (new Set(usedIds).size !== usedIds.length) fail("duplicate used source");
  for (const sourceId of usedIds) if (!rights.has(sourceId)) fail("unknown used source");
  for (const binding of bindingMap.values()) if (!rights.has(binding.rightsSourceId)) fail("unknown binding rights source");
  const observations = new Map<string, ProviderReadObservation>();
  for (const raw of items(envelope.reads)) {
    const read = validateObservation(raw, execution.mode);
    if (!bindingMap.has(read.resourceId)) fail("unplanned observed resource");
    const previous = observations.get(read.observationId);
    if (previous !== undefined) equal(read, previous, "conflicting observation ID");
    observations.set(read.observationId, read);
  }
  const usages = new Map<string, ProviderReadUsage>();
  const observed = new Set<string>();
  const usedRights = new Set<string>();
  for (const raw of items(envelope.usage)) {
    const item = closed(raw, ["providerSourceId", "rightsSourceId", "observationIds"]);
    text(item.providerSourceId); text(item.rightsSourceId);
    const observationIds = ids(item.observationIds);
    if (observationIds.length === 0) fail("missing usage observation");
    const usage = item as unknown as ProviderReadUsage;
    const previous = usages.get(usageKey(usage));
    if (previous !== undefined) equal(usage, previous, "conflicting source usage");
    usages.set(usageKey(usage), usage);
    usedRights.add(usage.rightsSourceId);
    for (const id of observationIds) {
      digest(id);
      const read = observations.get(id);
      if (read === undefined) fail("missing observation");
      const binding = bindingMap.get(read.resourceId);
      if (binding?.providerSourceId !== usage.providerSourceId || binding.rightsSourceId !== usage.rightsSourceId) {
        fail("source observation binding mismatch");
      }
      observed.add(id);
    }
  }
  if (observed.size !== observations.size) fail("unclaimed observation");
  // Legacy used IDs may also contain non-live planned sources; live usages must be included.
  for (const id of usedRights) if (!usedIds.includes(id)) fail("live usage absent from usedSourceIds");
  const boundRights = new Set([...bindingMap.values()].map((binding) => binding.rightsSourceId));
  for (const id of usedIds) if (boundRights.has(id) && !usedRights.has(id)) fail("missing live source usage");
  if (encodedSize({ sourceRights: metadata.sourceRights, usedSourceIds: usedIds, providerReads: envelope }) > MAX_BYTES) {
    fail("metadata budget exceeded");
  }
}

/** Closed structural preflight check; digest verification remains asynchronous. */
export function validateProviderReadPlan(plan: ProviderReadPlan): void {
  closed(plan, ["execution", "bindings", "requests", "sourceRights", "usedSourceIds"], ["maxReads", "maxMetadataBytes"]);
  validateExecution(plan.execution);
  validateRights(plan.sourceRights);
  const used = ids(plan.usedSourceIds);
  if (new Set(used).size !== used.length) fail("duplicate planned used source");
  const resources = new Set<string>();
  for (const binding of items(plan.bindings)) {
    const checked = validateBinding(binding);
    if (resources.has(checked.resourceId)) fail("duplicate planned binding");
    resources.add(checked.resourceId);
  }
  for (const raw of items(plan.requests)) {
    const request = closed(raw, ["resourceId", "method", "upstreamUrl", "params"]);
    text(request.resourceId); safeUrl(request.upstreamUrl);
    if (request.method !== "GET" || !resources.has(request.resourceId as string)) fail("unplanned request resource/method");
    const params = plain(request.params);
    if (Object.keys(params).length > MAX_ITEMS) fail("too many request parameters");
    for (const [key, value] of Object.entries(params)) {
      text(key);
      if (Array.isArray(value)) for (const item of items(value)) requestValue(item);
      else requestValue(value);
    }
  }
  if (plan.maxReads !== undefined) count(plan.maxReads, 0, MAX_ITEMS);
  if (plan.maxMetadataBytes !== undefined) count(plan.maxMetadataBytes, 1, MAX_BYTES);
}

function validateExecution(raw: unknown): ProviderExecution {
  const value = closed(raw, ["id", "mode", "executorId"]);
  text(value.id); text(value.executorId);
  if (value.mode !== "direct" && value.mode !== "proxy") fail("invalid execution mode");
  return value as unknown as ProviderExecution;
}

function validateBinding(raw: unknown): ProviderReadBinding {
  const value = closed(raw, ["providerSourceId", "rightsSourceId", "resourceId", "definitionDigest", "decoderDigest", "rightsDigest"]);
  text(value.providerSourceId); text(value.rightsSourceId); text(value.resourceId);
  if (value.providerSourceId === value.rightsSourceId) fail("provider identity conflated with rights source");
  digest(value.definitionDigest); digest(value.decoderDigest); digest(value.rightsDigest);
  return value as unknown as ProviderReadBinding;
}

function validateObservation(raw: unknown, mode: ProviderExecution["mode"]): ProviderReadObservation {
  const value = closed(raw, ["observationId", "resourceId", "requestDigest", "fetchedAt", "upstreamUrl", "status", "contentType", "sha256", "bytes", "attestation"], ["referenceDate", "lastModified", "etag"]);
  digest(value.observationId); digest(value.requestDigest); digest(value.sha256);
  text(value.resourceId); safeUrl(value.upstreamUrl); text(value.contentType);
  count(value.status, 200, 299); count(value.bytes, 0, Number.MAX_SAFE_INTEGER);
  text(value.fetchedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.fetchedAt as string)) fail("invalid fetchedAt");
  const instant = new Date(value.fetchedAt as string);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().replace(".000Z", "Z") !== (value.fetchedAt as string).replace(".000Z", "Z")) fail("invalid fetchedAt");
  if (value.referenceDate !== undefined) {
    text(value.referenceDate);
    const date = value.referenceDate as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail("invalid referenceDate");
  }
  for (const field of ["lastModified", "etag"] as const) if (value[field] !== undefined) text(value[field]);
  if (value.attestation !== `${mode}-executor-observed`) fail("attestation authority mismatch");
  return value as unknown as ProviderReadObservation;
}

function validateRights(raw: unknown): Map<string, SourceRight> {
  return validateSourceRightsInventory(raw, MAX_TEXT);
}

function requestValue(value: unknown): void {
  if (typeof value === "string") { text(value, true); return; }
  if (typeof value === "number") { count(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); return; }
  if (value !== null && typeof value !== "boolean") fail("invalid request parameter");
}

function closed(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const value = plain(raw);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(`unknown ${key}`);
  return value;
}
function plain(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) fail("expected plain JSON object");
  if (Reflect.ownKeys(raw).length !== Object.keys(raw).length) fail("non-JSON property");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(raw))) if (!("value" in descriptor)) fail("non-JSON accessor");
  return raw as Record<string, unknown>;
}
function items(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) fail("invalid or overbound array");
  jsonArray(raw);
  return raw as readonly unknown[];
}
function jsonArray(value: readonly unknown[]): void {
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== index.toString()) || Reflect.ownKeys(value).length !== value.length + 1) fail("sparse or extended JSON array");
  for (const key of keys) if (!("value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}))) fail("non-JSON array accessor");
}
function ids(raw: unknown): readonly string[] {
  const values = items(raw);
  for (const value of values) text(value);
  return values as readonly string[];
}
function text(raw: unknown, allowEmpty = false): void {
  if (typeof raw !== "string" || (!allowEmpty && raw.length === 0) || raw.length > MAX_TEXT || /\p{Cc}/u.test(raw)) fail("invalid or overbound text");
  unicode(raw);
}
function unicode(value: string): void {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail("invalid Unicode scalar");
}
function digest(raw: unknown): void {
  if (typeof raw !== "string" || !digestPattern.test(raw)) fail("noncanonical digest");
}
function count(raw: unknown, min: number, max: number): void {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) fail("unsafe count/status");
}
function safeUrl(raw: unknown): void {
  text(raw);
  let url: URL;
  try { url = new URL(raw as string); } catch { fail("invalid upstream URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || url.href !== raw) fail("unsafe or noncanonical URL");
}

function usageKey(usage: ProviderReadUsage): string {
  return canonicalProviderEvidence([usage.providerSourceId, usage.rightsSourceId]);
}
function uniqueObjects<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
function encodedSize(value: unknown): number {
  return new TextEncoder().encode(canonicalProviderEvidence(value)).byteLength;
}
function equal(left: unknown, right: unknown, label: string): void {
  if (canonicalProviderEvidence(left) !== canonicalProviderEvidence(right)) fail(label);
}
function fail(message: string): never { throw new TypeError(`providerReads: ${message}`); }

function present<T>(value: T | undefined): T {
  if (value === undefined) fail("required metadata missing");
  return value;
}
