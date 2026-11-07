import type { TugQLDatabase } from "./tugql.js";

/**
 * Cross-database sources: validation shared by the parser, the resolver and the
 * printer. Mirrors dal-go/dalgo tugql_databases.go. Internal: not exported from
 * the package index.
 */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

/** Words the reference implementation treats as reserved for keyword-case style; an alias may not be one. */
const styleKeywords = new Set([
  "from", "join", "left", "on", "where", "group", "by", "having", "order", "limit", "select", "as", "and", "or", "not", "is", "null", "asc", "desc", "true", "false", "with", "parameters", "required", "default", "using", "inner", "outer", "cross", "integer", "decimal", "string", "boolean", "date", "datetime", "timestamp",
]);

/** An alias is an unquoted word that is not a reserved keyword, so it prints back unchanged. */
export function validDatabaseName(name: string): boolean {
  return /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(name) && !styleKeywords.has(name.toLowerCase());
}

/**
 * Whether a target carries a password. Credentials come from the caller.
 * (1) After the last `://` (or in the whole target when there is none), user
 * information is the text before the first `@` when that text has no `/`; it
 * carries a password when it contains `:`. (2) A `password`, `pwd` or `passwd`
 * key followed by `=` at the target start or right after `;`, `&`, `?` or
 * whitespace is a password parameter.
 */
export function targetHasPassword(target: string): boolean {
  const scheme = target.lastIndexOf("://");
  const rest = scheme < 0 ? target : target.slice(scheme + 3);
  const at = rest.indexOf("@");
  if (at >= 0) {
    const userInfo = rest.slice(0, at);
    if (!userInfo.includes("/") && userInfo.includes(":")) return true;
  }
  return /(^|[;&?\s])(password|pwd|passwd)\s*=/iu.test(target);
}

/** Checks declarations with the rules the parser applies to the `databases (` block; returns the first failure. */
export function databaseDeclarationFailure(databases: readonly TugQLDatabase[]): { readonly code: string; readonly message: string } | undefined {
  const seen = new Set<string>();
  for (const database of databases) {
    if (typeof database.name !== "string" || !validDatabaseName(database.name)) return { code: "invalid_database", message: `database alias ${JSON.stringify(database.name)} must be an unquoted word that is not a reserved keyword` };
    const target = database.target ?? "";
    if (typeof target !== "string" || /[\r\n]/u.test(target)) return { code: "invalid_database", message: `database target must be a single line: ${database.name}` };
    if (targetHasPassword(target)) return { code: "database_credentials", message: `database target must not carry a password: ${database.name}` };
    const key = database.name.toLowerCase();
    if (seen.has(key)) return { code: "duplicate_database", message: `database alias is declared more than once: ${database.name}` };
    seen.add(key);
  }
  return undefined;
}

/** The `database` of every source in definitions and the query, in document order. */
function collectSourceDatabases(value: unknown, add: (name: unknown) => void): void {
  if (Array.isArray(value)) { for (const item of value) collectSourceDatabases(item, add); return; }
  const record = asRecord(value);
  if (record === undefined) return;
  for (const key of Object.keys(record)) {
    if (key === "database") add(record[key]);
    else collectSourceDatabases(record[key], add);
  }
}

/**
 * Checks a tree's declarations and the `database` of every source at every
 * query level. A tree without declarations keeps its legacy meaning (the caller
 * binds every database by name) unless strict is set: the text form can spell a
 * qualified source only for a declared alias, so printing is strict.
 */
export function validateTugQLTreeDatabases(tree: { readonly databases?: readonly TugQLDatabase[]; readonly definitions?: unknown; readonly query?: unknown }, strict: boolean): { readonly code: string; readonly message: string } | undefined {
  const declarations = tree.databases ?? [];
  const failure = databaseDeclarationFailure(declarations);
  if (failure !== undefined) return failure;
  if (!strict && declarations.length === 0) return undefined;
  const declared = new Map<string, boolean>(declarations.map((database) => [database.name, false]));
  const undeclared: string[] = [];
  const note = (name: unknown): void => {
    const alias = typeof name === "string" ? name : "";
    if (declared.has(alias)) declared.set(alias, true); else undeclared.push(alias);
  };
  collectSourceDatabases(tree.definitions, note);
  collectSourceDatabases(tree.query, note);
  for (const database of declarations) {
    if (declared.get(database.name) !== true) return { code: "unused_database", message: `database alias is declared but no source reads it: ${database.name}` };
  }
  if (undeclared.length > 0) return { code: "undeclared_database", message: `source reads undeclared database alias ${JSON.stringify(undeclared[0])}` };
  return undefined;
}
