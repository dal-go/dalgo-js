/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-non-null-assertion -- node:fs types are not part of this package's tsconfig. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTugQL, printTugQL, type TugQLTree } from "../src/index.js";

/*
 * Slash-path conformance vectors shared with the Go parser. The file is a
 * byte-for-byte copy of dal-go/dalgo tugql/testdata/slash-paths/cases.json
 * (format and rules are documented in its own "notes" header).
 */
interface SlashPathCase {
  readonly name: string;
  readonly text: string;
  readonly expected: {
    readonly from?: Readonly<Record<string, unknown>>;
    readonly alias?: string;
    readonly print?: string;
    readonly comments?: readonly string[];
    readonly error?: { readonly code: string; readonly line: number; readonly column: number };
  };
}

const vectors = JSON.parse(readFileSync(new URL("./testdata/tugql/slash-paths/cases.json", import.meta.url), "utf8")) as {
  readonly format: string;
  readonly version: number;
  readonly cases: readonly SlashPathCase[];
};

function commentTexts(tree: TugQLTree): string[] | undefined {
  const comments = tree.comments;
  if (comments === undefined) return undefined;
  const texts: string[] = [];
  for (const key of Object.keys(comments.anchors ?? {}).sort()) {
    const group = comments.anchors![key]!;
    for (const comment of group.leading ?? []) texts.push(comment.text);
    if (group.trailing !== undefined) texts.push(group.trailing.text);
  }
  for (const comment of comments.end ?? []) texts.push(comment.text);
  return texts.length === 0 ? undefined : texts;
}

describe("TugQL slash paths (shared Go vectors)", () => {
  it("loads the vendored suite", () => {
    expect(vectors.format).toBe("tugql-slash-paths-suite");
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(26);
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const parsed = parseTugQL(vector.text);
      const error = vector.expected.error;
      if (error !== undefined) {
        expect(parsed.document.tree).toBeUndefined();
        expect(parsed.diagnostics.map((item) => ({ code: item.code, line: item.span.start.line, column: item.span.start.column })))
          .toContainEqual({ code: error.code, line: error.line, column: error.column });
        return;
      }
      expect(parsed.diagnostics).toEqual([]);
      const tree = parsed.document.tree!;
      const from = JSON.parse(JSON.stringify(tree.query.from)) as Record<string, unknown>;
      expect(from).toEqual(vector.expected.from);
      expect(typeof from.alias === "string" ? from.alias : from.name).toBe(vector.expected.alias);
      expect(commentTexts(tree)).toEqual(vector.expected.comments);
      const printed = printTugQL(tree);
      expect(printed.diagnostics).toEqual([]);
      expect(printed.source).toBe(vector.expected.print);
      const reparsed = parseTugQL(printed.source!);
      expect(reparsed.diagnostics).toEqual([]);
      expect(JSON.parse(JSON.stringify(reparsed.document.tree!.query.from))).toEqual(from);
    });
  }
});

describe("TugQL slash paths beyond the shared vectors", () => {
  it("accepts slash paths in JOIN sources and prints them back", () => {
    const parsed = parseTugQL("FROM spaces/{s}/ext/datatug/projects AS p\nJOIN spaces/{s}/ext/datatug/members AS m\n  ON m.project = p.id\nSELECT p.id");
    expect(parsed.diagnostics).toEqual([]);
    expect(printTugQL(parsed.document.tree!).source).toBe("from spaces/{s}/ext/datatug/projects as p\njoin spaces/{s}/ext/datatug/members as m\n  on m.project = p.id\nselect p.id");
  });

  it("reports a touching // in a JOIN source at the second slash", () => {
    const parsed = parseTugQL("FROM a\nJOIN b//c\n  ON b.x = a.x");
    expect(parsed.diagnostics[0]?.code).toBe("empty_path_segment");
    expect(parsed.diagnostics[0]?.span.start).toEqual({ line: 2, column: 8 });
  });

  it("falls back to the dotted form when a segment cannot be spelled in a slash path", () => {
    const cases: readonly [Record<string, string>, string][] = [
      [{ schema: "a/b", name: "c" }, "a/b/c"],
      [{ schema: "a/b{c", name: "d" }, "\"a/b{c\".d"],
      [{ schema: "a/b", name: "x/y" }, "\"a/b\".\"x/y\""],
      [{ schema: "a//b", name: "c" }, "\"a//b\".c"],
      [{ schema: "a", name: "{1a}" }, "a.\"{1a}\""],
      [{ schema: "a", name: "{a-b}" }, "a.\"{a-b}\""],
      [{ schema: "a", name: "{}" }, "a.\"{}\""],
      [{ schema: "{_s}", name: "from" }, "{_s}/\"from\""],
    ];
    for (const [from, want] of cases) {
      const printed = printTugQL({ format: "tugqtree", version: 1, query: { from } });
      expect(printed.source).toBe(`from ${want}`);
      expect(parseTugQL(`FROM ${want}`).diagnostics).toEqual([]);
    }
  });

  it("keeps the dotted spelling of a schema-qualified source", () => {
    const parsed = parseTugQL("FROM main.\"Order Items\" AS i");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.tree!.query.from).toEqual({ schema: "main", name: "Order Items", alias: "i" });
  });
});
