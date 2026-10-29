/* eslint-disable @typescript-eslint/no-non-null-assertion -- loops and lookups below are guarded by length and key checks. */

import { LineCounter, Parser, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { parseTugQL } from "./tugql.js";
import type { TugQLComment, TugQLCommentGroup, TugQLComments, TugQLDiagnostic, TugQLTree } from "./tugql.js";

/**
 * Conversion between the TugQL text form and the structured TugQL YAML form.
 * Comments survive both directions: a text `--` or `//` comment becomes a YAML
 * `#` comment attached where it annotated, and a YAML `#` comment becomes a
 * text `--` comment. The YAML written here matches the Go reference
 * implementation byte for byte, including its 4-space indentation, key order
 * and scalar quoting.
 */

type Rec = Readonly<Record<string, unknown>>;

const zeroSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } as const;

function conversionDiagnostic(code: string, message: string): TugQLDiagnostic {
  return { code, message, span: zeroSpan };
}

class ConversionError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function asRec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Rec : undefined;
}

// ---------------------------------------------------------------------------
// YAML emission

type Shape =
  | "tree" | "param" | "definition" | "body" | "mapping" | "query" | "from" | "join" | "cond" | "exists"
  | "expr" | "aggregate" | "binary" | "call" | "plain";

const keyOrder: Readonly<Record<Shape, readonly string[]>> = {
  tree: ["format", "version", "parameters", "definitions", "query"],
  param: ["name", "type", "required", "default"],
  definition: ["kind", "name", "query", "path", "using"],
  body: ["definitions", "query"],
  mapping: ["name", "expression"],
  query: ["as", "from", "where", "groupBy", "money", "having", "orderBy", "limit", "offset", "columns"],
  from: ["database", "scan", "schema", "name", "alias", "query", "joins"],
  join: ["type", "from", "on", "hints"],
  cond: ["op", "left", "right", "and", "or", "exists", "notExists", "isNull", "isNotNull"],
  exists: ["query"],
  expr: ["field", "source", "value", "values", "param", "star", "aggregate", "binary", "query", "call", "wildcard", "as", "desc"],
  aggregate: ["function", "distinct", "args", "orderBy"],
  binary: ["op", "left", "right"],
  call: ["function", "args"],
  plain: [],
};

function childShape(shape: Shape, key: string, value: unknown): Shape {
  switch (shape) {
    case "tree":
      return key === "parameters" ? "param" : key === "definitions" ? "definition" : key === "query" ? "query" : "plain";
    case "definition":
      return key === "query" ? "body" : key === "using" ? "mapping" : "plain";
    case "body":
      return key === "definitions" ? "definition" : key === "query" ? "query" : "plain";
    case "mapping":
      return key === "expression" ? "expr" : "plain";
    case "query":
      if (key === "from") return "from";
      if (key === "where" || key === "having") return "cond";
      if (key === "groupBy" || key === "orderBy" || key === "columns") return "expr";
      return "plain";
    case "from":
      return key === "query" ? "query" : key === "joins" ? "join" : "plain";
    case "join":
      return key === "from" ? "from" : key === "on" ? "cond" : "plain";
    case "cond":
      if (key === "left" || key === "right" || key === "isNull" || key === "isNotNull") return "expr";
      if (key === "and" || key === "or") return "cond";
      if (key === "exists" || key === "notExists") return "exists";
      return "plain";
    case "exists":
      return key === "query" ? "query" : "plain";
    case "expr":
      if (key === "aggregate") return "aggregate";
      if (key === "binary") return "binary";
      if (key === "call") return "call";
      // A scalar subquery is a body ({definitions?, query}); a plain nested query is a query document.
      if (key === "query") return asRec(value)?.query !== undefined && asRec(value)?.from === undefined ? "body" : "query";
      return "plain";
    case "aggregate":
      return key === "args" ? "expr" : key === "orderBy" ? "expr" : "plain";
    case "binary":
      return key === "left" || key === "right" ? "expr" : "plain";
    case "call":
      return key === "args" ? "expr" : "plain";
    default:
      return "plain";
  }
}

interface YamlEntry {
  readonly key: string;
  readonly value: YamlNode;
  head?: readonly TugQLComment[];
  line?: TugQLComment;
}

interface YamlItem {
  readonly value: YamlNode;
  head?: readonly TugQLComment[];
  line?: TugQLComment;
}

type YamlNode =
  | { readonly kind: "scalar"; readonly text: string }
  | { readonly kind: "map"; readonly entries: YamlEntry[] }
  | { readonly kind: "seq"; readonly items: YamlItem[] };

const oldBool = new Set(["y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO", "on", "On", "ON", "off", "Off", "OFF"]);
const base60Float = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/u;
const yamlFloat = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/u;
const yamlInteger = /^[-+]?(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO]?[0-7]+|[0-9]+)$/u;

function isTimestampLike(text: string): boolean {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.\d*)?(?:Z|[-+]\d{1,2}:\d{2})?)?$/u.exec(text);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4], match[5], match[6]].map((part) => part === undefined ? 0 : Number(part)) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether Go yaml.v3 would resolve the plain text to something other than a string. */
function resolvesToNonString(text: string): boolean {
  if (text === "" || text === "~" || /^(null|Null|NULL|true|True|TRUE|false|False|FALSE)$/u.test(text)) return true;
  if (text === "<<") return true;
  if (!/^[-+.0-9]/u.test(text)) return false;
  if (/^[-+]?\.(inf|Inf|INF)$/u.test(text) || /^\.(nan|NaN|NAN)$/u.test(text)) return true;
  const plain = text.replaceAll("_", "");
  return yamlInteger.test(plain) || yamlFloat.test(plain) || isTimestampLike(text);
}

/** Port of the libyaml scalar analysis that decides whether a string may be written plain (block context). */
function plainAllowed(text: string): { readonly plain: boolean; readonly single: boolean } {
  if (text === "") return { plain: true, single: true };
  const chars = Array.from(text);
  let blockIndicators = text.startsWith("---") || text.startsWith("...");
  let special = false;
  let leadingSpace = false;
  let trailingSpace = false;
  let leadingBreak = false;
  let trailingBreak = false;
  let breakSpace = false;
  let spaceBreak = false;
  let lineBreaks = false;
  let previousSpace = false;
  let previousBreak = false;
  let precededByWhitespace = true;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const next = chars[index + 1];
    const followedByWhitespace = next === undefined || next === " " || next === "\t" || next === "\n" || next === "\r";
    if (index === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(char)) blockIndicators = true;
      else if ((char === "?" || char === ":" || char === "-") && followedByWhitespace) blockIndicators = true;
    } else if (char === ":" && followedByWhitespace) blockIndicators = true;
    else if (char === "#" && precededByWhitespace) blockIndicators = true;
    const code = char.codePointAt(0)!;
    const printable = code === 0x0a || (code >= 0x20 && code <= 0x7e) || code === 0x85 || (code >= 0xa0 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd && code !== 0xfeff) || code >= 0x10000;
    if (!printable) special = true;
    const isBreak = char === "\n" || char === "\r" || code === 0x85 || code === 0x2028 || code === 0x2029;
    if (char === " ") {
      if (index === 0) leadingSpace = true;
      if (index === chars.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true; previousBreak = false;
    } else if (isBreak) {
      lineBreaks = true;
      if (index === 0) leadingBreak = true;
      if (index === chars.length - 1) trailingBreak = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false; previousBreak = true;
    } else { previousSpace = false; previousBreak = false; }
    precededByWhitespace = char === " " || char === "\t" || isBreak;
  }
  let plain = !(leadingSpace || leadingBreak || trailingSpace || trailingBreak || breakSpace || spaceBreak || special || lineBreaks || blockIndicators);
  let single = !(breakSpace || spaceBreak || special);
  if (text === "") { plain = true; single = true; }
  return { plain, single };
}

function yamlString(text: string, quoteOldBool = true): string {
  if (text.includes("\n") || text.includes("\r")) return JSON.stringify(text);
  if (resolvesToNonString(text) || (quoteOldBool && (base60Float.test(text) || oldBool.has(text)))) return JSON.stringify(text);
  const style = plainAllowed(text);
  if (style.plain) return text;
  if (style.single) return `'${text.replaceAll("'", "''")}'`;
  return JSON.stringify(text);
}

function yamlScalar(value: unknown, quoteOldBool = true): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConversionError("invalid_tree", "tree values must be finite numbers");
    return String(value);
  }
  if (typeof value === "string") return yamlString(value, quoteOldBool);
  throw new ConversionError("invalid_tree", "tree values must be YAML scalars, sequences or string-keyed mappings");
}

function orderedKeys(record: Rec, shape: Shape): string[] {
  const known = keyOrder[shape];
  const present = Object.keys(record).filter((key) => record[key] !== undefined && !(shape === "tree" && key === "comments"));
  return [...known.filter((key) => present.includes(key)), ...present.filter((key) => !known.includes(key))];
}

/**
 * Go builds the `as` alias and the `source` qualifier of an expression as YAML
 * nodes with an explicit string tag, which skips the YAML 1.1 boolean check
 * (`as: N` stays plain, while `field: N` is quoted).
 */
function toYamlNode(value: unknown, shape: Shape, depth = 0, quoteOldBool = true): YamlNode {
  if (depth > 200) throw new ConversionError("invalid_tree", "tree nesting exceeds the supported depth");
  if (Array.isArray(value)) {
    return { kind: "seq", items: (value as unknown[]).map((item) => ({ value: toYamlNode(item, shape, depth + 1) })) };
  }
  const record = asRec(value);
  if (record !== undefined) {
    const entries = orderedKeys(record, shape).map((key): YamlEntry => ({
      key: yamlString(key),
      value: toYamlNode(record[key], childShape(shape, key, record[key]), depth + 1, !(shape === "expr" && (key === "as" || key === "source"))),
    }));
    return { kind: "map", entries };
  }
  return { kind: "scalar", text: yamlScalar(value, quoteOldBool) };
}

function isEmptyCollection(node: YamlNode): boolean {
  return (node.kind === "map" && node.entries.length === 0) || (node.kind === "seq" && node.items.length === 0);
}

type Slot = YamlEntry | YamlItem;

function splitPathSegment(segment: string): { readonly name: string; readonly index: number | undefined } {
  const open = segment.indexOf("[");
  if (open < 0 || !segment.endsWith("]")) return { name: segment, index: undefined };
  const index = Number(segment.slice(open + 1, -1));
  if (!/^\d+$/u.test(segment.slice(open + 1, -1)) || !Number.isSafeInteger(index)) return { name: segment, index: undefined };
  return { name: segment.slice(0, open), index };
}

function resolveAnchor(root: YamlNode, path: string): Slot | undefined {
  let current: YamlNode = root;
  let slot: Slot | undefined;
  for (const segment of path.split(".")) {
    const { name, index } = splitPathSegment(segment);
    if (current.kind !== "map") return undefined;
    const entry: YamlEntry | undefined = current.entries.find((candidate) => candidate.key === name || (candidate.key.startsWith('"') && candidate.key === JSON.stringify(name)));
    if (entry === undefined) return undefined;
    slot = entry;
    current = entry.value;
    if (index !== undefined) {
      if (current.kind !== "seq" || index >= current.items.length) return undefined;
      const item: YamlItem = current.items[index]!;
      slot = item;
      current = item.value;
    }
  }
  return slot;
}

function commentLines(comments: readonly TugQLComment[], indent: string): string[] {
  const lines: string[] = [];
  comments.forEach((comment, index) => {
    if (index > 0 && comment.blankBefore === true) lines.push("");
    lines.push(comment.text === "" ? `${indent}#` : `${indent}# ${comment.text}`);
  });
  return lines;
}

function lineComment(comment: TugQLComment | undefined): string {
  if (comment === undefined) return "";
  return comment.text === "" ? " #" : ` # ${comment.text}`;
}

/**
 * yaml.v3 indents a collection one `- ` further when it is a sequence item, and
 * otherwise rounds the parent indentation up to the next multiple of four.
 */
function childIndent(indent: number, insideSequenceItem: boolean): number {
  return insideSequenceItem ? indent + 2 : 4 * Math.floor((indent + 4) / 4);
}

function renderMap(node: Extract<YamlNode, { kind: "map" }>, indent: number, firstPrefix: string | undefined, out: string[]): void {
  node.entries.forEach((entry, index) => {
    const pad = " ".repeat(indent);
    const prefix = index === 0 && firstPrefix !== undefined ? firstPrefix : pad;
    if (entry.head !== undefined) out.push(...commentLines(entry.head, pad));
    const value = entry.value;
    if (value.kind === "scalar") {
      out.push(`${prefix}${entry.key}: ${value.text}${lineComment(entry.line)}`);
    } else if (isEmptyCollection(value)) {
      out.push(`${prefix}${entry.key}: ${value.kind === "map" ? "{}" : "[]"}${lineComment(entry.line)}`);
    } else {
      out.push(`${prefix}${entry.key}:${lineComment(entry.line)}`);
      renderCollection(value, childIndent(indent, false), out);
    }
  });
}

function renderCollection(node: YamlNode, indent: number, out: string[]): void {
  if (node.kind === "map") { renderMap(node, indent, undefined, out); return; }
  if (node.kind !== "seq") return;
  const pad = " ".repeat(indent);
  for (const item of node.items) {
    if (item.head !== undefined) out.push(...commentLines(item.head, pad));
    const value = item.value;
    const start = out.length;
    if (value.kind === "scalar") out.push(`${pad}- ${value.text}`);
    else if (isEmptyCollection(value)) out.push(`${pad}- ${value.kind === "map" ? "{}" : "[]"}`);
    else if (value.kind === "map") renderMap(value, childIndent(indent, true), `${pad}- `, out);
    else { out.push(`${pad}-`); renderCollection(value, childIndent(indent, true), out); }
    if (item.line !== undefined) out[start] = `${out[start]!}${lineComment(item.line)}`;
  }
}

function validateComments(comments: TugQLComments | undefined): void {
  if (comments === undefined) return;
  const all: TugQLComment[] = [...(comments.end ?? [])];
  for (const group of Object.values(comments.anchors ?? {})) {
    all.push(...(group.leading ?? []));
    if (group.trailing !== undefined) all.push(group.trailing);
  }
  for (const comment of all) {
    if (typeof comment.text !== "string" || /[\r\n]/u.test(comment.text)) throw new ConversionError("invalid_comments", "comment text must be a single line");
  }
}

function emitTreeYaml(tree: TugQLTree): string {
  validateComments(tree.comments);
  const root = toYamlNode(tree, "tree");
  const end: TugQLComment[] = [...(tree.comments?.end ?? [])];
  const anchors = tree.comments?.anchors ?? {};
  for (const path of Object.keys(anchors).sort()) {
    const group = anchors[path]!;
    const slot = resolveAnchor(root, path);
    if (slot === undefined) {
      // An anchor the tree has no element for is not dropped: its comments move to the document end.
      end.push(...(group.leading ?? []));
      if (group.trailing !== undefined) end.push(group.trailing);
      continue;
    }
    if (group.leading !== undefined && group.leading.length > 0) slot.head = group.leading;
    if (group.trailing !== undefined) slot.line = group.trailing;
  }
  const lines: string[] = [];
  renderCollection(root, 0, lines);
  if (end.length > 0) {
    lines.push("");
    lines.push(...commentLines(end, ""));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Converts TugQL source text into the structured TugQL YAML form. Every `--`
 * and `//` comment becomes a `#` comment: comments on their own lines are the
 * head comment of the clause they precede, and a comment after code is the
 * same-line comment of that clause. On any diagnostic no YAML is returned.
 */
export function tugqlToYaml(source: string): { readonly yaml?: string; readonly diagnostics: readonly TugQLDiagnostic[] } {
  const parsed = parseTugQL(source);
  if (parsed.diagnostics.length > 0 || parsed.document.tree === undefined) return { diagnostics: parsed.diagnostics };
  try {
    return { yaml: emitTreeYaml(parsed.document.tree), diagnostics: [] };
  } catch (error) {
    if (error instanceof ConversionError) return { diagnostics: [conversionDiagnostic(error.code, error.message)] };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// YAML reading

const anchorPaths = new Set(["parameters", "query.from", "query.where", "query.groupBy", "query.having", "query.orderBy", "query.limit", "query.columns"]);

function isAnchorPath(path: string): boolean {
  if (anchorPaths.has(path)) return true;
  if (/^definitions\[\d+\]$/u.test(path)) return true;
  return /^query\.from\.joins\[\d+\](\.on\[\d+\])?$/u.test(path);
}

interface YamlAnchor {
  readonly path: string;
  readonly offset: number;
}

interface YamlComment {
  readonly offset: number;
  readonly text: string;
}

function collectAnchors(node: unknown, path: string, out: YamlAnchor[]): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.range == null) continue;
      const key = pair.key.value;
      const childPath = path === "" ? key : `${path}.${key}`;
      if (isAnchorPath(childPath)) out.push({ path: childPath, offset: pair.key.range[0] });
      collectAnchors(pair.value, childPath, out);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => {
      const childPath = `${path}[${index.toString()}]`;
      const range = (item as { range?: [number, number, number] | null }).range;
      if (isAnchorPath(childPath) && range != null) out.push({ path: childPath, offset: range[0] });
      collectAnchors(item, childPath, out);
    });
  }
}

function collectCommentTokens(token: unknown, out: YamlComment[]): void {
  if (typeof token !== "object" || token === null) return;
  const record = token as { type?: unknown; offset?: unknown; source?: unknown };
  if (record.type === "comment" && typeof record.offset === "number" && typeof record.source === "string") {
    out.push({ offset: record.offset, text: record.source });
    return;
  }
  for (const field of ["start", "end", "sep", "props", "items", "key", "value", "in"]) {
    const child = (token as Record<string, unknown>)[field];
    if (Array.isArray(child)) for (const nested of child as unknown[]) collectCommentTokens(nested, out);
    else collectCommentTokens(child, out);
  }
}

function commentText(source: string): string {
  const afterHash = source.slice(1);
  const trimmed = afterHash.replace(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, "");
  return trimmed.startsWith(" ") ? trimmed.slice(1) : trimmed;
}

/**
 * Go's yaml.v3 splits the comment lines that directly follow a content line and
 * are followed by a blank line into a separate (foot) block, unless the content
 * line opens a nested block (ends in `:`). Blank lines are kept only inside one
 * block, so the first comment after such a blank line starts a new block.
 * Returns the 1-based lines of those block-starting comments.
 */
function footSplitLines(rawLines: readonly string[]): { readonly splits: ReadonlySet<number>; readonly delays: ReadonlyMap<number, number> } {
  const kind = rawLines.map((line) => {
    const trimmed = line.trim();
    return trimmed === "" ? "blank" : trimmed.startsWith("#") ? "comment" : "content";
  });
  const splits = new Set<number>();
  const delays = new Map<number, number>();
  // Comments before the first content line: the last blank-separated group heads the first node and the
  // earlier ones head the document, so the blank before that last group is lost.
  const firstContent = kind.indexOf("content");
  const leadEnd = firstContent < 0 ? rawLines.length : firstContent;
  let lastGroupStart = -1;
  let groupCount = 0;
  for (let i = 0; i < leadEnd; i += 1) {
    if (kind[i] === "comment" && (i === 0 || kind[i - 1] !== "comment")) { lastGroupStart = i; groupCount += 1; }
  }
  if (groupCount > 1 && firstContent >= 0) splits.add(lastGroupStart + 1);
  for (let i = 0; i < rawLines.length; i += 1) {
    if (kind[i] !== "comment" || i === 0 || kind[i - 1] !== "content") continue;
    if (/:\s*(#.*)?$/u.test(rawLines[i - 1]!) && !/^\s*#/u.test(rawLines[i - 1]!)) {
      const withoutComment = rawLines[i - 1]!.replace(/\s+#.*$/u, "");
      if (withoutComment.endsWith(":")) continue;
    }
    let end = i;
    while (kind[end + 1] === "comment") end += 1;
    if (kind[end + 1] !== "blank") continue;
    let next = end + 1;
    while (kind[next] === "blank") next += 1;
    if (kind[next] !== "comment") continue;
    splits.add(next + 1);
    // Before a sequence item the split-off block attaches inside the next item, so it surfaces after the
    // item's own leading comments rather than before them.
    let content = next;
    while (content < rawLines.length && kind[content] !== "content") content += 1;
    if (content < rawLines.length && /^-(\s|$)/u.test(rawLines[content]!.trim())) {
      for (let line = i; line <= end; line += 1) delays.set(line + 1, content + 1);
    }
  }
  return { splits, delays };
}

/**
 * Reads the `#` comments of a TugQTree YAML document. Each comment is a
 * trailing comment of the clause-level anchor whose first line it ends, or else
 * a leading comment of the nearest following anchor; a comment after the last
 * anchor is a document-end comment. No comment is dropped.
 */
function readYamlComments(text: string, contents: unknown, lines: LineCounter): TugQLComments | undefined {
  const comments: YamlComment[] = [];
  for (const token of new Parser().parse(text)) collectCommentTokens(token, comments);
  if (comments.length === 0) return undefined;
  const anchors: YamlAnchor[] = [];
  collectAnchors(contents, "", anchors);
  anchors.sort((a, b) => a.offset - b.offset);
  const rawLines = text.split(/\r\n|\r|\n/u);
  const { splits, delays } = footSplitLines(rawLines);
  // A delayed comment is read as if it sat at the end of the sequence item it precedes.
  const readOffset = (comment: YamlComment): number => {
    const target = delays.get(lines.linePos(comment.offset).line);
    return target === undefined ? comment.offset : (lines.lineStarts[target - 1] ?? comment.offset) + (rawLines[target - 1]?.length ?? 0);
  };
  const ordered = comments.map((comment) => ({ comment, at: readOffset(comment) })).sort((a, b) => a.at - b.at || a.comment.offset - b.comment.offset);
  const groups = new Map<string, { leading?: TugQLComment[]; trailing?: TugQLComment }>();
  const firstAnchorOnLine = new Map<number, string>();
  interface Pending { readonly line: number; readonly text: string; readonly blockStart: boolean }
  let pending: Pending[] = [];
  let next = 0;
  const blankSeparated = (placed: readonly Pending[]): TugQLComment[] => placed.map((item, index) => {
    const previous = placed[index - 1];
    const blank = previous !== undefined && !item.blockStart && item.line > previous.line + 1 && rawLines.slice(previous.line, item.line - 1).every((between) => between.trim() === "");
    return blank ? { text: item.text, blankBefore: true as const } : { text: item.text };
  });
  const claim = (anchor: YamlAnchor): void => {
    const line = lines.linePos(anchor.offset).line;
    const list = blankSeparated(pending);
    pending = [];
    if (list.length > 0) groups.set(anchor.path, { ...groups.get(anchor.path), leading: list });
    if (!firstAnchorOnLine.has(line)) firstAnchorOnLine.set(line, anchor.path);
  };
  for (const { comment, at } of ordered) {
    while (next < anchors.length && anchors[next]!.offset < at) { claim(anchors[next]!); next += 1; }
    const position = lines.linePos(comment.offset);
    const before = rawLines[position.line - 1]?.slice(0, position.col - 1) ?? "";
    const trailing = before.trim() !== "";
    const text = commentText(comment.text);
    const owner = trailing ? firstAnchorOnLine.get(position.line) : undefined;
    if (owner !== undefined && groups.get(owner)?.trailing === undefined) {
      groups.set(owner, { ...groups.get(owner), trailing: { text } });
    } else pending.push({ line: position.line, text, blockStart: splits.has(position.line) || (delays.has(position.line) && !delays.has(position.line - 1)) });
  }
  // Anchors after the last comment still claim the comments pending above them.
  while (next < anchors.length) { claim(anchors[next]!); next += 1; }
  const end = blankSeparated(pending);
  const anchorsOut: Record<string, TugQLCommentGroup> = {};
  for (const [path, group] of groups) anchorsOut[path] = group;
  return {
    ...(groups.size === 0 ? {} : { anchors: anchorsOut }),
    ...(end.length === 0 ? {} : { end }),
  };
}

// ---------------------------------------------------------------------------
// Text printing

function checkKeys(record: Rec, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ConversionError("invalid_tree", `field ${key} not found in ${what}`);
  }
}

function unsupported(message: string): never {
  throw new ConversionError("unsupported_print", message);
}

function invalid(message: string): never {
  throw new ConversionError("invalid_tree", message);
}

function isIdentContinue(char: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(char);
}

const styleKeywords = new Set(["from", "join", "left", "on", "where", "group", "by", "having", "order", "limit", "select", "as", "and", "or", "not", "is", "null", "asc", "desc", "true", "false", "with", "parameters", "required", "default", "using", "inner", "outer", "cross", "integer", "decimal", "string", "boolean", "date", "datetime", "timestamp"]);

function identText(name: string, checkKeyword: boolean): string {
  let simple = name !== "";
  Array.from(name).forEach((char, index) => {
    if (index === 0 && !/[\p{L}_]/u.test(char)) simple = false;
    if (!isIdentContinue(char)) simple = false;
  });
  if (simple && checkKeyword) simple = !styleKeywords.has(name.toLowerCase());
  return simple ? name : `"${name.replaceAll('"', '""')}"`;
}

function quoteString(text: string): string {
  if (/[\r\n]/u.test(text)) unsupported("string literal with a line break has no text spelling");
  return `'${text.replaceAll("'", "''")}'`;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") invalid(`${what} must be a string`);
  return value;
}

function optionalStr(record: Rec, key: string, what: string): string {
  const value = record[key];
  return value === undefined ? "" : str(value, `${what}.${key}`);
}

function list(value: unknown, what: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${what} must be a sequence`);
  return value as readonly unknown[];
}

function record(value: unknown, what: string): Rec {
  const rec = asRec(value);
  if (rec === undefined) invalid(`${what} must be a mapping`);
  return rec;
}

function printParameterDefault(typeName: string, value: unknown): string {
  switch (typeName.toUpperCase()) {
    case "INTEGER":
      if (typeof value === "number" && Number.isInteger(value)) return String(value);
      break;
    case "DECIMAL":
      if (typeof value === "string") return value;
      break;
    case "BOOLEAN":
      if (typeof value === "boolean") return value ? "true" : "false";
      break;
    default:
      if (typeof value === "string") return quoteString(value);
  }
  return unsupported(`parameter default ${JSON.stringify(value)} has no text spelling for type ${typeName}`);
}

function printParameter(value: unknown): string {
  const parameter = record(value, "parameter");
  checkKeys(parameter, ["name", "type", "required", "default"], "parameter");
  const name = str(parameter.name, "parameter name");
  const type = str(parameter.type, "parameter type");
  const line = `@${name} ${identText(type, false)}`;
  if (parameter.required === true) return `${line} required`;
  if (parameter.default === undefined || parameter.default === null) return unsupported(`parameter @${name} needs required or a default`);
  return `${line} default ${printParameterDefault(type, parameter.default)}`;
}

const binaryPrecedence = (op: string): number => op === "+" || op === "-" ? 10 : op === "*" || op === "/" ? 20 : -1;

function printValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 0) return unsupported(`negative literal ${String(value)} has no text spelling`);
    return String(value);
  }
  return unsupported(`value ${JSON.stringify(value)} has no text spelling`);
}

function printCall(functionName: unknown, args: unknown): string {
  return `${identText(str(functionName, "function"), false)}(${printExpressionList(list(args, "args"))})`;
}

function printExpressionList(items: readonly unknown[]): string {
  return items.map((item) => printExpression(item, 0)).join(", ");
}

function printExpression(value: unknown, minPrecedence: number): string {
  const expression = record(value, "expression");
  if (expression.aggregate !== undefined) {
    const aggregate = record(expression.aggregate, "aggregate");
    checkKeys(aggregate, ["function", "distinct", "args", "orderBy"], "aggregate");
    if (aggregate.distinct === true || list(aggregate.orderBy, "aggregate.orderBy").length > 0) unsupported("aggregate distinct and orderBy have no text spelling");
    return printCall(aggregate.function, aggregate.args);
  }
  if (expression.call !== undefined) {
    const call = record(expression.call, "call");
    checkKeys(call, ["function", "args"], "call");
    return printCall(call.function, call.args);
  }
  if (expression.binary !== undefined) {
    const binary = record(expression.binary, "binary");
    checkKeys(binary, ["op", "left", "right"], "binary");
    const op = str(binary.op, "binary op");
    const precedence = binaryPrecedence(op);
    if (precedence < 0 || binary.left === undefined || binary.right === undefined) unsupported(`operator ${JSON.stringify(op)} has no text spelling`);
    const text = `${printExpression(binary.left, precedence)} ${op} ${printExpression(binary.right, precedence + 1)}`;
    return precedence < minPrecedence ? `(${text})` : text;
  }
  if (expression.star === true) return "*";
  if (typeof expression.param === "string" && expression.param !== "") return `@${expression.param}`;
  if (expression.value !== undefined) return printValue(expression.value);
  const field = optionalStr(expression, "field", "expression");
  if (field !== "") {
    const source = optionalStr(expression, "source", "expression");
    return source === "" ? identText(field, true) : `${identText(source, true)}.${identText(field, true)}`;
  }
  return unsupported("expression has no text spelling");
}

function printGroup(children: readonly unknown[], word: "and" | "or", parens: boolean): string {
  const text = children.map((child) => printCondition(child, word)).join(` ${word} `);
  return parens ? `(${text})` : text;
}

function printCondition(value: unknown, context: "" | "and" | "or"): string {
  const condition = record(value, "condition");
  const or = list(condition.or, "or");
  const and = list(condition.and, "and");
  if (or.length > 0) return printGroup(or, "or", context === "or" || context === "and");
  if (and.length > 0) return printGroup(and, "and", context === "and");
  if (condition.isNull !== undefined) return `${printExpression(condition.isNull, 0)} is null`;
  if (condition.op === "relationship" && condition.left !== undefined) return printExpression(condition.left, 0);
  if (typeof condition.op === "string" && condition.op !== "" && condition.left !== undefined && condition.right !== undefined) {
    let op = condition.op;
    if (op === "==") op = "=";
    else if (!["!=", "<>", "<", ">", "<=", ">="].includes(op)) unsupported(`operator ${JSON.stringify(op)} has no text spelling`);
    return `${printExpression(condition.left, 0)} ${op} ${printExpression(condition.right, 0)}`;
  }
  return unsupported("condition has no text spelling");
}

function printSource(from: Rec): string {
  const schema = optionalStr(from, "schema", "from");
  const name = str(from.name, "from.name");
  let text = printSlashPath(schema, name);
  if (text === undefined) {
    const parts = schema === "" ? [] : schema.split(".").map((part) => identText(part, true));
    parts.push(identText(name, true));
    text = parts.join(".");
  }
  const alias = optionalStr(from, "alias", "from");
  return alias === "" ? text : `${text} as ${identText(alias, true)}`;
}

/** `{word}`: a substituted path segment. */
function isSubstitutedSegment(segment: string): boolean {
  return /^\{[\p{L}_][\p{L}\p{N}_$]*\}$/u.test(segment);
}

/**
 * Renders a source in slash form when its schema contains '/' or a segment is
 * a {name} substitution, and every segment can be spelled in a slash path.
 * The tree does not record the separator, so a two-segment path without either
 * prints dotted. Mirrors dal-go/dalgo tugql printTugQLSlashPath.
 */
function printSlashPath(schema: string, name: string): string | undefined {
  if (schema === "") return undefined;
  const segments = [...schema.split("/"), name];
  let slash = schema.includes("/");
  const parts: string[] = [];
  for (const segment of segments) {
    if (isSubstitutedSegment(segment)) { slash = true; parts.push(segment); continue; }
    if (segment === "" || /[{}/]/u.test(segment)) return undefined;
    parts.push(identText(segment, true));
  }
  return slash ? parts.join("/") : undefined;
}

interface PrintUnit {
  readonly path: string;
  readonly lines: string[];
}

function printColumn(value: unknown): string {
  const column = record(value, "column");
  const text = printExpression(column, 0);
  const alias = optionalStr(column, "as", "column");
  return alias === "" ? text : `${text} as ${identText(alias, true)}`;
}

function bodyOf(value: unknown): Rec {
  const query = record(value, "subquery");
  return query.query !== undefined && query.from === undefined ? query : { query };
}

function printColumns(columns: readonly unknown[], indent: string): string[] {
  const records = columns.map((column) => record(column, "column"));
  let block = false;
  for (const column of records) {
    if (column.wildcard !== undefined) unsupported("wildcard column options have no text spelling");
    if (column.query !== undefined) block = true;
  }
  if (!block) return [`${indent}select ${records.map(printColumn).join(", ")}`];
  const lines = [`${indent}select (`];
  for (const column of records) {
    if (column.query === undefined) { lines.push(`${indent}  ${printColumn(column)}`); continue; }
    const alias = optionalStr(column, "as", "column");
    if (alias === "") unsupported("a scalar subquery column needs an alias");
    lines.push(`${indent}  ${identText(alias, true)} as (`);
    lines.push(...printBody(bodyOf(column.query), `${indent}    `));
    lines.push(`${indent}  )`);
  }
  lines.push(`${indent})`);
  return lines;
}

/** Renders a query as one unit per clause. Only the main query (base "query") gets anchor paths. */
function printQueryUnits(queryValue: unknown, indent: string, base: string): PrintUnit[] {
  const query = record(queryValue, "query");
  checkKeys(query, keyOrder.query, "query");
  const anchor = (suffix: string): string => base === "" ? "" : `${base}${suffix}`;
  if (query.as !== undefined && query.as !== "" || query.money !== undefined || (query.offset !== undefined && query.offset !== 0)) {
    unsupported("query as, money and offset have no text spelling");
  }
  const from = record(query.from, "from");
  checkKeys(from, ["database", "scan", "schema", "name", "alias", "as", "query", "joins"], "from");
  if (from.database !== undefined || from.scan !== undefined || from.query !== undefined) unsupported("from database, scan and query have no text spelling");
  const units: PrintUnit[] = [{ path: anchor(".from"), lines: [`${indent}from ${printSource(from)}`] }];
  list(from.joins, "joins").forEach((joinValue, k) => {
    const join = record(joinValue, "join");
    checkKeys(join, ["type", "from", "on", "hints"], "join");
    const joinFrom = asRec(join.from);
    const type = optionalStr(join, "type", "join");
    if (joinFrom?.name === undefined || joinFrom.name === "" || join.hints !== undefined || (type !== "" && type !== "left")
      || list(joinFrom.joins, "joins").length > 0 || joinFrom.database !== undefined || joinFrom.scan !== undefined || joinFrom.query !== undefined) {
      unsupported(`join ${k.toString()} has no text spelling`);
    }
    const joinPath = anchor(`.from.joins[${k.toString()}]`);
    units.push({ path: joinPath, lines: [`${indent}${type === "left" ? "left join " : "join "}${printSource(joinFrom)}`] });
    list(join.on, "on").forEach((condition, j) => {
      units.push({ path: joinPath === "" ? "" : `${joinPath}.on[${j.toString()}]`, lines: [`${indent}  on ${printCondition(condition, "")}`] });
    });
  });
  if (query.where !== undefined) units.push({ path: anchor(".where"), lines: [`${indent}where ${printCondition(query.where, "")}`] });
  const groupBy = list(query.groupBy, "groupBy");
  if (groupBy.length > 0) units.push({ path: anchor(".groupBy"), lines: [`${indent}group by ${printExpressionList(groupBy)}`] });
  if (query.having !== undefined) units.push({ path: anchor(".having"), lines: [`${indent}having ${printCondition(query.having, "")}`] });
  const orderBy = list(query.orderBy, "orderBy");
  if (orderBy.length > 0) {
    const parts = orderBy.map((order) => `${printExpression(order, 0)}${asRec(order)?.desc === true ? " desc" : ""}`);
    units.push({ path: anchor(".orderBy"), lines: [`${indent}order by ${parts.join(", ")}`] });
  }
  if (typeof query.limit === "number" && query.limit > 0) units.push({ path: anchor(".limit"), lines: [`${indent}limit ${String(query.limit)}`] });
  const columns = list(query.columns, "columns");
  if (columns.length > 0) units.push({ path: anchor(".columns"), lines: printColumns(columns, indent) });
  return units;
}

function printBody(body: Rec, indent: string): string[] {
  checkKeys(body, ["definitions", "query"], "body");
  const lines: string[] = [];
  for (const definition of list(body.definitions, "definitions")) lines.push(...printDefinition(definition, indent));
  for (const unit of printQueryUnits(body.query, indent, "")) lines.push(...unit.lines);
  return lines;
}

function printDefinition(value: unknown, indent: string): string[] {
  const definition = record(value, "definition");
  checkKeys(definition, ["kind", "name", "query", "path", "using"], "definition");
  const name = identText(str(definition.name, "definition name"), true);
  if (definition.kind === "cte") {
    if (definition.query === undefined) invalid("cte definition requires a query");
    return [`${indent}with ${name} as (`, ...printBody(record(definition.query, "definition query"), `${indent}  `), `${indent})`];
  }
  if (definition.kind !== "import") invalid("definition kind must be cte or import");
  const lines = [`${indent}with ${name} from ${quoteString(str(definition.path, "import path"))}`];
  const using = list(definition.using, "using");
  if (using.length === 0) return lines;
  lines.push(`${indent}  using (`);
  for (const mappingValue of using) {
    const mapping = record(mappingValue, "mapping");
    checkKeys(mapping, ["name", "expression"], "mapping");
    lines.push(`${indent}    @${str(mapping.name, "mapping name")} = ${printExpression(mapping.expression, 0)}`);
  }
  lines.push(`${indent}  )`);
  return lines;
}

function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

function printCommentLines(indent: string, comments: readonly TugQLComment[]): string[] {
  const lines: string[] = [];
  comments.forEach((comment, index) => {
    if (index > 0 && comment.blankBefore === true) lines.push("");
    lines.push(`${indent}-- ${comment.text}`.trimEnd());
  });
  return lines;
}

function printTree(tree: TugQLTree): string {
  checkKeys(tree as unknown as Rec, ["format", "version", "parameters", "definitions", "query", "comments"], "tree");
  const header = tree as { readonly format: unknown; readonly version: unknown };
  if (header.format !== "tugqtree" || header.version !== 1) invalid("unsupported TugQTree format or version");
  validateComments(tree.comments);
  const comments = tree.comments;
  const used = new Set<string>();
  const lines: string[] = [];
  const emit = (unit: PrintUnit, indent: string): void => {
    let group: TugQLCommentGroup = {};
    if (comments !== undefined && unit.path !== "") {
      group = comments.anchors?.[unit.path] ?? {};
      used.add(unit.path);
    }
    lines.push(...printCommentLines(indent, group.leading ?? []));
    const first = unit.lines[0]!;
    lines.push(group.trailing === undefined ? first : `${first} -- ${group.trailing.text}`.trimEnd());
    lines.push(...unit.lines.slice(1));
  };
  const parameters = list(tree.parameters, "parameters");
  if (parameters.length > 0) {
    emit({ path: "parameters", lines: ["parameters (", ...parameters.map((parameter) => `  ${printParameter(parameter)}`), ")"] }, "");
  }
  list(tree.definitions, "definitions").forEach((definition, index) => {
    emit({ path: `definitions[${index.toString()}]`, lines: printDefinition(definition, "") }, "");
  });
  if ((tree as { readonly query?: unknown }).query === undefined) invalid("query is required");
  for (const unit of printQueryUnits(tree.query, "", "query")) emit(unit, indentOf(unit.lines[0]!));
  if (comments !== undefined) {
    const end: TugQLComment[] = [...(comments.end ?? [])];
    // An anchor the tree has no element for is not dropped: its comments move to the end of the document.
    for (const path of Object.keys(comments.anchors ?? {}).filter((candidate) => !used.has(candidate)).sort()) {
      const group = comments.anchors![path]!;
      end.push(...(group.leading ?? []));
      if (group.trailing !== undefined) end.push(group.trailing);
    }
    lines.push(...printCommentLines("", end));
  }
  return lines.join("\n");
}

/** Renders a TugQTree, including its comments, as TugQL source text in the canonical lowercase layout. */
export function printTugQL(tree: TugQLTree): { readonly source?: string; readonly diagnostics: readonly TugQLDiagnostic[] } {
  try {
    return { source: printTree(tree), diagnostics: [] };
  } catch (error) {
    if (error instanceof ConversionError) return { diagnostics: [conversionDiagnostic(error.code, error.message)] };
    throw error;
  }
}

/**
 * Converts the structured TugQL YAML form into TugQL source text. Every `#`
 * comment becomes a `--` comment, so a `//` comment written in text comes back
 * as `--` after a text, YAML, text round trip. Constructs that have no text
 * spelling fail closed with a diagnostic.
 */
export function yamlToTugQL(yaml: string): { readonly source?: string; readonly diagnostics: readonly TugQLDiagnostic[] } {
  const lines = new LineCounter();
  const document = parseDocument(yaml, { lineCounter: lines, uniqueKeys: true });
  const failure = document.errors[0];
  if (failure !== undefined) return { diagnostics: [conversionDiagnostic("invalid_yaml", failure.message)] };
  if (document.contents === null || !isMap(document.contents)) {
    return { diagnostics: [conversionDiagnostic("invalid_yaml", "expected one TugQTree YAML document")] };
  }
  let data: unknown;
  try {
    data = document.toJS({ mapAsMap: false, maxAliasCount: 100 });
  } catch (error) {
    return { diagnostics: [conversionDiagnostic("invalid_yaml", error instanceof Error ? error.message : String(error))] };
  }
  const tree = asRec(data);
  if (tree === undefined) return { diagnostics: [conversionDiagnostic("invalid_tree", "TugQTree must be a mapping")] };
  if (tree.format !== "tugqtree" || tree.version !== 1) return { diagnostics: [conversionDiagnostic("invalid_tree", "unsupported TugQTree format or version")] };
  const comments = readYamlComments(yaml, document.contents, lines);
  return printTugQL({ ...(tree as unknown as TugQLTree), ...(comments === undefined ? {} : { comments }) });
}
