import { UnsupportedError } from "./errors.js";

/** Provider-declared source terms, never an inferred licence of query output. */
export interface SourceDeclaration {
  readonly name?: string;
  readonly spdx?: string;
  readonly url?: string;
  readonly text?: string;
}

/** Provider-defined exact identity. DALgo treats all IDs as opaque. */
export interface SourceIdentity {
  readonly serverId: string;
  readonly databaseId?: string;
  readonly recordset?: string;
}

export interface SourceEvidencePin {
  /** Provider-defined role, such as provider, declaration, input or terms. */
  readonly role: string;
  readonly repository: string;
  readonly revision: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface SourceNotice {
  readonly text: string;
  readonly url?: string;
}

/** Required canonical HTTPS free-source link; providers validate URL safety. */
export interface SourceLinkNotice extends SourceNotice {
  readonly url: string;
}

export interface SourceRight {
  readonly sourceId: string;
  readonly source: SourceIdentity;
  readonly declaration: SourceDeclaration;
  /** Conventional scopes are server, database and recordset. */
  readonly declarationScope: string;
  readonly declaredAt: SourceIdentity;
  /** Provider-defined evidence classification, not DALgo certification. */
  readonly evidenceOrigin: string;
  readonly pins: readonly SourceEvidencePin[];
  readonly attribution?: SourceNotice;
  readonly freeSource?: SourceLinkNotice;
  readonly transformations: readonly string[];
}

/** Optional provider metadata for a table, view or collection descriptor. */
export interface CollectionMetadata {
  readonly name: string;
  readonly sourceRights?: readonly SourceRight[];
}

/**
 * Source terms inventory captured by the authorized executor before output.
 * Absence means unknown/not provided. Actual use includes empty or projected-away
 * inputs; it must never be inferred from returned rows. Providers own inheritance,
 * authorization, deterministic ordering, evidence validation, budgets and page
 * consistency. A rights-aware paged adapter supplies its complete immutable
 * inventory on the first page. Late additions are protocol errors; a streaming
 * generic executor cannot undo previously emitted rows from a misbehaving
 * adapter. These fields do not licence the derived result.
 */
export interface QueryMetadata {
  readonly sourceRights?: readonly SourceRight[];
  readonly usedSourceIds?: readonly string[];
}

/** Detaches a captured inventory from mutable provider/configuration objects. */
export function snapshotQueryMetadata(metadata: QueryMetadata): QueryMetadata {
  if (metadata.sourceRights !== undefined) {
    requireArray(metadata.sourceRights, "sourceRights");
    for (const right of metadata.sourceRights) {
      requireArray(right.pins, "source rights pins");
      requireArray(right.transformations, "source rights transformations");
    }
  }
  if (metadata.usedSourceIds !== undefined) requireArray(metadata.usedSourceIds, "usedSourceIds");
  return {
    ...(metadata.sourceRights === undefined ? {} : { sourceRights: structuredClone(metadata.sourceRights) }),
    ...(metadata.usedSourceIds === undefined ? {} : { usedSourceIds: [...metadata.usedSourceIds] }),
  };
}

/**
 * Generic joins/recursive transforms have no source-rights preflight capability.
 * They refuse annotated inputs rather than silently discarding evidence.
 */
export function requireUnannotatedQueryInput(metadata: QueryMetadata): void {
  if (metadata.sourceRights !== undefined || metadata.usedSourceIds !== undefined) {
    throw new UnsupportedError("source-rights-preflight");
  }
}

function requireArray(value: unknown, name: string): void {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}
