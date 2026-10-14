/**
 * Capabilities a database reports about itself. Consumers must discover these
 * at runtime and never infer them from the engine name. Keys mirror the
 * `capabilities` map of an OVDB descriptor.
 */
export interface DatabaseCapabilities {
  readonly read: boolean;
  readonly query: boolean;
  readonly write: boolean;
  readonly delete: boolean;
  readonly reset: boolean;
  readonly persistent: boolean;
  readonly joins?: boolean;
  readonly aggregation?: boolean;
}

/** Optional interface: a database that can describe its own capabilities. */
export interface CapabilityAware {
  capabilities(): DatabaseCapabilities | Promise<DatabaseCapabilities>;
}

/** Optional interface: a database that can be restored to its initial state. */
export interface Resettable {
  reset(): Promise<void>;
}

function hasMethod(value: unknown, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === "function"
  );
}

export function isCapabilityAware<T>(db: T): db is T & CapabilityAware {
  return hasMethod(db, "capabilities");
}

export function isResettable<T>(db: T): db is T & Resettable {
  return hasMethod(db, "reset");
}
