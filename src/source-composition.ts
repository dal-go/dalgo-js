import { UnsupportedError } from "./errors.js";
import { canonicalProviderEvidence, providerEvidenceDigest, validateProviderReadPlan, validateProviderReads, type ProviderReadPlan } from "./provider-reads.js";
import { declarationId, declarationItems, declarationObject, validateSourceIdentity, validateSourceRightsInventory } from "./source-declarations.js";
import { snapshotQueryMetadata, type QueryMetadata, type SourceIdentity, type SourceRight } from "./source-rights.js";

export const SOURCE_COMPOSITION_FORMAT = "dalgo-source-composition/1" as const;
export const MAX_COMPOSITION_INPUTS = 64;
export const MAX_COMPOSITION_METADATA_BYTES = 256 * 1024;

/** Only original leaf metadata: rejoining composed results is unsupported. */
export type SourceLeafMetadata = Omit<QueryMetadata, "sourceComposition"> & { readonly sourceComposition?: never };

/** Trusted application admission; declaration presence does not grant permission. */
export type SourceLeafAdmission =
  | { readonly kind: "unknown-local" }
  | { readonly kind: "declaration"; readonly sourceRights: readonly SourceRight[]; readonly usedSourceIds?: readonly string[] }
  | { readonly kind: "provider-get"; readonly plan: ProviderReadPlan };

/**
 * The trusted application owns the independently reviewed source contract.
 * Cursor absence / a short page alone never establishes completeness.
 */
export type SourceScanScope =
  | { readonly kind: "complete"; readonly contractRef: string; readonly proof: "ecb-full-decoded-feed"; readonly requestedLimit: 256 }
  | { readonly kind: "complete"; readonly contractRef: string; readonly proof: "immutable-local-array"; readonly requestedLimit: number; readonly maxRows: number }
  | { readonly kind: "bounded"; readonly contractRef: string; readonly requestedLimit: number; readonly ordering: "specified" | "unspecified" };

export interface SourceCompositionInput {
  readonly scanId: string;
  readonly relationPath: string;
  readonly source: SourceIdentity;
  /** Reviewed native type/date/currency meaning binding, never a conversion. */
  readonly semanticRef: string;
  readonly scope: SourceScanScope;
  readonly rightsStatus: "unknown" | "provided";
  readonly metadata: SourceLeafMetadata;
}

/** Scoped leaf namespaces preserve original source IDs and execution authority. */
export interface SourceComposition {
  readonly format: typeof SOURCE_COMPOSITION_FORMAT;
  readonly compositionId: string;
  readonly operation: "join";
  readonly inputs: readonly SourceCompositionInput[];
}

/** Refuse raw presence, including null/malformed/undefined, before codecs or rows. */
export function requireNoSourceComposition(value: object): void {
  if ("sourceComposition" in value) throw new UnsupportedError("source-composition");
}

/** Initial supported consumer: transient in-memory viewer. Call before row access. */
export function requireSourceCompositionConsumer(value: object, consumer: string): void {
  if (consumer !== "in-memory-viewer") requireNoSourceComposition(value);
}

/** Closed, detached structural capture; it does not establish prior admission. */
export function snapshotSourceComposition(raw: unknown): SourceComposition {
  const captured: unknown = structuredClone(raw);
  const envelope = declarationObject(captured, ["format", "compositionId", "operation", "inputs"]);
  if (envelope.format !== SOURCE_COMPOSITION_FORMAT || envelope.operation !== "join") fail("unsupported format or operation");
  declarationId(envelope.compositionId);
  const scans = new Set<string>(); const paths = new Set<string>();
  const inputs = declarationItems(envelope.inputs);
  if (inputs.length === 0) fail("missing inputs");
  for (const rawInput of inputs) {
    const input = declarationObject(rawInput, ["scanId", "relationPath", "source", "semanticRef", "scope", "rightsStatus", "metadata"]);
    declarationId(input.scanId); declarationId(input.relationPath); declarationId(input.semanticRef);
    if (!/^from(?:\.joins\[\d+\]\.from)*$/u.test(input.relationPath)) fail("invalid relation path");
    if (scans.has(input.scanId) || paths.has(input.relationPath)) fail("duplicate scan or relation path");
    scans.add(input.scanId); paths.add(input.relationPath);
    validateSourceIdentity(input.source); validateSourceScanScope(input.scope);
    const metadata = checkedLeaf(input.metadata);
    if (input.rightsStatus !== (metadata.sourceRights === undefined ? "unknown" : "provided")) fail("rights status mismatch");
  }
  compositionSize(captured);
  return captured as SourceComposition;
}

/** Capture the caller admission before any source I/O or asynchronous validation. */
export function snapshotSourceLeafAdmission(raw: SourceLeafAdmission): SourceLeafAdmission {
  const admission: unknown = structuredClone(raw);
  const value = declarationObject(admission, ["kind"], ["sourceRights", "usedSourceIds", "plan"]);
  if (value.kind === "unknown-local") declarationObject(value, ["kind"]);
  else if (value.kind === "declaration") {
    declarationObject(value, ["kind", "sourceRights"], ["usedSourceIds"]);
    checkedLeaf({ sourceRights: value.sourceRights, ...(value.usedSourceIds === undefined ? {} : { usedSourceIds: value.usedSourceIds }) });
  } else if (value.kind === "provider-get") {
    declarationObject(value, ["kind", "plan"]);
    // Validate the plan before I/O, including its GET-only closed request shape.
    validateProviderReadPlan(value.plan as ProviderReadPlan);
  } else fail("unsupported leaf admission");
  compositionSize(admission);
  return admission as SourceLeafAdmission;
}

/** Check exactly the single detached capture that will be emitted. */
export async function captureSourceLeaf(metadata: QueryMetadata, admission: SourceLeafAdmission): Promise<SourceLeafMetadata> {
  requireNoSourceComposition(metadata);
  const captured = snapshotQueryMetadata(metadata);
  const admitted = snapshotSourceLeafAdmission(admission);
  checkedLeaf(captured);
  if (admitted.kind === "unknown-local") {
    if (Object.keys(captured).length !== 0) fail("unknown local metadata mismatch");
  } else if (admitted.kind === "declaration") {
    if (captured.providerReads !== undefined) fail("unexpected live evidence");
    equal(captured, { sourceRights: admitted.sourceRights, ...(admitted.usedSourceIds === undefined ? {} : { usedSourceIds: admitted.usedSourceIds }) }, "declaration preflight");
  } else {
    await validateProviderReads(captured, admitted.plan);
  }
  return captured as SourceLeafMetadata;
}

/** Verify immutable GET bindings before the first admitted source query. */
export async function validateSourceLeafAdmission(admission: SourceLeafAdmission): Promise<void> {
  const captured = snapshotSourceLeafAdmission(admission);
  if (captured.kind !== "provider-get") return;
  const rights = new Map(captured.plan.sourceRights.map((right) => [right.sourceId, right]));
  for (const sourceId of captured.plan.usedSourceIds) if (!rights.has(sourceId)) fail("unknown planned used source");
  for (const binding of captured.plan.bindings) {
    const right = rights.get(binding.rightsSourceId);
    if (right === undefined) fail("binding source rights missing");
    equal(binding.rightsDigest, await providerEvidenceDigest({ format: "ovdb-rights-binding/1", right }), "rights digest");
  }
  const requests = new Set<string>();
  for (const request of captured.plan.requests) {
    const digest = await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request });
    if (requests.has(digest)) fail("duplicate planned request");
    requests.add(digest);
  }
}

export function validateSourceScanScope(raw: unknown): asserts raw is SourceScanScope {
  const value = declarationObject(raw, ["kind", "contractRef", "requestedLimit"], ["proof", "maxRows", "ordering"]);
  declarationId(value.contractRef);
  positiveCount(value.requestedLimit);
  if (value.kind === "complete" && value.proof === "ecb-full-decoded-feed") {
    declarationObject(value, ["kind", "contractRef", "requestedLimit", "proof"]);
    if (value.requestedLimit !== 256) fail("ECB complete scan requires 256");
  } else if (value.kind === "complete" && value.proof === "immutable-local-array") {
    declarationObject(value, ["kind", "contractRef", "requestedLimit", "proof", "maxRows"]);
    if (!Number.isSafeInteger(value.maxRows) || (value.maxRows as number) < 0 || (value.maxRows as number) > (value.requestedLimit as number)) fail("invalid immutable array bound");
  } else if (value.kind === "bounded") {
    declarationObject(value, ["kind", "contractRef", "requestedLimit", "ordering"]);
    if (value.ordering !== "specified" && value.ordering !== "unspecified") fail("invalid bounded ordering");
  } else fail("unproven scan completeness");
}

export function compositionSize(value: unknown, maxBytes = MAX_COMPOSITION_METADATA_BYTES): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_COMPOSITION_METADATA_BYTES) fail("invalid metadata bound");
  const size = new TextEncoder().encode(canonicalProviderEvidence(value)).length;
  if (size > maxBytes) fail("metadata budget exceeded");
  return size;
}

function checkedLeaf(raw: unknown): SourceLeafMetadata {
  const value = declarationObject(raw, [], ["sourceRights", "usedSourceIds", "providerReads"]);
  const metadata = value as QueryMetadata;
  const rights = value.sourceRights === undefined ? undefined : validateSourceRightsInventory(value.sourceRights);
  if (value.usedSourceIds !== undefined) {
    const ids = declarationItems(value.usedSourceIds); const seen = new Set<string>();
    for (const id of ids) {
      declarationId(id);
      if (seen.has(id) || !rights?.has(id)) fail("duplicate or unknown used source");
      seen.add(id);
    }
  }
  // The existing leaf transport checker validates all observation relationships.
  snapshotQueryMetadata(metadata);
  compositionSize(value);
  return metadata as SourceLeafMetadata;
}

function positiveCount(raw: unknown): void {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) fail("invalid scan count");
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonicalProviderEvidence(actual) !== canonicalProviderEvidence(expected)) fail(`${label} mismatch`);
}
function fail(message: string): never { throw new TypeError(`source composition: ${message}`); }
