/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { formatTugQL, parseTugQL, resolveTugQL } from "../src/tugql.js";
import { executeRecursiveDTQLQuery, key, stringifyRecursiveDTQL, type QueryExecutor, type StructuredQuery } from "../src/index.js";
import type { TugQLFormatOptions, TugQLResolveContext } from "../src/tugql.js";

const tugqlFixtureRoot = new URL("./testdata/tugql/v1/", import.meta.url);
const tugqlSuiteText = readFileSync(new URL("suite.json", tugqlFixtureRoot), "utf8");
const tugqlResolveText = readFileSync(new URL("resolve.json", tugqlFixtureRoot), "utf8");
const tugqlFormatText = readFileSync(new URL("format.json", tugqlFixtureRoot), "utf8");
const tugqlExecuteText = readFileSync(new URL("execute.json", tugqlFixtureRoot), "utf8");
const tugqlBudgetText = readFileSync(new URL("budget.json", tugqlFixtureRoot), "utf8");
const tugqlManifest = new Map<string | undefined, string | undefined>(readFileSync(new URL("manifest.sha256", tugqlFixtureRoot), "utf8").trim().split(/\n/u).map((line): [string | undefined, string | undefined] => {
  const [digest, path] = line.trim().split(/\s+/u);
  return [path?.split("/").at(-1), digest];
}));

describe("TugQL syntax adapter", () => {
  it("rejects parser-created expressions deeper than the semantic tree limit", () => {
    const within = Array.from({ length: 63 }, () => "1").join("+");
    expect(parseTugQL(`from T\nselect ${within} as Total\n`).diagnostics).toEqual([]);

    const beyond = Array.from({ length: 64 }, () => "1").join("+");
    const parsed = parseTugQL(`from T\nselect ${beyond} as Total\n`);
    expect(parsed.document.tree).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe("invalid_select");
    expect(parsed.diagnostics[0]?.message).toBe("expression nesting exceeds 128");
  });
  it("does not attribute a deep predicate to an unrelated SELECT clause", () => {
    const terms = Array.from({ length: 64 }, () => "1").join("+");
    const parsed = parseTugQL(`from T\nwhere ${terms} > 0\nselect Id\n`);
    expect(parsed.document.tree).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe("document_depth_exceeded");
    expect(parsed.diagnostics[0]?.message).toBe("TugQL semantic tree depth exceeds 128");
    expect(parsed.diagnostics[0]?.span.start).toEqual({ line: 1, column: 1 });
  });
  it("keeps nested CTE depth failures at the root query span", () => {
    const within = Array.from({ length: 63 }, () => "1").join("+");
    expect(parseTugQL(`with Q as (\n  from T\n  select ${within} as Total\n)\nfrom Q\nselect Total\n`).diagnostics).toEqual([]);

    const terms = Array.from({ length: 64 }, () => "1").join("+");
    const source = `with Q as (\n  from T\n  select ${terms} as Total\n)\nfrom Q\nselect Total\n`;
    const parsed = parseTugQL(source);
    expect(parsed.document.tree).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe("document_depth_exceeded");
    expect(parsed.diagnostics[0]?.message).toBe("TugQL semantic tree depth exceeds 128");
    expect(parsed.diagnostics[0]?.span.start).toEqual({ line: 5, column: 1 });
  });
  it("attributes a deeply nested selected scalar to the root SELECT", () => {
    const within = Array.from({ length: 61 }, () => "1").join("+");
    const accepted = parseTugQL(`from T\nselect (\n  Total as (\n    from T\n    select ${within} as Value\n  )\n)\n`);
    expect(accepted.diagnostics).toEqual([]);

    const terms = Array.from({ length: 62 }, () => "1").join("+");
    const source = `from T\nselect (\n  Total as (\n    from T\n    select ${terms} as Value\n  )\n)\n`;
    const parsed = parseTugQL(source);
    expect(parsed.document.tree).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe("invalid_select");
    expect(parsed.diagnostics[0]?.message).toBe("expression nesting exceeds 128");
    expect(parsed.diagnostics[0]?.span.start).toEqual({ line: 2, column: 1 });
  });
  it("bounds mutated source-backed trees before source comparison", () => {
    const parsed = parseTugQL("from T\n");
    const tree = parsed.document.tree;
    if (tree === undefined) throw new Error("expected parsed tree");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicTree = { ...tree, query: { ...tree.query, extra: cyclic } };
    const cyclicResult = resolveTugQL({ ...parsed.document, tree: cyclicTree }, { authorizedSchemas: [], relationships: [], pinnedImports: [] });
    expect(cyclicResult.resolved).toBeUndefined();
    expect(cyclicResult.diagnostics[0]?.code).toBe("document_depth_exceeded");
    expect(cyclicResult.diagnostics[0]?.message).toBe("TugQL semantic tree depth exceeds 128");

    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let index = 0; index < 150; index += 1) {
      const child: Record<string, unknown> = {};
      current.child = child;
      current = child;
    }
    const deepTree = { ...tree, query: { ...tree.query, extra: deep } };
    const deepResult = resolveTugQL({ ...parsed.document, tree: deepTree }, { authorizedSchemas: [], relationships: [], pinnedImports: [] });
    expect(deepResult.resolved).toBeUndefined();
    expect(deepResult.diagnostics[0]?.code).toBe("document_depth_exceeded");
    expect(deepResult.diagnostics[0]?.message).toBe("TugQL semantic tree depth exceeds 128");
  });
  it("returns source parse diagnostics before traversing a mutated cyclic tree", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const document = {
      source: "from\n",
      sourceMetadata: { format: "tugql", version: 1 },
      tree: { format: "tugqtree", version: 1, query: { from: { name: "T", extra: cyclic } } },
    };
    const result = resolveTugQL(document, { authorizedSchemas: [], relationships: [], pinnedImports: [] });
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("invalid_from");
  });
  it("matches the vendored Go parser semantic JSON and diagnostics byte-for-byte", () => {
    expect(createHash("sha256").update(tugqlSuiteText).digest("hex")).toBe(tugqlManifest.get("suite.json"));
    const suite = JSON.parse(tugqlSuiteText) as { readonly format: string; readonly version: number; readonly cases: readonly { readonly name: string; readonly source: string; readonly expected: { readonly tree: unknown; readonly diagnostics: unknown } }[] };
    expect(suite.format).toBe("tugql-golden-suite");
    expect(suite.version).toBe(1);
    for (const item of suite.cases) {
      const actual = parseTugQL(item.source);
      expect(actual.document.tree ?? null, item.name).toEqual(item.expected.tree);
      expect(actual.diagnostics, item.name).toEqual(item.expected.diagnostics);
    }
  });
  it("matches the shared Go resolver corpus after engine-shape normalization", () => {
    expect(createHash("sha256").update(tugqlResolveText).digest("hex")).toBe(tugqlManifest.get("resolve.json"));
    const suite = JSON.parse(tugqlResolveText) as { readonly format: string; readonly version: number; readonly cases: readonly {
      readonly name: string; readonly source?: string; readonly tree?: unknown; readonly document?: unknown; readonly context: unknown;
      readonly parseDiagnostics: unknown; readonly expected: {
        readonly query: string | null; readonly columns: unknown; readonly schemaVersion: string;
        readonly dependencies: unknown; readonly relationships: unknown; readonly diagnostics: unknown;
      };
    }[] };
    expect(suite.format).toBe("tugql-resolve-suite");
    expect(suite.version).toBe(1);
    for (const item of suite.cases) {
      const source = item.document !== undefined && typeof item.document === "object" && item.document !== null
        ? (item.document as { readonly source?: unknown }).source
        : item.source;
      const parsed = typeof source !== "string" || source.length === 0 ? undefined : parseTugQL(source);
      const document = item.document ?? parsed?.document ?? { tree: item.tree as never, sourceMetadata: { format: "tugql", version: 1 } as const };
      expect(parsed === undefined || parsed.diagnostics.length === 0 ? null : parsed.diagnostics, `${item.name} parse`).toEqual(item.parseDiagnostics ?? null);
      const result = resolveTugQL(document, item.context as TugQLResolveContext);
      expect(result.diagnostics.length === 0 ? null : result.diagnostics, `${item.name} diagnostics`).toEqual(item.expected.diagnostics);
      const actualQueryYaml = result.resolved === undefined ? null : stringifyRecursiveDTQL(result.resolved.query);
      expect(actualQueryYaml === null ? null : normalizeScalarAliases(parseYaml(actualQueryYaml)), `${item.name} query YAML`).toEqual(item.expected.query === null ? null : normalizeScalarAliases(parseYaml(item.expected.query)));
      expect(result.resolved?.columns ?? null, `${item.name} columns`).toEqual(item.expected.columns);
      expect(result.resolved?.schemaVersion ?? "", `${item.name} schema version`).toBe(item.expected.schemaVersion);
      expect(result.resolved?.dependencies.length ? result.resolved.dependencies : null, `${item.name} dependencies`).toEqual(item.expected.dependencies);
      expect(result.resolved?.relationships.length ? result.resolved.relationships : null, `${item.name} relationships`).toEqual(item.expected.relationships);
    }
  });
  it("resolves relationship joins across the accumulated join scope", () => {
    const context: TugQLResolveContext = {
      authorizedSchemas: [{ version: "v1", tables: [
        { name: "A", fields: [{ name: "Id", type: "integer", authorized: true }, { name: "ALabel", type: "string", authorized: true }] },
        { name: "B", fields: [{ name: "Id", type: "integer", authorized: true }, { name: "BLabel", type: "string", authorized: true }] },
        { name: "C", fields: [{ name: "Id", type: "integer", authorized: true }, { name: "CLabel", type: "string", authorized: true }] },
      ] }],
      relationships: [
        { id: "ab", version: "r1", from: { source: "a", table: "A" }, to: { source: "b", table: "B" }, pairs: [{ fromField: "Id", toField: "Id" }], exactTypedEquality: true },
        { id: "bc", version: "r1", from: { source: "b", table: "B" }, to: { source: "c", table: "C" }, pairs: [{ fromField: "Id", toField: "Id" }], exactTypedEquality: true },
      ],
      pinnedImports: [],
    };
    for (const source of [
      "from A as a\njoin B as b\n  on a.Id = b.Id\njoin C as c\n  on b.Id = c.Id\n",
      "from A as a\njoin B as b\njoin C as c\n",
    ]) {
      const parsed = parseTugQL(source);
      expect(parsed.diagnostics).toEqual([]);
      const result = resolveTugQL(parsed.document, context);
      expect(result.diagnostics).toEqual([]);
      expect(result.resolved?.relationships.map(({ id }) => id)).toEqual(["ab", "bc"]);
      expect(result.resolved?.columns.find(({ name }) => name === "Id")?.lineage).toEqual([
        { source: "a", field: "Id" }, { source: "b", field: "Id" }, { source: "c", field: "Id" },
      ]);
    }
  });
  it("uses the shared numeric whitelist and safe arithmetic output type", () => {
    for (const type of ["int", "float", "int32", "int64", "float32", "float64", "number"] as const) {
      const parsed = parseTugQL("from T as t\nselect t.Value + 1 as Result\n");
      const result = resolveTugQL(parsed.document, {
        authorizedSchemas: [{ version: "v1", tables: [{ name: "T", fields: [{ name: "Value", type, authorized: true }] }] }],
        relationships: [], pinnedImports: [],
      });
      expect(result.diagnostics, type).toEqual([]);
      expect(result.resolved?.columns[0]?.type, type).toBe("number");
    }
    for (const type of ["decimal", "numeric"] as const) {
      const parsed = parseTugQL("from T as t\nselect t.Value + 1 as Result\n");
      const result = resolveTugQL(parsed.document, {
        authorizedSchemas: [{ version: "v1", tables: [{ name: "T", fields: [{ name: "Value", type, authorized: true }] }] }],
        relationships: [], pinnedImports: [],
      });
      expect(result.resolved, type).toBeUndefined();
      expect(result.diagnostics[0]?.code, type).toBe("unsupported_decimal_semantics");
    }
    const realParsed = parseTugQL("from T as t\nselect t.Value + 1 as Result\n");
    const realResult = resolveTugQL(realParsed.document, {
      authorizedSchemas: [{ version: "v1", tables: [{ name: "T", fields: [{ name: "Value", type: "real", authorized: true }] }] }],
      relationships: [], pinnedImports: [],
    });
    expect(realResult.resolved).toBeUndefined();
    expect(realResult.diagnostics[0]?.code).toBe("unsupported_output_type");
    expect(realResult.diagnostics[0]?.message).toBe("arithmetic requires supported numeric operands");
  });
  it("rejects SUM and AVG when their input type is not numeric", () => {
    for (const functionName of ["sum", "avg"]) {
      const parsed = parseTugQL(`from T as t\nselect ${functionName}(t.Name) as Result\n`);
      const result = resolveTugQL(parsed.document, {
        authorizedSchemas: [{ version: "v1", tables: [{ name: "T", fields: [{ name: "Name", type: "string", authorized: true }] }] }],
        relationships: [], pinnedImports: [],
      });
      expect(result.resolved, functionName).toBeUndefined();
      expect(result.diagnostics[0]?.code, functionName).toBe("unsupported_output_type");
      expect(result.diagnostics[0]?.message, functionName).toBe("SUM/AVG requires a supported numeric argument");
    }
  });
  it("fails closed on exact and unsupported query-wide expression semantics", () => {
    const schema = { authorizedSchemas: [{ version: "v1", tables: [{ name: "T", fields: [
      { name: "Id", type: "integer", authorized: true },
      { name: "Amount", type: "decimal", authorized: true },
      { name: "Label", type: "string", authorized: true },
      { name: "CreatedAt", type: "timestamp", authorized: true },
      { name: "DateOnly", type: "date", authorized: true },
      { name: "OpaqueId", type: "uuid", authorized: true },
    ] }] }], relationships: [], pinnedImports: [] } as const;
    const cases = [
      ["from T as t\nwhere t.Amount + 1 > 5\nselect t.Id\n", "unsupported_decimal_semantics"],
      ["from T as t\nhaving SUM(t.Amount) > 5\nselect t.Id\n", "unsupported_decimal_semantics"],
      ["from T as t\norder by t.Amount\nselect t.Id\n", "unsupported_decimal_semantics"],
      ["from T as t\norder by t.Id + 1\nselect t.Id\n", "unsupported_order_expression"],
      ["from T as t\nwhere t.Label + 1 > 5\nselect t.Id\n", "unsupported_output_type"],
      ["from T as t\nwhere t.Label > t.Id\nselect t.Id\n", "unsupported_comparison_type"],
      ["from T as t\nwhere t.CreatedAt > '2026-01-01T00:00:00Z'\nselect t.Id\n", "unsupported_temporal_semantics"],
      ["from T as t\nwhere t.OpaqueId > t.OpaqueId\nselect t.Id\n", "unsupported_comparison_type"],
    ] as const;
    for (const [source, code] of cases) {
      const parsed = parseTugQL(source);
      expect(parsed.diagnostics).toEqual([]);
      const result = resolveTugQL(parsed.document, schema);
      expect(result.resolved, source).toBeUndefined();
      expect(result.diagnostics[0]?.code, source).toBe(code);
    }
    const date = parseTugQL("from T as t\nwhere t.DateOnly > '2026-01-01'\nselect t.Id\n");
    expect(resolveTugQL(date.document, schema).diagnostics).toEqual([]);
  });
  it("matches the shared Go formatter corpus", () => {
    expect(createHash("sha256").update(tugqlFormatText).digest("hex")).toBe(tugqlManifest.get("format.json"));
    const suite = JSON.parse(tugqlFormatText) as { readonly format: string; readonly version: number; readonly cases: readonly {
      readonly name: string; readonly source: string; readonly options: TugQLFormatOptions;
      readonly expected: { readonly source: string; readonly diagnostics: unknown };
    }[] };
    expect(suite.format).toBe("tugql-format-suite");
    expect(suite.version).toBe(1);
    for (const item of suite.cases) {
      const actual = formatTugQL(item.source, item.options);
      expect(actual.source, `${item.name} formatted source`).toBe(item.expected.source);
      expect(actual.diagnostics.length === 0 ? null : actual.diagnostics, `${item.name} diagnostics`).toEqual(item.expected.diagnostics);
      expect(formatTugQL(actual.source, item.options).source, `${item.name} idempotence`).toBe(actual.source);
    }
  });
  it("matches shared scalar execution cardinality behavior", async () => {
    expect(createHash("sha256").update(tugqlExecuteText).digest("hex")).toBe(tugqlManifest.get("execute.json"));
    const suite = JSON.parse(tugqlExecuteText) as { readonly format: string; readonly version: number; readonly cases: readonly {
      readonly name: string; readonly source: string; readonly context: TugQLResolveContext;
      readonly input: { readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>> };
      readonly expected: { readonly records?: readonly Record<string, unknown>[]; readonly error?: { readonly code: string; readonly path: string } };
    }[] };
    expect(suite.format).toBe("tugql-execute-suite");
    expect(suite.version).toBe(1);
    for (const item of suite.cases) {
      const parsed = parseTugQL(item.source);
      expect(parsed.diagnostics, `${item.name} parse`).toEqual([]);
      const resolution = resolveTugQL(parsed.document, item.context);
      expect(resolution.diagnostics, `${item.name} resolve`).toEqual([]);
      if (resolution.resolved === undefined) throw new Error(`${item.name}: expected resolved query`);
      const executor: QueryExecutor = {
        query<T>(query: StructuredQuery<T>) {
          const rows = item.input.tables[query.source.name] ?? [];
          return Promise.resolve({ records: rows.map((data, index) => ({ key: key(query.source.name, String(index)), exists: true as const, data: data as T })) });
        },
      };
      try {
        const result = await executeRecursiveDTQLQuery(executor, resolution.resolved.query);
        expect(item.expected.error, `${item.name} error`).toBeUndefined();
        expect(result.records.map((record) => record.data), `${item.name} records`).toEqual(item.expected.records);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (item.expected.error === undefined) throw error;
        const match = /^cardinality at (.+):/u.exec(message);
        expect(item.expected.error, `${item.name} expected error`).toEqual(match === null ? null : { code: "cardinality", path: match[1] });
      }
    }
  });
  it("matches the generated shared semantic-budget corpus", () => {
    expect(createHash("sha256").update(tugqlBudgetText).digest("hex")).toBe(tugqlManifest.get("budget.json"));
    const suite = JSON.parse(tugqlBudgetText) as { readonly format: string; readonly version: number; readonly cases: readonly {
      readonly name: string; readonly kind: "columns" | "parameters"; readonly count: number; readonly expectedCode: string;
    }[] };
    expect(suite.format).toBe("tugql-budget-suite");
    expect(suite.version).toBe(1);
    const context: TugQLResolveContext = {
      authorizedSchemas: [{ version: "v1", tables: [{ name: "T", fields: [{ name: "Id", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [],
    };
    for (const item of suite.cases) {
      const tree = {
        format: "tugqtree", version: 1,
        ...(item.kind === "parameters" ? {
          parameters: Array.from({ length: item.count }, (_, index) => ({ name: `P${String(index)}`, type: "integer", default: 1 })),
        } : {}),
        query: {
          from: { name: "T" },
          ...(item.kind === "columns" ? {
            columns: Array.from({ length: item.count }, (_, index) => ({ field: "Id", as: `c${String(index)}` })),
          } : {}),
        },
      } as const;
      const result = resolveTugQL({ tree, sourceMetadata: { format: "tugql", version: 1 } }, context);
      expect(result.resolved !== undefined, `${item.name} resolved`).toBe(item.expectedCode === "");
      expect(result.diagnostics[0]?.code ?? "", `${item.name} diagnostic`).toBe(item.expectedCode);
    }
  });
  it("preserves source separately from a versioned TugQTree", () => {
    const source = "from Invoice as i\nwhere i.Total >= 1\nselect i.InvoiceId as ID\n";
    const { document, diagnostics } = parseTugQL(source);
    expect(diagnostics).toEqual([]);
    expect(document.source).toBe(source);
    expect(document.sourceMetadata).toMatchObject({ format: "tugql", version: 1 });
    expect(document.tree).toEqual({
      format: "tugqtree", version: 1,
      query: {
        from: { name: "Invoice", alias: "i" },
        where: { op: ">=", left: { field: "Total", source: "i" }, right: { value: 1 } },
        columns: [{ field: "InvoiceId", source: "i", as: "ID" }],
      },
    });
  });
  it("does not treat qualified field and function names as reserved words", () => {
    const sources = [
      "from Invoice as i\nselect i.Date\n",
      "from Invoice as i\nselect Date(i.InvoiceId) as Day\n",
      "FROM Invoice AS i\nSELECT i.date\n",
    ];
    for (const source of sources) expect(parseTugQL(source).diagnostics).toEqual([]);
    expect(formatTugQL(sources[1] ?? "", { keywordCase: "uppercase" }).source).toBe("FROM Invoice AS i\nSELECT Date(i.InvoiceId) AS Day\n");
  });
  it("rejects unknown nested fields in source-free caller-built trees", () => {
    const parsed = parseTugQL("from Invoice as i\nselect i.Id\n");
    const tree = structuredClone(parsed.document.tree) as unknown as { query: { from: Record<string, unknown> } };
    tree.query.from.unknownNested = "surprise";
    const result = resolveTugQL({ tree: tree as never, sourceMetadata: parsed.document.sourceMetadata }, {
      authorizedSchemas: [{ version: "s1", tables: [{ name: "Invoice", fields: [{ name: "Id", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [], bindings: [],
    });
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics).toEqual([{
      code: "invalid_tree",
      message: "invalid TugQTree query: yaml: unmarshal errors:\n  field unknownNested not found in from",
      span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    }]);
  });
  it("rejects unauthorized fields inside EXISTS and NOT EXISTS predicates", () => {
    const document = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      query: {
        from: { name: "Invoice", alias: "i" },
        columns: [{ field: "InvoiceId", source: "i" }],
        where: { notExists: { query: {
          from: { name: "Customer", alias: "c" },
          columns: [{ field: "Id", source: "c" }],
          where: { op: "==", left: { field: "Secret", source: "c" }, right: { value: "x" } },
        } } },
      },
    } } as const;
    const result = resolveTugQL(document, {
      authorizedSchemas: [{ version: "r1", tables: [
        { name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] },
        { name: "Customer", fields: [{ name: "Id", type: "integer", authorized: true }, { name: "Secret", type: "string", authorized: false }] },
      ] }], relationships: [], pinnedImports: [],
    });
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("unauthorized_field");
  });
  it("lowers CTE-backed EXISTS queries through source resolution and metadata collection", () => {
    const document = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      definitions: [{ kind: "cte", name: "CustomerIds", query: { query: {
        from: { name: "Customer", alias: "c0" }, columns: [{ field: "Id", source: "c0" }],
      } } }],
      query: {
        from: { name: "Invoice", alias: "i" }, columns: [{ field: "InvoiceId", source: "i" }],
        where: { exists: { query: {
          from: { name: "CustomerIds", alias: "c" }, columns: [{ field: "Id", source: "c" }],
          where: { op: "==", left: { field: "Id", source: "c" }, right: { field: "CustomerId", source: "i" } },
        } } },
      },
    } } as const;
    const result = resolveTugQL(document, {
      authorizedSchemas: [
        { version: "customer-v1", tables: [{ name: "Customer", fields: [{ name: "Id", type: "integer", authorized: true }] }] },
        { version: "invoice-v1", tables: [{ name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }, { name: "CustomerId", type: "integer", authorized: true }] }] },
      ], relationships: [], pinnedImports: [],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved?.schemaVersion).toBe("customer-v1,invoice-v1");
    expect(result.resolved?.query.where).toMatchObject({ kind: "exists" });
  });
  it("does not reuse nested CTE relationship evidence for the enclosing default projection", () => {
    const document = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      definitions: [{ kind: "cte", name: "Joined", query: { query: {
        from: { name: "Invoice", alias: "i", joins: [{ from: { name: "Customer", alias: "c" }, on: [{
          op: "==", left: { field: "InvoiceId", source: "i" }, right: { field: "CustomerId", source: "c" },
        }] }] },
        where: { exists: { query: {
          from: { name: "Invoice", alias: "i", joins: [{ from: { name: "Customer", alias: "c" }, on: [{
            op: "==", left: { field: "CustomerId", source: "i" }, right: { field: "Id", source: "c" },
          }] }] },
          columns: [{ field: "Id", source: "c" }],
        } } },
      } } }],
      query: { from: { name: "Joined", alias: "j" } },
    } } as const;
    const result = resolveTugQL(document, {
      authorizedSchemas: [{ version: "schema-v1", tables: [
        { name: "Invoice", fields: [
          { name: "CustomerId", type: "integer", authorized: true },
          { name: "InvoiceId", type: "integer", authorized: true },
        ] },
        { name: "Customer", fields: [
          { name: "Id", type: "integer", authorized: true },
          { name: "CustomerId", type: "integer", authorized: true },
        ] },
      ] }],
      relationships: [{ id: "invoice-customer", version: "r1", from: { source: "i", table: "Invoice" }, to: { source: "c", table: "Customer" }, pairs: [{ fromField: "CustomerId", toField: "Id" }], exactTypedEquality: true }],
      pinnedImports: [],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved?.relationships).toHaveLength(1);
    const columns = new Map(result.resolved?.columns.map((column) => [column.name, column.lineage]));
    expect(columns.get("CustomerId")).toEqual([{ source: "i", field: "CustomerId" }]);
    expect(columns.get("c_CustomerId")).toEqual([{ source: "c", field: "CustomerId" }]);
  });
  it("rejects unsupported local definitions in the EXISTS body wire shape", () => {
    const parsed = parseTugQL("from Invoice as i\nselect i.InvoiceId\n");
    const tree = structuredClone(parsed.document.tree) as unknown as { query: Record<string, unknown> };
    tree.query.where = { exists: {
      definitions: [{ kind: "cte", name: "Local", query: { query: { from: { name: "Invoice" } } } }],
      query: { from: { name: "Invoice" } },
    } };
    const result = resolveTugQL({ sourceMetadata: parsed.document.sourceMetadata, tree: tree as never }, {
      authorizedSchemas: [{ version: "s1", tables: [{ name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [],
    });
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("invalid_tree");
  });
  it("rejects unsupported calls nested inside EXISTS", () => {
    const document = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      query: {
        from: { name: "Invoice", alias: "i" }, columns: [{ field: "InvoiceId", source: "i" }],
        where: { exists: { query: {
          from: { name: "Invoice", alias: "inner" }, columns: [{ call: { function: "COALESCE", args: [{ field: "InvoiceId", source: "inner" }, { value: 0 }] }, as: "Value" }],
        } } },
      },
    } } as const;
    const result = resolveTugQL(document, {
      authorizedSchemas: [{ version: "s1", tables: [{ name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [],
    });
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("unsupported_function");
  });
  it("records relationship expansions used by EXISTS joins", () => {
    const document = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      query: {
        from: { name: "Invoice", alias: "i" }, columns: [{ field: "InvoiceId", source: "i" }],
        where: { exists: { query: {
          from: { name: "Invoice", alias: "inner" , joins: [{ from: { name: "Customer", alias: "c" }, on: [] }] },
          columns: [{ field: "Name", source: "c" }],
        } } },
      },
    } } as const;
    const result = resolveTugQL(document, {
      authorizedSchemas: [{ version: "s1", tables: [
        { name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }, { name: "CustomerId", type: "integer", authorized: true }] },
        { name: "Customer", fields: [{ name: "CustomerId", type: "integer", authorized: true }, { name: "Name", type: "string", authorized: true }] },
      ] }],
      relationships: [{ id: "fk-invoice-customer", version: "r1", from: { table: "Invoice" }, to: { table: "Customer" }, pairs: [{ fromField: "CustomerId", toField: "CustomerId" }], exactTypedEquality: true }],
      pinnedImports: [],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved?.relationships).toEqual([{
      id: "fk-invoice-customer", version: "r1", fromSource: "inner", toSource: "c", joinType: "inner",
      pairs: [{ fromField: "CustomerId", toField: "CustomerId" }],
    }]);
  });
  it("retains pinned import receipts when an imported relation is used inside EXISTS", () => {
    const document = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      definitions: [{ kind: "import", name: "SavedCustomers", path: "./customers.tql" }],
      query: {
        from: { name: "Invoice", alias: "i" }, columns: [{ field: "InvoiceId", source: "i" }],
        where: { exists: { query: {
          from: { name: "SavedCustomers", alias: "c" }, columns: [{ field: "CustomerId", source: "c" }],
        } } },
      },
    } } as const;
    const result = resolveTugQL(document, {
      projectRoot: "project", importingPath: "queries/main.tql", projectRevision: "revision-1",
      authorizedSchemas: [{ version: "s1", tables: [
        { name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] },
        { name: "Customer", fields: [{ name: "CustomerId", type: "integer", authorized: true }] },
      ] }], relationships: [], pinnedImports: [{ path: "queries/customers.tql", revision: "revision-1", source: "from Customer as c\nselect c.CustomerId\n" }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved?.dependencies).toEqual([{ path: "queries/customers.tql", revision: "revision-1" }]);
    expect(result.resolved?.schemaVersion).toBe("s1");
  });
  it("bounds source-free tree depth, node count, and repeated CTE expansion", () => {
    const context = { authorizedSchemas: [{ version: "s1", tables: [{ name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] }] }], relationships: [], pinnedImports: [] } as const;
    let deepBody: { definitions?: readonly unknown[]; query: Record<string, unknown> } = { query: { from: { name: "Invoice" }, columns: [{ field: "InvoiceId", source: "i" }] } };
    for (let index = 0; index < 130; index += 1) deepBody = { definitions: [{ kind: "cte", name: `Q${String(index)}`, query: deepBody }], query: { from: { name: `Q${String(index)}` }, columns: [{ field: "InvoiceId", source: "i" }] } };
    const deepDocument = { sourceMetadata: { format: "tugql", version: 1 }, tree: { format: "tugqtree", version: 1, definitions: deepBody.definitions, query: deepBody.query } } as const;
    expect(resolveTugQL(deepDocument, context).diagnostics[0]?.code).toBe("document_depth_exceeded");

    const repeatedColumn = { field: "InvoiceId", source: "i", as: "Value" };
    const oversizedColumns = Array.from({ length: 100_000 }, () => repeatedColumn);
    const oversizedDocument = { sourceMetadata: { format: "tugql", version: 1 }, tree: { format: "tugqtree", version: 1, query: { from: { name: "Invoice", alias: "i" }, columns: oversizedColumns } } } as const;
    expect(resolveTugQL(oversizedDocument, context).diagnostics[0]?.code).toBe("document_node_limit");

    const fanoutSource = [
      "with Q0 as (", "  from Invoice as i", "  select i.InvoiceId", ")",
      ...Array.from({ length: 8 }, (_value, index) => [
        `with Q${String(index + 1)} as (`,
        `  from Q${String(index)} as l`,
        `  join Q${String(index)} as r`,
        "    on l.InvoiceId = r.InvoiceId",
        "  select l.InvoiceId",
        ")",
      ]).flat(),
      "from Q8 as q",
      "select q.InvoiceId",
    ].join("\n");
    const parsed = parseTugQL(fanoutSource);
    expect(parsed.diagnostics).toEqual([]);
    const fanoutResult = resolveTugQL(parsed.document, context);
    expect(fanoutResult.diagnostics[0]).toEqual({ code: "document_node_limit", message: "TugQL semantic tree exceeds 5000 nodes", span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } });
    const unusedFanout = parseTugQL(fanoutSource.replace("from Q8 as q\nselect q.InvoiceId", "from Invoice as i\nselect i.InvoiceId"));
    expect(unusedFanout.diagnostics).toEqual([]);
    expect(resolveTugQL(unusedFanout.document, context).diagnostics[0]?.code).toBe("document_node_limit");

    const wideProjection = Array.from({ length: 1_500 }, (_value, index) => ({ field: "InvoiceId", source: "i", as: `Field${String(index)}` }));
    const nestedExpansionDocument = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      definitions: [{ kind: "cte", name: "Wide", query: { query: { from: { name: "Invoice", alias: "i" }, columns: wideProjection } } }],
      query: { from: { name: "Invoice", alias: "i" }, columns: [{ field: "InvoiceId", source: "i" }], where: { exists: { query: { from: { name: "Wide", alias: "w" }, columns: [{ field: "Field0", source: "w" }] } } } },
    } } as const;
    expect(resolveTugQL(nestedExpansionDocument, context).diagnostics[0]?.code).toBe("document_node_limit");
  });

  it("matches the Go semantic-node budget for generated projections and parameters", () => {
    const context = { authorizedSchemas: [{ version: "s1", tables: [{ name: "T", fields: [{ name: "Id", type: "integer", authorized: true }] }] }], relationships: [], pinnedImports: [] } as const;
    const projection = (count: number) => ({ sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      query: { from: { name: "T" }, columns: Array.from({ length: count }, (_value, index) => ({ field: "Id", as: `Column${String(index)}` })) },
    } } as const);
    const atNodeLimit = resolveTugQL(projection(1_665), context);
    expect(atNodeLimit.diagnostics).toEqual([]);
    expect(atNodeLimit.resolved?.columns).toHaveLength(1_665);
    expect(resolveTugQL(projection(1_666), context).diagnostics[0]?.code).toBe("document_node_limit");

    const manyParameters = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      parameters: Array.from({ length: 2_000 }, (_value, index) => ({ name: `P${String(index)}`, type: "integer", default: 1 })),
      query: { from: { name: "T" }, columns: [{ field: "Id" }] },
    } } as const;
    expect(resolveTugQL(manyParameters, context).diagnostics).toEqual([]);
  });

  it("keeps typed parameter defaults exact and emits runtime parameters in the tree", () => {
    const { document, diagnostics } = parseTugQL("parameters (\n  @Minimum decimal default 12.340\n)\nfrom Invoice as i\nwhere i.Total >= @Minimum\n");
    expect(diagnostics).toEqual([]);
    expect(document.tree?.parameters).toEqual([{ name: "Minimum", type: "decimal", default: "12.340" }]);
    expect(document.tree?.query.where).toEqual({ op: ">=", left: { field: "Total", source: "i" }, right: { param: "Minimum" } });
  });

  it("rejects a long malformed exact decimal without excessive validation time", () => {
    const document = { sourceMetadata: { format: "tugql", version: 1 }, tree: {
      format: "tugqtree", version: 1,
      parameters: [{ name: "Amount", type: "decimal", default: `${"0".repeat(100_000)}!` }],
      query: { from: { name: "T" }, columns: [{ field: "Id" }] },
    } } as const;
    const start = performance.now();
    const result = resolveTugQL(document, { schema: { sources: [{ name: "T", authorized: true, columns: [{ name: "Id", type: "integer", authorized: true }] }] } });
    expect(result.diagnostics[0]?.code).toBe("invalid_parameter_default");
    // A generous bound separates linear scanning from the former quadratic regex.
    expect(performance.now() - start).toBeLessThan(1_000);
  }, 15_000);

  it("preserves signed parameter defaults, validates real dates, and rejects unpaired surrogates", () => {
    const valid = parseTugQL("parameters (\n  @Count integer default -12\n  @Ratio decimal default +0.075\n  @Day date default '2024-02-29'\n)\nfrom Invoice\n");
    expect(valid.diagnostics).toEqual([]);
    expect(valid.document.tree?.parameters).toEqual([
      { name: "Count", type: "integer", default: -12 },
      { name: "Ratio", type: "decimal", default: "+0.075" },
      { name: "Day", type: "date", default: "2024-02-29" },
    ]);
    expect(parseTugQL("parameters (\n  @Day date default '2025-02-29'\n)\nfrom Invoice\n").diagnostics[0]?.code).toBe("invalid_parameter");
    expect(parseTugQL("from \ud800\n").diagnostics).toEqual([{ code: "invalid_utf8", message: "TugQL source must be valid UTF-8", span: { start: { line: 1, column: 6 }, end: { line: 1, column: 7 } } }]);
  });

  it("retains repeated WITH definitions and nested definition bodies in lexical order", () => {
    const source = [
      "with inner as (",
      "  from Invoice as i",
      "  select i.CustomerId, sum(i.Total) as Total",
      ")",
      "with outer as (",
      "  with byCustomer as (",
      "    from inner as x",
      "    select x.CustomerId, x.Total",
      "  )",
      "  from byCustomer as y",
      "  select y.CustomerId, y.Total",
      ")",
      "from outer as o",
      "select o.Total",
    ].join("\n");
    const { document, diagnostics } = parseTugQL(source);
    expect(diagnostics).toEqual([]);
    expect(document.tree?.definitions?.map((definition) => definition.name)).toEqual(["inner", "outer"]);
    expect(document.tree?.definitions?.[1]).toMatchObject({
      kind: "cte", name: "outer", query: {
        definitions: [{ kind: "cte", name: "byCustomer" }],
        query: { from: { name: "byCustomer", alias: "y" } },
      },
    });
  });

  it("preserves COALESCE as a scalar call and keeps quoted commas inside one argument", () => {
    const { document, diagnostics } = parseTugQL("from Invoice as i\nselect COALESCE(i.Note, 'a,b') as Note\n");
    expect(diagnostics).toEqual([]);
    expect(document.tree?.query.columns).toEqual([{ call: { function: "COALESCE", args: [{ field: "Note", source: "i" }, { value: "a,b" }] }, as: "Note" }]);
  });

  it("rejects mixed keyword case and same-line clauses while retaining the source", () => {
    const mixed = parseTugQL("From Invoice as i\n");
    expect(mixed.diagnostics.map((item) => item.code)).toContain("keyword_case");
    expect(mixed.document.tree).toBeUndefined();
    expect(mixed.document.source).toBe("From Invoice as i\n");

    const sameLine = parseTugQL("from Invoice select InvoiceId\n");
    expect(sameLine.diagnostics).toContainEqual(expect.objectContaining({
      code: "multiple_clauses_same_line", span: { start: { line: 1, column: 14 }, end: { line: 1, column: 20 } },
    }));
    expect(sameLine.document.tree).toBeUndefined();
  });

  it("counts Unicode scalar columns and treats bare CR as a line ending", () => {
    const source = "-- header\rfrom t\rselect \"😀\" as\r";
    const { document, diagnostics } = parseTugQL(source);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid_select", span: { start: { line: 3, column: 1 }, end: { line: 3, column: 14 } },
    }));
    expect(document.source).toBe(source);
  });

  it("repairs case and indentation without changing comments, quoted names, strings or function names", () => {
    const draft = "-- FROM stays a comment\nFrOm   \"Order\" As o\n   WhErE o.Note = 'FROM, MiXeD'\n     AnD o.Id > 1\nSeLeCt CoAlEsCe(o.Note, 'x') As Note\n";
    const formatted = formatTugQL(draft, { keywordCase: "lowercase", indentation: "two-spaces" });
    expect(formatted.source).toBe("-- FROM stays a comment\nfrom   \"Order\" as o\nwhere o.Note = 'FROM, MiXeD'\n  and o.Id > 1\nselect CoAlEsCe(o.Note, 'x') as Note\n");
    expect(formatted.diagnostics).toEqual([]);
    expect(formatTugQL(formatted.source, { keywordCase: "lowercase", indentation: "two-spaces" }).source).toBe(formatted.source);
  });

  it("preserves invalid multiline quoted tokens with Go-compatible diagnostics", () => {
    const source = "FrOm Invoice as i\r\nWhErE i.Note = 'first\r\n  second\rthird'\rSeLeCt i.InvoiceId";
    const formatted = formatTugQL(source, { keywordCase: "lowercase", indentation: "two-spaces" });
    expect(formatted.source).toBe(source);
    expect(formatted.diagnostics).toEqual(parseTugQL(source).diagnostics);
    expect(formatted.diagnostics.map((item) => item.code)).toContain("unterminated_quote");

    const withEscapedQuotes = "from \"In\"\"voice\n  Archive\" as i\nwhere i.Note = 'first''\n  second'\nselect i.InvoiceId";
    const escaped = formatTugQL(withEscapedQuotes, { keywordCase: "uppercase", indentation: "tab" });
    expect(escaped.source).toBe(withEscapedQuotes);
    expect(escaped.diagnostics).toEqual(parseTugQL(withEscapedQuotes).diagnostics);
  });

  it("selects formatter styles by project, user, source, then application precedence", () => {
    const source = "-- SELECT in a comment is ignored\nWITH X AS (\n\tFROM Invoice\n\tSELECT InvoiceId\n)\nFROM X\n";
    expect(formatTugQL(source, { projectTeamKeywordCase: "uppercase", userKeywordCase: "lowercase", projectTeamIndentation: "tab", userIndentation: "two-spaces" }).source)
      .toBe(source);
    expect(formatTugQL(source, { projectTeamKeywordCase: "preserve-existing", userKeywordCase: "lowercase", projectTeamIndentation: "preserve-existing", userIndentation: "tab" }).source)
      .toBe(source);
    expect(formatTugQL("FrOm Invoice\n", { defaultKeywordCase: "uppercase" }).source).toBe("FROM Invoice\n");
    const mixedIndent = "with X as (\n  from Invoice\n\tselect InvoiceId\n)\nfrom X\n";
    expect(formatTugQL(mixedIndent, { defaultIndentation: "tab" }).source)
      .toBe("with X as (\n\tfrom Invoice\n\tselect InvoiceId\n)\nfrom X\n");
  });

  it("resolves an explicitly bound typed parameter without interpolation", () => {
    const { document, diagnostics } = parseTugQL("parameters (\n  @Minimum integer required\n)\nfrom Invoice as i\nwhere i.InvoiceId >= @Minimum\nselect i.InvoiceId as ID\n");
    expect(diagnostics).toEqual([]);
    const resolved = resolveTugQL(document, {
      projectRoot: "repo",
      importingPath: "queries/main.tugql",
      projectRevision: "rev-1",
      authorizedSchemas: [{ version: "schema-1", tables: [{ name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [], bindings: [{ name: "Minimum", set: true, value: 4 }],
    });
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.resolved?.query.where).toMatchObject({ kind: "comparison", right: { kind: "literal", value: 4 } });
    expect(resolved.resolved?.columns).toEqual([{ name: "ID", type: "integer", lineage: [{ source: "i", field: "InvoiceId" }] }]);
  });

  it("executes a parameterized TugQL query only after typed literal binding", async () => {
    const { document } = parseTugQL("parameters (\n  @Minimum integer required\n)\nfrom Invoice as i\nwhere i.InvoiceId >= @Minimum\nselect i.InvoiceId\n");
    const context = {
      projectRoot: "repo", importingPath: "queries/main.tugql", projectRevision: "rev-1",
      authorizedSchemas: [{ version: "schema-1", tables: [{ name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [], bindings: [{ name: "Minimum", set: true, value: 4 }],
    } as const;
    const resolution = resolveTugQL(document, context);
    expect(resolution.diagnostics).toEqual([]);
    const executor: QueryExecutor = {
      query<T>(query: StructuredQuery<T>) {
        const ids = query.source.name === "Invoice" ? [1, 5] : [];
        return Promise.resolve({ records: ids.map((id) => ({ key: key("Invoice", String(id)), exists: true as const, data: { InvoiceId: id } as T })) });
      },
    };
    if (resolution.resolved === undefined) throw new Error("expected resolved query");
    const output = await executeRecursiveDTQLQuery(executor, resolution.resolved.query);
    expect(output.records.map((record) => record.data)).toEqual([{ InvoiceId: 5 }]);
  });

  it("lowers earlier CTE definitions while preserving source lineage", () => {
    const { document } = parseTugQL("with Invoices as (\n  from Invoice as i\n  select i.CustomerId\n)\nfrom Invoices as v\nselect v.CustomerId\n");
    const result = resolveTugQL(document, {
      projectRoot: "repo", importingPath: "queries/main.tugql", projectRevision: "rev-1",
      authorizedSchemas: [{ version: "schema-1", tables: [{ name: "Invoice", fields: [{ name: "CustomerId", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [], bindings: [],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved?.query.from.kind).toBe("query");
    expect(result.resolved?.columns).toEqual([{ name: "CustomerId", type: "integer", lineage: [{ source: "i", field: "CustomerId" }] }]);
  });

  it("merges omitted INNER join keys only for a complete exact typed relationship", () => {
    const relationship = { id: "invoice-customer", version: "s1", from: { table: "Invoice", source: "i" }, to: { table: "Customer", source: "c" }, pairs: [{ fromField: "CustomerId", toField: "Id" }, { fromField: "TenantId", toField: "TenantId" }], exactTypedEquality: true } as const;
    const context = {
      authorizedSchemas: [{ version: "s1", tables: [
        { name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }, { name: "CustomerId", type: "integer", authorized: true }, { name: "TenantId", type: "integer", authorized: true }] },
        { name: "Customer", fields: [{ name: "Id", type: "integer", authorized: true }, { name: "TenantId", type: "integer", authorized: true }, { name: "Name", type: "string", authorized: true }] },
      ] }], relationships: [relationship], pinnedImports: [],
    } as const;
    const shorthand = parseTugQL("from Invoice as i\njoin Customer as c\n  on CustomerId\n");
    expect(shorthand.diagnostics).toEqual([]);
    const merged = resolveTugQL(shorthand.document, context);
    expect(merged.diagnostics).toEqual([]);
    if (merged.resolved === undefined) throw new Error("expected resolved relationship query");
    expect(merged.resolved.query.from.joins[0].on).toHaveLength(2);
    expect(merged.resolved.relationships).toEqual([{ id: relationship.id, version: relationship.version, fromSource: "i", toSource: "c", joinType: "inner", pairs: relationship.pairs }]);
    expect(merged.resolved.columns).toEqual([
      { name: "InvoiceId", type: "integer", lineage: [{ source: "i", field: "InvoiceId" }] },
      { name: "CustomerId", type: "integer", lineage: [{ source: "i", field: "CustomerId" }, { source: "c", field: "Id" }] },
      { name: "TenantId", type: "integer", lineage: [{ source: "i", field: "TenantId" }, { source: "c", field: "TenantId" }] },
      { name: "Name", type: "string", lineage: [{ source: "c", field: "Name" }] },
    ]);

    const leftJoin = parseTugQL("from Invoice as i\nleft join Customer as c\n  on i.CustomerId = c.Id\n");
    const leftRelationship = { ...relationship, pairs: [relationship.pairs[0]] };
    const leftResult = resolveTugQL(leftJoin.document, { ...context, relationships: [leftRelationship] });
    expect(leftResult.diagnostics).toEqual([]);
    expect(leftResult.resolved?.relationships[0]?.joinType).toBe("left");
    expect(leftResult.resolved?.columns.map((column) => column.lineage)).toContainEqual([{ source: "i", field: "CustomerId" }]);
    expect(leftResult.resolved?.columns.map((column) => column.lineage)).toContainEqual([{ source: "c", field: "Id" }]);

    const explicit = parseTugQL("from Invoice as i\njoin Customer as c\n  on i.CustomerId = c.Id\n");
    const nonExact = resolveTugQL(explicit.document, { ...context, relationships: [{ ...leftRelationship, exactTypedEquality: false }] });
    expect(nonExact.diagnostics).toEqual([]);
    expect(nonExact.resolved?.columns.map((column) => column.lineage)).toContainEqual([{ source: "i", field: "CustomerId" }]);
    expect(nonExact.resolved?.columns.map((column) => column.lineage)).toContainEqual([{ source: "c", field: "Id" }]);
  });

  it("resolves and executes a correlated scalar query with one output per outer row", async () => {
    const { document, diagnostics } = parseTugQL("from Invoice as i\nselect (\n  i.InvoiceId\n  CustomerName as (\n    from Customer as c\n    where c.CustomerId = i.CustomerId\n    select c.Name\n  )\n)\n");
    expect(diagnostics).toEqual([]);
    const result = resolveTugQL(document, {
      projectRoot: "repo", importingPath: "queries/main.tugql", projectRevision: "rev-1",
      authorizedSchemas: [{ version: "schema-1", tables: [
        { name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }, { name: "CustomerId", type: "integer", authorized: true }] },
        { name: "Customer", fields: [{ name: "CustomerId", type: "integer", authorized: true }, { name: "Name", type: "string", authorized: true }] },
      ] }], relationships: [], pinnedImports: [], bindings: [],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved?.columns).toEqual([
      { name: "InvoiceId", type: "integer", lineage: [{ source: "i", field: "InvoiceId" }] },
      { name: "CustomerName", type: "string", lineage: [{ source: "c", field: "Name" }] },
    ]);
    if (result.resolved === undefined) throw new Error("expected resolved scalar query");
    const executor: QueryExecutor = {
      query<T>(query: StructuredQuery<T>) {
        const rows = query.source.name === "Invoice"
          ? [{ InvoiceId: 7, CustomerId: 2 }]
          : [{ CustomerId: 2, Name: "Ada" }, { CustomerId: 3, Name: "Grace" }];
        return Promise.resolve({ records: rows.map((data, index) => ({ key: key(query.source.name, String(index)), exists: true as const, data: data as T })) });
      },
    };
    const output = await executeRecursiveDTQLQuery(executor, result.resolved.query);
    expect(output.records.map((record) => record.data)).toEqual([{ InvoiceId: 7, CustomerName: "Ada" }]);

    const noMatchExecutor: QueryExecutor = {
      query<T>(query: StructuredQuery<T>) {
        const rows = query.source.name === "Invoice" ? [{ InvoiceId: 7, CustomerId: 2 }] : [];
        return Promise.resolve({ records: rows.map((data, index) => ({ key: key(query.source.name, String(index)), exists: true as const, data: data as T })) });
      },
    };
    const noMatchOutput = await executeRecursiveDTQLQuery(noMatchExecutor, result.resolved.query);
    expect(noMatchOutput.records.map((record) => record.data)).toEqual([{ InvoiceId: 7, CustomerName: null }]);

    const manyMatchExecutor: QueryExecutor = {
      query<T>(query: StructuredQuery<T>) {
        const rows = query.source.name === "Invoice"
          ? [{ InvoiceId: 7, CustomerId: 2 }]
          : [{ CustomerId: 2, Name: "Ada" }, { CustomerId: 2, Name: "Grace" }];
        return Promise.resolve({ records: rows.map((data, index) => ({ key: key(query.source.name, String(index)), exists: true as const, data: data as T })) });
      },
    };
    await expect(executeRecursiveDTQLQuery(manyMatchExecutor, result.resolved.query)).rejects.toThrow("scalar query returned more than one row");
  });

  it("pins imports to the importing revision and resolves mapped parameters", () => {
    const { document } = parseTugQL("parameters (\n  @Minimum integer required\n)\nwith Imported from \"./parts/invoices.tugql\"\n  using (\n    @Floor = @Minimum\n  )\nfrom Imported as i\nselect i.InvoiceId\n");
    const importedSource = "parameters (\n  @Floor integer required\n)\nfrom Invoice as base\nwhere base.InvoiceId >= @Floor\nselect base.InvoiceId\n";
    const result = resolveTugQL(document, {
      projectRoot: "repo", importingPath: "queries/main.tugql", projectRevision: "rev-1",
      authorizedSchemas: [{ version: "schema-1", tables: [{ name: "Invoice", fields: [{ name: "InvoiceId", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [{ path: "queries/parts/invoices.tugql", revision: "rev-1", source: importedSource }],
      bindings: [{ name: "Minimum", set: true, value: 3 }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.resolved?.dependencies).toEqual([{ path: "queries/parts/invoices.tugql", revision: "rev-1" }]);
    expect(result.resolved?.query.from.query?.where).toMatchObject({ kind: "comparison", right: { kind: "literal", value: 3 } });
    expect(result.resolved?.columns).toEqual([{ name: "InvoiceId", type: "integer", lineage: [{ source: "base", field: "InvoiceId" }] }]);
  });

  it("bounds expanded import chains by the final query depth and validates imported scalar lineage", () => {
    const resolveChain = (length: number, scalar = false) => {
      const pinnedImports = Array.from({ length }, (_, index) => ({
        path: `queries/q${String(index)}.tql`,
        revision: "rev-1",
        source: index + 1 === length
          ? "from T\nselect Id as Value\n"
          : scalar
            ? `with Next${String(index)} from "./q${String(index + 1)}.tql"\nfrom T\nselect (\n  Value as (\n    from Next${String(index)}\n    select Value\n  )\n)\n`
            : `with Next${String(index)} from "./q${String(index + 1)}.tql"\nfrom Next${String(index)}\nselect Value\n`,
      }));
      const parsed = parseTugQL('with Q from "./q0.tql"\nfrom Q\nselect Value\n');
      return resolveTugQL(parsed.document, {
        projectRoot: "repo", importingPath: "queries/main.tql", projectRevision: "rev-1",
        authorizedSchemas: [{ version: "schema-1", tables: [{ name: "T", fields: [{ name: "Id", type: "integer", authorized: true }] }] }],
        relationships: [], pinnedImports, bindings: [],
      });
    };

    expect(resolveChain(35).diagnostics).toEqual([]);
    const scalar = resolveChain(3, true);
    expect(scalar.diagnostics).toEqual([]);
    expect(scalar.resolved?.columns).toMatchObject([{ name: "Value", type: "integer" }]);
    expect(resolveChain(35, true).diagnostics[0]).toMatchObject({
      code: "document_depth_exceeded",
      message: "TugQL semantic tree depth exceeds 128",
    });
  });

  it("distinguishes an unset binding from an explicitly bound null", () => {
    const { document } = parseTugQL("parameters (\n  @Customer string required\n)\nfrom Invoice as i\nwhere i.CustomerId = @Customer\nselect i.InvoiceId\n");
    const context = {
      projectRoot: "repo", importingPath: "queries/main.tugql", projectRevision: "rev-1",
      authorizedSchemas: [{ version: "schema-1", tables: [{ name: "Invoice", fields: [{ name: "CustomerId", type: "text", authorized: true }, { name: "InvoiceId", type: "integer", authorized: true }] }] }],
      relationships: [], pinnedImports: [],
    } as const;
    expect(resolveTugQL(document, { ...context, bindings: [{ name: "Customer", set: false }] }).diagnostics[0]?.code).toBe("missing_required_binding");
    expect(resolveTugQL(document, { ...context, bindings: [{ name: "Customer", set: true, value: null }] }).diagnostics[0]?.code).toBe("invalid_binding");
  });

  it("returns no executable query for authoring-only scalar calls", () => {
    const { document, diagnostics } = parseTugQL("from Invoice as i\nselect COALESCE(i.Note, 'fallback') as Note\n");
    expect(diagnostics).toEqual([]);
    const result = resolveTugQL(document, {
      projectRoot: "repo", importingPath: "queries/main.tugql", projectRevision: "rev-1",
      authorizedSchemas: [{ version: "schema-1", tables: [{ name: "Invoice", fields: [{ name: "Note", type: "text", authorized: true }] }] }],
      relationships: [], pinnedImports: [], bindings: [],
    });
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("unsupported_function");
  });
});

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
      const nested = query as Record<string, unknown>;
      const { as, ...queryBody } = nested;
      return { ...normalizeScalarAliases(item), as, query: normalizeScalarAliases(queryBody) };
    });
  }
  return result;
}
