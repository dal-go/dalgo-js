/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions -- node:fs and node:crypto types are not part of this package's tsconfig. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  formatTugQL,
  parseTugQL,
  printTugQL,
  resolveTugQL,
  stringifyRecursiveTugQL,
  tugqlToYaml,
  yamlToTugQL,
  executeRecursiveTugQLQuery,
  key,
  type QueryExecutor,
  type TugQLFormatOptions,
  type TugQLResolveContext,
  type TugQLTree,
} from "../src/index.js";

/**
 * Shared Go/TypeScript conformance vectors for cross-database sources
 * (REQ:tugql-cross-database). The vendored file is byte for byte the Go one.
 */
interface CrossDatabaseVectors {
  readonly format: string;
  readonly version: number;
  readonly context: TugQLResolveContext;
  readonly textCases: readonly { readonly name: string; readonly text: string; readonly expected: { readonly tree: unknown; readonly yaml: string; readonly text: string } }[];
  readonly errorCases: readonly { readonly name: string; readonly text: string; readonly expected: { readonly code: string; readonly line: number; readonly column: number } }[];
  readonly treeCases: readonly { readonly name: string; readonly operation: "print" | "resolve"; readonly tree: TugQLTree; readonly expected: { readonly code?: string; readonly query?: string; readonly text?: string } }[];
  readonly yamlCases: readonly { readonly name: string; readonly yaml: string; readonly expected: { readonly code?: string; readonly text?: string } }[];
  readonly formatCases: readonly { readonly name: string; readonly text: string; readonly options: TugQLFormatOptions; readonly expected: { readonly text: string } }[];
  readonly resolveCases: readonly { readonly name: string; readonly text: string; readonly context?: Partial<TugQLResolveContext>; readonly expected: { readonly code?: string; readonly query?: string; readonly schemaVersion?: string; readonly columns?: readonly string[]; readonly outputColumns?: readonly { readonly name: string; readonly type: string; readonly lineage: readonly unknown[] | null }[] } }[];
}

const corpus = new URL("./testdata/tugql/v1/", import.meta.url);
const vectorText = readFileSync(new URL("cross-database.json", corpus), "utf8");
const vectors = JSON.parse(vectorText) as CrossDatabaseVectors;

/** The TypeScript engine writes a scalar subquery's alias on the query; the Go corpus writes it on the column. */
function normalizeScalarAliases(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeScalarAliases);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(record).map(([name, item]) => [name, normalizeScalarAliases(item)]));
  if (Array.isArray(record.columns)) {
    result.columns = record.columns.map((column) => {
      if (column === null || typeof column !== "object") return column;
      const item = column as Record<string, unknown>;
      const query = item.query;
      if (query === null || typeof query !== "object" || !Object.prototype.hasOwnProperty.call(query, "as")) return normalizeScalarAliases(item);
      const { as, ...queryBody } = query as Record<string, unknown>;
      return { ...normalizeScalarAliases(item), as, query: normalizeScalarAliases(queryBody) };
    });
  }
  return result;
}

function normalizedQuery(yaml: string): unknown {
  return normalizeScalarAliases(parseYaml(yaml));
}

describe("TugQL cross-database vectors", () => {
  it("vendors the Go corpus byte for byte", () => {
    const manifest = readFileSync(new URL("manifest.sha256", corpus), "utf8").trim().split(/\n/u);
    expect(manifest).toContain(`${createHash("sha256").update(vectorText).digest("hex")}  tugql/testdata/tugql/v1/cross-database.json`);
    expect(vectors.format).toBe("tugql-cross-database-suite");
    expect(vectors.version).toBe(1);
    for (const cases of [vectors.textCases, vectors.errorCases, vectors.treeCases, vectors.yamlCases, vectors.formatCases, vectors.resolveCases]) expect(cases.length).toBeGreaterThan(0);
  });

  describe("textCases", () => {
    for (const item of vectors.textCases) {
      it(item.name, () => {
        const parsed = parseTugQL(item.text);
        expect(parsed.diagnostics).toEqual([]);
        const tree = parsed.document.tree!;
        expect(JSON.parse(JSON.stringify(tree))).toEqual(item.expected.tree);
        const yaml = tugqlToYaml(item.text);
        expect(yaml.diagnostics).toEqual([]);
        expect(yaml.yaml).toBe(item.expected.yaml);
        const printed = printTugQL(tree);
        expect(printed.diagnostics).toEqual([]);
        expect(printed.source).toBe(item.expected.text);
        const back = yamlToTugQL(yaml.yaml!);
        expect(back.diagnostics).toEqual([]);
        expect(back.source).toBe(item.expected.text);
        const again = parseTugQL(printed.source!);
        expect(again.diagnostics).toEqual([]);
        expect(again.document.tree?.databases).toEqual(tree.databases);
        expect(again.document.tree?.query).toEqual(tree.query);
        expect(again.document.tree?.definitions).toEqual(tree.definitions);
      });
    }
  });

  describe("errorCases", () => {
    for (const item of vectors.errorCases) {
      it(item.name, () => {
        const parsed = parseTugQL(item.text);
        expect(parsed.document.tree).toBeUndefined();
        const first = parsed.diagnostics[0];
        expect(first).toBeDefined();
        expect({ code: first!.code, line: first!.span.start.line, column: first!.span.start.column }).toEqual(item.expected);
      });
    }
  });

  describe("treeCases", () => {
    for (const item of vectors.treeCases) {
      it(item.name, () => {
        let code: string | undefined;
        if (item.operation === "print") {
          const printed = printTugQL(item.tree);
          code = printed.diagnostics[0]?.code;
          if (item.expected.text !== undefined) expect(printed.source).toBe(item.expected.text);
        } else {
          const resolved = resolveTugQL({ tree: item.tree, sourceMetadata: { format: "tugql", version: 1 } }, vectors.context);
          code = resolved.diagnostics[0]?.code;
          if (item.expected.query !== undefined) {
            expect(resolved.resolved).toBeDefined();
            expect(normalizeScalarAliases(parseYaml(stringifyRecursiveTugQL(resolved.resolved!.query)))).toEqual(normalizedQuery(item.expected.query));
          }
        }
        expect(code).toBe(item.expected.code);
      });
    }
  });

  describe("yamlCases", () => {
    for (const item of vectors.yamlCases) {
      it(item.name, () => {
        const converted = yamlToTugQL(item.yaml);
        if (item.expected.text !== undefined) {
          expect(converted.diagnostics).toEqual([]);
          expect(converted.source).toBe(item.expected.text);
        } else {
          expect(converted.diagnostics[0]?.code).toBe(item.expected.code);
        }
      });
    }
  });

  describe("resolveCases", () => {
    for (const item of vectors.resolveCases) {
      it(item.name, () => {
        const context = { ...vectors.context, ...item.context };
        const parsed = parseTugQL(item.text);
        expect(parsed.diagnostics).toEqual([]);
        const resolved = resolveTugQL(parsed.document, context);
        if (item.expected.code !== undefined) {
          expect(resolved.resolved).toBeUndefined();
          expect(resolved.diagnostics[0]?.code).toBe(item.expected.code);
          return;
        }
        expect(resolved.diagnostics).toEqual([]);
        expect(normalizeScalarAliases(parseYaml(stringifyRecursiveTugQL(resolved.resolved!.query)))).toEqual(normalizedQuery(item.expected.query!));
        expect(resolved.resolved!.schemaVersion).toBe(item.expected.schemaVersion);
        expect(resolved.resolved!.columns.map((column) => column.name)).toEqual(item.expected.columns);
        // A null lineage equals an empty one.
        const normalize = (columns: readonly { readonly name: string; readonly type: string; readonly lineage: readonly unknown[] | null }[]): unknown => columns.map((column) => ({ name: column.name, type: column.type, lineage: column.lineage ?? [] }));
        expect(item.expected.outputColumns).toBeDefined();
        expect(normalize(resolved.resolved!.columns)).toEqual(normalize(item.expected.outputColumns!));
      });
    }
  });

  describe("formatCases", () => {
    for (const item of vectors.formatCases) {
      it(item.name, () => {
        const formatted = formatTugQL({ source: item.text, sourceMetadata: { format: "tugql", version: 1 } }, item.options);
        expect(formatted.diagnostics).toEqual([]);
        expect(formatted.source).toBe(item.expected.text);
      });
    }
  });
});

describe("TugQL cross-database edges", () => {
  const withTarget = (target: string): string => `databases (\n  pg = '${target}'\n)\nfrom pg::Invoice\nselect Id`;

  it("rejects passwords in targets", () => {
    for (const target of ["postgres://app:secret@db/x", "app:secret@db/x", "host=db;Password = x", "dsn?pwd=1", "a&passwd=1", "h=1;pwd\t\t= x"]) {
      expect(parseTugQL(withTarget(target)).diagnostics[0]?.code, target).toBe("database_credentials");
    }
    for (const target of ["postgres://app@db/x", "datatug://chinook/sales?env=prod", "https://h/a@b:c", "x=password"]) {
      expect(parseTugQL(withTarget(target)).diagnostics, target).toEqual([]);
    }
  });

  it("keeps databases an ordinary identifier outside a block header", () => {
    expect(parseTugQL("from databases\nselect databases(x) as X").diagnostics).toEqual([]);
    expect(parseTugQL("databases ( -- note\n  sales\n)\nfrom sales::Invoice\nselect Id").diagnostics).toEqual([]);
    expect(parseTugQL("Databases (\n  sales\n)\nfrom sales::Invoice\nselect Id").diagnostics[0]?.code).toBe("keyword_case");
  });

  it("anchors comments on the databases block", () => {
    const text = "-- fleet\ndatabases ( -- end\n  sales\n)\nfrom sales::Invoice\nselect Id";
    const parsed = parseTugQL(text);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.tree?.comments?.anchors?.databases).toEqual({ leading: [{ text: "fleet" }], trailing: { text: "end" } });
    const yaml = tugqlToYaml(text).yaml!;
    expect(yamlToTugQL(yaml).source).toBe(text);
  });

  it("validates caller-built trees", () => {
    const base = { format: "tugqtree", version: 1, query: { from: { name: "T" } } } as unknown as TugQLTree;
    expect(printTugQL({ ...base, databases: [{ name: "d", target: "a\nb" }] }).diagnostics[0]?.code).toBe("invalid_database");
    expect(printTugQL({ ...base, databases: [{ name: "d" }, { name: "D" }] }).diagnostics[0]?.code).toBe("duplicate_database");
    const cte = { ...base, databases: [{ name: "sales" }], definitions: [{ kind: "cte", name: "C", query: { query: { from: { database: "geo", name: "Country" } } } }], query: { from: { database: "sales", name: "C" } } } as unknown as TugQLTree;
    expect(printTugQL(cte).diagnostics[0]?.code).toBe("undeclared_database");
  });

  it("routes a database-qualified recursive relation through resolveExecutor", async () => {
    const schemas = [{ database: "sales", version: "v1", tables: [{ name: "Invoice", fields: [{ name: "Id", type: "integer", authorized: true }] }] }];
    const parsed = parseTugQL("databases (\n  sales\n)\nfrom sales::Invoice\nselect Id");
    const resolved = resolveTugQL(parsed.document, { authorizedSchemas: schemas }).resolved!;
    const executor = (name: string): QueryExecutor => ({ query: () => Promise.resolve({ records: [{ key: key("Invoice", name), exists: true, data: { Id: 7 } }] }) }) as unknown as QueryExecutor;
    const unrouted = executeRecursiveTugQLQuery(executor("x"), resolved.query);
    await expect(unrouted).rejects.toThrow(/resolveExecutor/u);
    const rows = await executeRecursiveTugQLQuery(executor("x"), resolved.query, { resolveExecutor: (relation) => executor(relation.database ?? "") });
    expect(rows.records.map((record) => record.data)).toEqual([{ Id: 7 }]);
  });
});
