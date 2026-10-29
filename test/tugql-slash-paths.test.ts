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
    expect(vectors.cases.length).toBeGreaterThanOrEqual(47);
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const parsed = parseTugQL(vector.text);
      const error = vector.expected.error;
      if (error !== undefined) {
        expect(parsed.document.tree).toBeUndefined();
        const first = parsed.diagnostics[0];
        expect(first === undefined ? undefined : { code: first.code, line: first.span.start.line, column: first.span.start.column })
          .toEqual({ code: error.code, line: error.line, column: error.column });
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

describe("TugQL slash-path printing beyond the shared vectors", () => {
  const print = (from: Record<string, unknown>): ReturnType<typeof printTugQL> => printTugQL({ format: "tugqtree", version: 1, query: { from } });

  it("prints sources it can spell and re-parses them", () => {
    const cases: readonly [Record<string, string>, string][] = [
      [{ name: "c" }, "c"],
      [{ schema: "a/b", name: "c" }, "a/b/c"],
      [{ schema: "a.b", name: "c" }, "a.b.c"],
      [{ schema: "{_s}", name: "from" }, "{_s}/\"from\""],
      [{ schema: "main", name: "Order Items", alias: "i" }, "main.\"Order Items\" as i"],
    ];
    for (const [from, want] of cases) {
      expect(print(from)).toEqual({ source: `from ${want}`, diagnostics: [] });
      expect(parseTugQL(`from ${want}`).diagnostics).toEqual([]);
    }
  });

  it("refuses segments it cannot spell with unsupported_print", () => {
    const cases: readonly Record<string, string>[] = [
      { schema: "a/b{c", name: "d" },
      { schema: "a/b", name: "x/y" },
      { schema: "a//b", name: "c" },
      { schema: "a", name: "{1a}" },
      { schema: "a", name: "{a-b}" },
      { schema: "a", name: "{}" },
      { schema: "{x}.y", name: "z" },
      { name: "{x}" },
      { schema: "", name: "c" },
    ];
    for (const from of cases) {
      const printed = print(from);
      expect(printed.source).toBeUndefined();
      expect(printed.diagnostics[0]?.code).toBe("unsupported_print");
    }
    const join = printTugQL({ format: "tugqtree", version: 1, query: { from: { name: "a", joins: [{ from: { schema: "a", name: "x/y" } }] } } });
    expect(join.diagnostics[0]?.code).toBe("unsupported_print");
  });
});
