import { canonicalProviderEvidence } from "./provider-reads.js";
import type { SourceRight } from "./source-rights.js";

/** Closed declaration validation shared by live observations and admitted local scans. */
export function validateSourceRightsInventory(raw: unknown, maxTermsCharacters = 256 * 1024): Map<string, SourceRight> {
  const rights = new Map<string, SourceRight>();
  for (const item of declarationItems(raw)) {
    const right = declarationObject(item, ["sourceId", "source", "declaration", "declarationScope", "declaredAt", "evidenceOrigin", "pins", "transformations"], ["attribution", "freeSource"]);
    for (const field of ["sourceId", "declarationScope", "evidenceOrigin"]) declarationId(right[field]);
    validateSourceIdentity(right.source); validateSourceIdentity(right.declaredAt);
    const declaration = declarationObject(right.declaration, [], ["name", "spdx", "url", "text"]);
    for (const field of ["name", "spdx"]) if (declaration[field] !== undefined) declarationId(declaration[field]);
    if (declaration.text !== undefined) terms(declaration.text, maxTermsCharacters);
    if (declaration.url !== undefined) rightsUrl(declaration.url);
    for (const pin of declarationItems(right.pins)) {
      const value = declarationObject(pin, ["role", "repository", "revision", "path", "sha256", "bytes"]);
      for (const field of ["role", "repository", "revision", "path"]) declarationId(value[field]);
      if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) fail("invalid pin digest");
      if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) fail("invalid pin bytes");
    }
    for (const transformation of declarationItems(right.transformations)) declarationId(transformation);
    for (const field of ["attribution", "freeSource"]) if (right[field] !== undefined) {
      const notice = declarationObject(right[field], field === "freeSource" ? ["text", "url"] : ["text"], field === "attribution" ? ["url"] : []);
      terms(notice.text, maxTermsCharacters);
      if (notice.url !== undefined) rightsUrl(notice.url);
    }
    const id = right.sourceId as string;
    if (rights.has(id)) fail("duplicate rights source");
    rights.set(id, right as unknown as SourceRight);
  }
  return rights;
}

export function validateSourceIdentity(raw: unknown): void {
  for (const field of Object.values(declarationObject(raw, ["serverId"], ["databaseId", "recordset"]))) declarationId(field);
}

export function declarationObject(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  // The canonical checker rejects non-JSON values, sparse arrays and accessors.
  canonicalProviderEvidence(raw);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("expected object");
  const value = raw as Record<string, unknown>;
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(`unknown ${key}`);
  return value;
}

export function declarationItems(raw: unknown): readonly unknown[] {
  canonicalProviderEvidence(raw);
  if (!Array.isArray(raw) || raw.length > 64) fail("invalid or overbound array");
  return raw as readonly unknown[];
}

export function declarationId(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || /\p{Cc}/u.test(raw)) fail("invalid or overbound text");
  canonicalProviderEvidence(raw);
}

function terms(raw: unknown, max: number): void {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > max) fail("invalid or overbound rights text");
  for (const character of raw) if (/\p{Cc}/u.test(character) && !["\n", "\r", "\t"].includes(character)) fail("invalid rights text control");
  canonicalProviderEvidence(raw);
}

function rightsUrl(raw: unknown): void {
  declarationId(raw);
  if (/[\\\s]/u.test(raw) || new TextEncoder().encode(raw).length > 2048) fail("unsafe rights URL");
  const url = new URL(raw);
  if (!raw.startsWith("https://") || url.protocol !== "https:" || url.username !== "" || url.password !== "" || raw.slice(8).split(/[/?#]/u)[0]?.includes("@")) fail("unsafe rights URL");
}

function fail(message: string): never { throw new TypeError(`source rights: ${message}`); }
