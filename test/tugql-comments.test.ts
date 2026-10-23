/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-non-null-assertion -- node:fs and node:crypto types are not part of this package's tsconfig. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatTugQL,
  lexTugQLComments,
  parseTugQL,
  printTugQL,
  resolveTugQL,
  tugqlToYaml,
  yamlToTugQL,
  type TugQLAuthorizedSchema,
  type TugQLDiagnostic,
  type TugQLFormatOptions,
  type TugQLTree,
} from "../src/index.js";

interface SqlExpectation {
  readonly forbid: string;
  readonly ignoringStringLiterals: boolean;
  readonly ignoringQuotedIdentifiers: boolean;
  readonly stringLiterals?: readonly string[];
  readonly quotedIdentifiers?: readonly string[];
}

interface CommentVectors {
  readonly format: string;
  readonly version: number;
  readonly schema: readonly TugQLAuthorizedSchema[];
  readonly textCases: readonly {
    readonly name: string;
    readonly text: string;
    readonly formatOptions: TugQLFormatOptions;
    readonly expected: {
      readonly diagnostics: readonly TugQLDiagnostic[] | null;
      readonly commentTokens: readonly { readonly marker: string; readonly text: string; readonly line: number; readonly column: number; readonly trailing: boolean }[];
      readonly format: string | null;
      readonly yaml: string | null;
      readonly roundTripText: string | null;
      readonly sql: SqlExpectation | null;
    };
  }[];
  readonly yamlCases: readonly {
    readonly name: string;
    readonly yaml: string;
    readonly expected: { readonly diagnostics: readonly TugQLDiagnostic[] | null; readonly text: string | null; readonly sql: SqlExpectation | null };
  }[];
}

const corpus = new URL("./testdata/tugql/v1/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("comments.json", corpus), "utf8")) as CommentVectors;

function withoutQuoted(text: string, sql: SqlExpectation): string {
  let result = text;
  for (const literal of [...(sql.stringLiterals ?? []), ...(sql.quotedIdentifiers ?? [])]) result = result.replaceAll(literal, "");
  return result;
}

/** Resolution output is the only thing a SQL emitter sees: it must carry no comment, and no marker outside literals. */
function assertCommentsDoNotReachResolution(text: string, sql: SqlExpectation): void {
  const parsed = parseTugQL(text);
  expect(parsed.diagnostics).toEqual([]);
  const context = { authorizedSchemas: vectors.schema, relationships: [], pinnedImports: [] };
  const resolved = resolveTugQL(parsed.document, context);
  expect(resolved.diagnostics).toEqual([]);
  const encoded = JSON.stringify(resolved);
  expect(withoutQuoted(encoded, sql)).not.toContain(sql.forbid);
  expect(encoded).not.toContain("comment");
  const stripped: Record<string, unknown> = { ...parsed.document.tree! };
  delete stripped.comments;
  const strippedResolved = resolveTugQL({ sourceMetadata: parsed.document.sourceMetadata, tree: stripped as unknown as TugQLTree }, context);
  expect(JSON.stringify(strippedResolved)).toBe(encoded);
}

describe("TugQL comment vectors (shared with dal-go/dalgo)", () => {
  it("loads the shared suite", () => {
    expect(vectors.format).toBe("tugql-comments-suite");
    expect(vectors.version).toBe(1);
    expect(vectors.textCases.length).toBeGreaterThan(0);
    expect(vectors.yamlCases.length).toBeGreaterThan(0);
  });

  describe("text cases", () => {
    it.each(vectors.textCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      expect(lexTugQLComments(c.text)).toEqual(c.expected.commentTokens);
      const parsed = parseTugQL(c.text);
      expect(parsed.diagnostics.length === 0 ? null : parsed.diagnostics).toEqual(c.expected.diagnostics);
      if (parsed.diagnostics.length > 0) {
        expect(tugqlToYaml(c.text).diagnostics).toEqual(parsed.diagnostics);
        return;
      }
      const formatted = formatTugQL(c.text, c.formatOptions);
      expect(formatted.diagnostics).toEqual([]);
      expect(formatted.source).toBe(c.expected.format);
      const converted = tugqlToYaml(c.text);
      expect(converted.diagnostics).toEqual([]);
      expect(converted.yaml).toBe(c.expected.yaml);
      const roundTrip = yamlToTugQL(converted.yaml!);
      expect(roundTrip.diagnostics).toEqual([]);
      expect(roundTrip.source).toBe(c.expected.roundTripText);
      // Converting the round-trip text again is stable: every comment already sits on an anchor.
      expect(tugqlToYaml(roundTrip.source!).yaml).toBe(converted.yaml);
      assertCommentsDoNotReachResolution(c.text, c.expected.sql!);
      // The formatter output parses to the same comments.
      expect(parseTugQL(formatted.source).document.tree?.comments).toEqual(parsed.document.tree?.comments);
    });
  });

  describe("YAML cases", () => {
    it.each(vectors.yamlCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      const converted = yamlToTugQL(c.yaml);
      expect(converted.diagnostics.length === 0 ? null : converted.diagnostics).toEqual(c.expected.diagnostics);
      if (c.expected.text === null) return;
      expect(converted.source).toBe(c.expected.text);
      assertCommentsDoNotReachResolution(converted.source!, c.expected.sql!);
    });
  });

  it("pins every corpus file to manifest.sha256", () => {
    const manifest = readFileSync(new URL("manifest.sha256", corpus), "utf8").trim().split("\n");
    const listed = new Set<string>();
    for (const row of manifest) {
      const [digest, path] = row.split("  ") as [string, string];
      const name = path.slice(path.lastIndexOf("/") + 1);
      expect(createHash("sha256").update(readFileSync(new URL(name, corpus))).digest("hex")).toBe(digest);
      listed.add(name);
    }
    for (const name of readdirSync(corpus)) if (name !== "manifest.sha256") expect(listed.has(name)).toBe(true);
    expect(listed.has("comments.json")).toBe(true);
  });
});

describe("TugQL YAML emission matches the Go reference byte for byte", () => {
  const suite = JSON.parse(readFileSync(new URL("suite.json", corpus), "utf8")) as { readonly cases: readonly { readonly name: string; readonly source: string; readonly expected: { readonly diagnostics: readonly unknown[]; readonly yaml?: string } }[] };
  const withYaml = suite.cases.filter((c) => c.expected.diagnostics.length === 0 && typeof c.expected.yaml === "string" && c.expected.yaml !== "");

  it("has golden YAML to compare against", () => {
    expect(withYaml.length).toBeGreaterThan(15);
  });

  it.each(withYaml.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(tugqlToYaml(c.source).yaml).toBe(c.expected.yaml);
  });

  it("quotes scalars like Go yaml.v3: YAML 1.1 booleans are quoted on names and values, not on select aliases and qualifiers", () => {
    // Expected bytes were produced by the Go reference (dal-go/dalgo tugql.TugQLToYAML).
    const converted = tugqlToYaml("from Invoice as N\nwhere N.\"on\" = 'true' and N.x = '12' and N.z = '-- not a comment'\nselect N.\"yes\" as N, N.y as \"y\"");
    expect(converted.diagnostics).toEqual([]);
    expect(converted.yaml).toBe("format: tugqtree\nversion: 1\nquery:\n    from:\n        name: Invoice\n        alias: \"N\"\n    where:\n        and:\n            - op: ==\n              left:\n                field: \"on\"\n                source: N\n              right:\n                value: \"true\"\n            - op: ==\n              left:\n                field: x\n                source: N\n              right:\n                value: \"12\"\n            - op: ==\n              left:\n                field: z\n                source: N\n              right:\n                value: -- not a comment\n    columns:\n        - field: \"yes\"\n          source: N\n          as: N\n        - field: \"y\"\n          source: N\n          as: y\n");
  });
});

describe("TugQL comments, focused", () => {
  it("recognises both markers only outside literals and quoted identifiers", () => {
    expect(lexTugQLComments("select a// c").map((c) => [c.marker, c.text, c.trailing])).toEqual([["//", "c", true]]);
    expect(lexTugQLComments("where u = 'https://example.com/x'")).toEqual([]);
    expect(lexTugQLComments('select "a//b" -- real')).toEqual([{ marker: "--", text: "real", line: 1, column: 15, trailing: true }]);
    expect(lexTugQLComments("select `a--b`")).toEqual([]);
  });

  it("does not treat # as a text comment", () => {
    expect(parseTugQL("# c\nfrom T\nselect Id").diagnostics[0]?.code).toBe("unsupported_statement");
  });

  it("keeps each marker when formatting and unifies them in YAML", () => {
    const source = "// a\nfrom T -- b\nselect Id";
    expect(formatTugQL(source).source).toBe(source);
    expect(tugqlToYaml(source).yaml).toBe("format: tugqtree\nversion: 1\nquery:\n    # a\n    from: # b\n        name: T\n    columns:\n        - field: Id\n");
    expect(yamlToTugQL(tugqlToYaml(source).yaml!).source).toBe("-- a\nfrom T -- b\nselect Id");
  });

  it("moves a comment on an unknown anchor to the document end instead of dropping it", () => {
    const tree: TugQLTree = {
      format: "tugqtree",
      version: 1,
      query: { from: { name: "T" }, columns: [{ field: "Id" }] },
      comments: { anchors: { "query.where": { leading: [{ text: "lost?" }] } }, end: [{ text: "tail" }] },
    };
    expect(printTugQL(tree).source).toBe("from T\nselect Id\n-- tail\n-- lost?");
  });

  it("fails closed on a multi-line comment", () => {
    const tree: TugQLTree = { format: "tugqtree", version: 1, query: { from: { name: "T" } }, comments: { end: [{ text: "a\nb" }] } };
    expect(printTugQL(tree).diagnostics[0]?.code).toBe("invalid_comments");
  });

  it("reports malformed YAML and unsupported trees with a diagnostic", () => {
    expect(yamlToTugQL("a: [").diagnostics[0]?.code).toBe("invalid_yaml");
    expect(yamlToTugQL("format: tugqtree\nversion: 2\nquery: {}\n").diagnostics[0]?.code).toBe("invalid_tree");
    expect(yamlToTugQL("format: tugqtree\nversion: 1\nquery:\n    from:\n        name: T\n    offset: 3\n").diagnostics[0]?.code).toBe("unsupported_print");
  });
});
