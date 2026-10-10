/* eslint-disable @typescript-eslint/no-non-null-assertion -- parser accesses are guarded by token count and cursor bounds checks. */

import { parseRecursiveDTQL } from "./recursive.js";
import type { DTQLSchema } from "./dtql.js";
import type { RecursiveDTQLQuery } from "./query.js";

/** Versioned TugQL and TugQTree authoring adapters. */
export const TUGQL_VERSION = 1 as const;
const TUGQL_TREE_FORMAT = "tugqtree" as const;
const TUGQL_SOURCE_FORMAT = "tugql" as const;

export interface TugQLPosition {
  readonly line: number;
  /** Unicode scalar-value column, one based. */
  readonly column: number;
}

export interface TugQLSpan {
  readonly start: TugQLPosition;
  /** Exclusive end position. */
  readonly end: TugQLPosition;
}

export interface TugQLDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly span: TugQLSpan;
}

export interface TugQLParameter {
  readonly name: string;
  readonly type: string;
  readonly required?: true;
  readonly default?: string | number | boolean | null;
}

export interface TugQLCTEDefinition {
  readonly kind: "cte";
  readonly name: string;
  readonly query: TugQLBody;
}

export interface TugQLImportMapping {
  readonly name: string;
  readonly expression: Readonly<Record<string, unknown>>;
}

export interface TugQLImportDefinition {
  readonly kind: "import";
  readonly name: string;
  readonly path: string;
  readonly using?: readonly TugQLImportMapping[];
}

export type TugQLDefinition = TugQLCTEDefinition | TugQLImportDefinition;

export interface TugQLBody {
  readonly definitions?: readonly TugQLDefinition[];
  readonly query: TugQLQueryDocument;
}

export interface TugQLQueryDocument extends Readonly<Record<string, unknown>> {
  readonly from: Readonly<Record<string, unknown>>;
}

export interface TugQLTree {
  readonly format: typeof TUGQL_TREE_FORMAT;
  readonly version: typeof TUGQL_VERSION;
  readonly parameters?: readonly TugQLParameter[];
  readonly definitions?: readonly TugQLDefinition[];
  readonly query: TugQLQueryDocument;
}

export interface TugQLDocument {
  readonly source?: string;
  readonly tree?: TugQLTree;
  readonly sourceMetadata: { readonly format: typeof TUGQL_SOURCE_FORMAT; readonly version: typeof TUGQL_VERSION };
}

interface TugQLSourceNode {
  readonly path: string;
  readonly span: TugQLSpan;
}

export interface TugQLParseResult {
  readonly document: TugQLDocument;
  readonly diagnostics: readonly TugQLDiagnostic[];
}

export interface TugQLFormatOptions {
  /** Explicit per-call overrides, treated as the active project/team preference. */
  readonly keywordCase?: "lowercase" | "uppercase" | "preserve-existing";
  readonly indentation?: "tab" | "two-spaces" | "preserve-existing";
  readonly projectTeamKeywordCase?: "lowercase" | "uppercase" | "preserve-existing";
  readonly userKeywordCase?: "lowercase" | "uppercase" | "preserve-existing";
  readonly defaultKeywordCase?: "lowercase" | "uppercase";
  readonly projectTeamIndentation?: "tab" | "two-spaces" | "preserve-existing";
  readonly userIndentation?: "tab" | "two-spaces" | "preserve-existing";
  readonly defaultIndentation?: "tab" | "two-spaces";
}

export interface TugQLFormatResult {
  readonly source: string;
  readonly diagnostics: readonly TugQLDiagnostic[];
}

export interface TugQLTypedField {
  readonly name: string;
  readonly type: string;
  readonly authorized: boolean;
}

export interface TugQLAuthorizedSchema {
  readonly database?: string;
  readonly schema?: string;
  readonly version: string;
  readonly tables: readonly { readonly name: string; readonly fields: readonly TugQLTypedField[] }[];
}

export interface TugQLRelationship {
  readonly id: string;
  readonly version: string;
  readonly from: { readonly source?: string; readonly table: string };
  readonly to: { readonly source?: string; readonly table: string };
  readonly pairs: readonly { readonly fromField: string; readonly toField: string }[];
  readonly exactTypedEquality: boolean;
}

export interface TugQLPinnedImport {
  readonly path: string;
  readonly revision: string;
  readonly source: string;
}

export interface TugQLResolveContext {
  readonly projectRoot?: string;
  readonly importingPath?: string;
  readonly projectRevision?: string;
  readonly authorizedSchemas: readonly TugQLAuthorizedSchema[];
  readonly relationships: readonly TugQLRelationship[];
  readonly pinnedImports: readonly TugQLPinnedImport[];
  readonly bindings?: readonly { readonly name: string; readonly set: boolean; readonly value?: unknown }[];
}

export interface TugQLOutputColumn {
  readonly name: string;
  readonly type: string;
  readonly lineage: readonly { readonly source: string; readonly field: string }[] | null;
}

export interface TugQLDependencyReceipt {
  readonly path: string;
  readonly revision: string;
}

export interface TugQLResolved {
  readonly query: import("./query.js").RecursiveDTQLQuery;
  readonly columns: readonly TugQLOutputColumn[];
  readonly schemaVersion: string;
  readonly dependencies: readonly TugQLDependencyReceipt[];
  readonly relationships: readonly { readonly id: string; readonly version: string; readonly fromSource: string; readonly toSource: string; readonly joinType: "inner" | "left"; readonly pairs: readonly { readonly fromField: string; readonly toField: string }[] }[];
}

export interface TugQLResolveResult {
  readonly resolved?: TugQLResolved;
  readonly diagnostics: readonly TugQLDiagnostic[];
}

const maxSourceScalars = 1 << 20;
const maxTokens = 1 << 18;
const maxSemanticDepth = 128;
const maxSemanticNodes = 5_000;
const maxExpandedImports = 128;
const zeroSpan: TugQLSpan = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

type TokenKind = "word" | "quoted-identifier" | "string" | "number" | "symbol" | "comment";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value: string;
  readonly span: TugQLSpan;
  readonly startOffset: number;
  readonly endOffset: number;
}

function firstUnpairedSurrogate(source: string): TugQLDiagnostic | undefined {
  let line = 1; let column = 1;
  for (let offset = 0; offset < source.length;) {
    const unit = source.charCodeAt(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(offset + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { offset += 2; column += 1; continue; }
      return { code: "invalid_utf8", message: "TugQL source must be valid UTF-8", span: { start: { line, column }, end: { line, column: column + 1 } } };
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return { code: "invalid_utf8", message: "TugQL source must be valid UTF-8", span: { start: { line, column }, end: { line, column: column + 1 } } };
    const point = String.fromCodePoint(source.codePointAt(offset) ?? unit);
    offset += point.length;
    if (point === "\r") {
      if (source[offset] === "\n") offset += 1;
      line += 1; column = 1;
    } else if (point === "\n") { line += 1; column = 1; }
    else column += 1;
  }
  return undefined;
}

function isValidISODate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidExactDecimal(value: string): boolean {
  let offset = value.startsWith("+") || value.startsWith("-") ? 1 : 0;
  let digits = 0;
  let dot = false;
  for (; offset < value.length; offset += 1) {
    const unit = value.charCodeAt(offset);
    if (unit >= 48 && unit <= 57) {
      digits += 1;
    } else if (unit === 46 && !dot) {
      dot = true;
    } else {
      return false;
    }
  }
  return digits > 0;
}

function isValidRFC3339Nano(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (match === null || !isValidISODate(match[1] ?? "")) return false;
  const hour = Number(match[2]); const minute = Number(match[3]); const second = Number(match[4]);
  const zoneHour = Number(match[8] ?? "0"); const zoneMinute = Number(match[9] ?? "0");
  return hour <= 23 && minute <= 59 && second <= 59 && zoneHour <= 23 && zoneMinute <= 59 && !Number.isNaN(Date.parse(value));
}

/** Tokenizes without interpreting clauses inside strings, quoted names, or comments. */
function tokenizeTugQL(source: string): { readonly tokens: readonly Token[]; readonly diagnostics: readonly TugQLDiagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: TugQLDiagnostic[] = [];
  const malformedSurrogate = firstUnpairedSurrogate(source);
  if (malformedSurrogate !== undefined) return { tokens, diagnostics: [malformedSurrogate] };
  let sourceScalars = 0;
  for (const scalar of source) {
    sourceScalars += scalar.length > 0 ? 1 : 0;
    if (sourceScalars > maxSourceScalars) return { tokens, diagnostics: [{ code: "input_too_large", message: "TugQL source exceeds the input limit", span: zeroSpan }] };
  }
  let offset = 0;
  let line = 1;
  let column = 1;
  const advance = (): string => {
    const point = String.fromCodePoint(source.codePointAt(offset) ?? 0);
    offset += point.length;
    if (point === "\r") {
      if (source[offset] === "\n") offset += 1;
      line += 1; column = 1;
    } else if (point === "\n") { line += 1; column = 1; } else { column += 1; }
    return point;
  };
  const spanFrom = (startLine: number, startColumn: number): TugQLSpan => ({ start: { line: startLine, column: startColumn }, end: { line, column } });
  const push = (kind: TokenKind, start: number, startLine: number, startColumn: number, value?: string): void => {
    const text = source.slice(start, offset);
    tokens.push({ kind, text, value: value ?? text, span: spanFrom(startLine, startColumn), startOffset: start, endOffset: offset });
    if (tokens.length === maxTokens + 1 && !diagnostics.some((item) => item.code === "too_many_tokens")) {
      diagnostics.push({ code: "too_many_tokens", message: "TugQL source exceeds the token limit", span: spanFrom(startLine, startColumn) });
    }
  };
  while (offset < source.length) {
    const current = String.fromCodePoint(source.codePointAt(offset) ?? 0);
    if (/\s/u.test(current)) { advance(); continue; }
    const start = offset;
    const startLine = line;
    const startColumn = column;
    if (source.startsWith("--", offset)) {
      advance(); advance();
      while (offset < source.length && source.codePointAt(offset) !== 10 && source.codePointAt(offset) !== 13) advance();
      push("comment", start, startLine, startColumn, source.slice(start + 2, offset));
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      const quote = advance();
      let value = "";
      let closed = false;
      while (offset < source.length) {
        const point = advance();
        if (point === quote) {
          const next = String.fromCodePoint(source.codePointAt(offset) ?? 0);
          if (next === quote) { advance(); value += quote; continue; }
          closed = true; break;
        }
        value += point;
      }
      const kind = quote === "'" ? "string" : "quoted-identifier";
      push(kind, start, startLine, startColumn, value);
      if (!closed) diagnostics.push({ code: "unterminated_quote", message: "quoted value is not terminated", span: spanFrom(startLine, startColumn) });
      continue;
    }
    if (/[\p{L}_]/u.test(current)) {
      advance();
      while (offset < source.length && /[\p{L}\p{N}_$]/u.test(String.fromCodePoint(source.codePointAt(offset) ?? 0))) advance();
      push("word", start, startLine, startColumn);
      continue;
    }
    if (current === "@") {
      advance();
      const nameStart = offset;
      while (offset < source.length && /[\p{L}\p{N}_$]/u.test(String.fromCodePoint(source.codePointAt(offset) ?? 0))) advance();
      push("word", start, startLine, startColumn);
      if (nameStart === offset) diagnostics.push({ code: "invalid_parameter", message: "parameter name is required after @", span: spanFrom(startLine, startColumn) });
      continue;
    }
    if (/[0-9]/u.test(current)) {
      advance();
      while (offset < source.length && /[0-9.]/u.test(String.fromCodePoint(source.codePointAt(offset) ?? 0))) advance();
      push("number", start, startLine, startColumn);
      continue;
    }
    const pair = source.slice(offset, offset + 2);
    if (["<=", ">=", "!=", "<>", "==", "||", "&&"].includes(pair)) { advance(); advance(); push("symbol", start, startLine, startColumn); continue; }
    if ("(),.*+-/%=<>;".includes(current)) { advance(); push("symbol", start, startLine, startColumn); continue; }
    advance();
    push("symbol", start, startLine, startColumn);
    diagnostics.push({ code: "unexpected-character", message: `unexpected character ${JSON.stringify(current)}`, span: spanFrom(startLine, startColumn) });
  }
  if (tokens.length > maxTokens) return { tokens: [], diagnostics };
  return { tokens, diagnostics };
}

interface SourceLine {
  readonly indent: string;
  readonly number: number;
  readonly tokens: readonly Token[];
}

interface Clause {
  readonly name: string;
  readonly tokens: readonly Token[];
  readonly span: TugQLSpan;
}

const lowerKeywords = new Set([
  "from", "join", "left", "on", "where", "group", "by", "having", "order", "limit", "offset", "select", "as", "and", "or", "not", "is", "null", "asc", "desc", "true", "false", "with", "parameters", "required", "default", "using", "inner", "outer", "cross", "distinct", "exists",
  ...["integer", "int", "decimal", "numeric", "float", "real", "text", "string", "boolean", "bool", "date", "datetime", "timestamp", "time", "json", "uuid"],
]);

function linesFromTokens(source: string, tokens: readonly Token[]): SourceLine[] {
  const rawLines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const lines = rawLines.map((raw, index) => {
    const indent = (/^[ \t]*/u.exec(raw))?.[0] ?? "";
    return { indent, number: index + 1, tokens: [] as Token[] };
  });
  for (const token of tokens) {
    if (token.kind !== "comment" && lines[token.span.start.line - 1] !== undefined) {
      (lines[token.span.start.line - 1] as { tokens: Token[] }).tokens.push(token);
    }
  }
  return lines;
}

function diagnostic(code: string, message: string, span: TugQLSpan): TugQLDiagnostic {
  return { code, message, span };
}

function spanForLine(line: SourceLine): TugQLSpan {
  const first = line.tokens[0];
  const last = line.tokens.at(-1);
  if (first === undefined || last === undefined) {
    return { start: { line: line.number, column: 1 }, end: { line: line.number, column: 1 } };
  }
  return { start: first.span.start, end: last.span.end };
}

function keyword(token: Token | undefined, value: string): boolean {
  return token?.kind === "word" && token.value.toLowerCase() === value;
}

function isKeywordRole(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token?.kind !== "word" || !lowerKeywords.has(token.value.toLowerCase())) return false;
  if (tokens[index - 1]?.text === ".") return false;
  if (tokens[index + 1]?.text === "(" && !["select", "parameters", "as"].includes(token.value.toLowerCase())) return false;
  return true;
}

function validateKeywordStyle(tokens: readonly Token[]): TugQLDiagnostic[] {
  const issues: TugQLDiagnostic[] = [];
  let style: "lower" | "upper" | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!isKeywordRole(tokens, index)) continue;
    const wordStyle = token.value === token.value.toLowerCase() ? "lower" : token.value === token.value.toUpperCase() ? "upper" : "mixed";
    if (wordStyle === "mixed" || (style !== undefined && style !== wordStyle)) {
      issues.push(diagnostic("keyword_case", "reserved words must be consistently lowercase or uppercase", token.span));
    } else style ??= wordStyle;
  }
  return issues;
}

function clauseStart(tokens: readonly Token[]): { readonly name: string; readonly count: number } | undefined {
  if (tokens.length === 0 || tokens[0]?.kind !== "word") return undefined;
  if (keyword(tokens[0], "left") && keyword(tokens[1], "join")) return { name: "left join", count: 2 };
  if (keyword(tokens[0], "group") && keyword(tokens[1], "by")) return { name: "group by", count: 2 };
  if (keyword(tokens[0], "order") && keyword(tokens[1], "by")) return { name: "order by", count: 2 };
  for (const name of ["from", "join", "on", "where", "having", "limit", "offset", "select"]) {
    if (keyword(tokens[0], name)) return { name, count: 1 };
  }
  return undefined;
}

function collectClauses(lines: readonly SourceLine[]): { readonly clauses: readonly Clause[]; readonly diagnostics: readonly TugQLDiagnostic[] } {
  const clauses: Clause[] = [];
  const diagnostics: TugQLDiagnostic[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.tokens.length === 0) continue;
    const start = clauseStart(line.tokens);
    if (start === undefined) {
      const previous = clauses.at(-1);
      if (line.tokens.length === 1 && line.tokens[0]!.text === ")" && previous !== undefined && parenthesisBalance(previous.tokens) > 0) {
        clauses[clauses.length - 1] = { ...previous, tokens: [...previous.tokens, ...line.tokens], span: { start: previous.span.start, end: line.tokens[0]!.span.end } };
        continue;
      }
      diagnostics.push(diagnostic("unsupported_statement", "unrecognized or unsupported TugQL construct", line.tokens[0]!.span));
      continue;
    }
    const consumedTokens = line.tokens.slice(start.count);
    let end = line.tokens.at(-1)!.span.end;
    const clauseTokens = [...consumedTokens];
    let openDepth = parenthesisBalance(clauseTokens);
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!;
      if (next.tokens.length === 0) continue;
      if (openDepth > 0) {
        clauseTokens.push(...next.tokens);
        openDepth += parenthesisBalance(next.tokens);
        end = next.tokens.at(-1)!.span.end;
        i = j;
        continue;
      }
      if (clauseStart(next.tokens) !== undefined || next.indent.length <= line.indent.length) break;
      clauseTokens.push(...next.tokens);
      openDepth += parenthesisBalance(next.tokens);
      end = next.tokens.at(-1)!.span.end;
      i = j;
    }
    clauses.push({ name: start.name, tokens: clauseTokens, span: { start: line.tokens[0]!.span.start, end } });
  }
  return { clauses, diagnostics };
}

function parenthesisBalance(tokens: readonly Token[]): number {
  return tokens.reduce((balance, token) => balance + (token.text === "(" ? 1 : token.text === ")" ? -1 : 0), 0);
}

function structuralIndentUnit(lines: readonly SourceLine[]): { readonly unit: string; readonly diagnostics: TugQLDiagnostic[] } {
  let style: "spaces" | "tabs" | undefined;
  const diagnostics: TugQLDiagnostic[] = [];
  for (const line of lines) {
    if (line.tokens.length === 0 || line.indent.length === 0) continue;
    const hasSpaces = line.indent.includes(" ");
    const hasTabs = line.indent.includes("\t");
    if (hasSpaces && hasTabs) {
      diagnostics.push(diagnostic("indentation", "tabs and spaces cannot be mixed", line.tokens[0]!.span));
      continue;
    }
    const current: "spaces" | "tabs" = hasTabs ? "tabs" : "spaces";
    if (current === "spaces" && line.indent.length % 2 !== 0) diagnostics.push(diagnostic("indentation", "spaces must be used in two-space levels", spanForLine(line)));
    if (style !== undefined && style !== current) diagnostics.push(diagnostic("indentation", "tabs and spaces cannot be mixed", line.tokens[0]!.span));
    style ??= current;
  }
  return { unit: style === "tabs" ? "\t" : "  ", diagnostics };
}

function validateQueryIndentation(lines: readonly SourceLine[], clauses: readonly Clause[]): TugQLDiagnostic[] {
  const result = structuralIndentUnit(lines);
  const diagnostics = [...result.diagnostics];
  let joinPending = false;
  for (const clause of clauses) {
    const line = lines[clause.span.start.line - 1];
    const indent = line?.indent ?? "";
    if (clause.name === "on") {
      if (!joinPending || indent !== result.unit) diagnostics.push(diagnostic("indentation", "ON must follow JOIN and use one structural indent level", clause.span));
      joinPending = false;
    } else {
      if (indent !== "") diagnostics.push(diagnostic("indentation", "top-level query clauses must not be indented", clause.span));
      joinPending = clause.name === "join" || clause.name === "left join";
    }
  }
  return diagnostics;
}

function validateInlineSyntax(lines: readonly SourceLine[]): TugQLDiagnostic[] {
  const diagnostics: TugQLDiagnostic[] = [];
  for (const line of lines) {
    let depth = 0;
    const leadingClause = clauseStart(line.tokens);
    const importHeaderFrom = keyword(line.tokens[0], "with") && line.tokens[1]?.kind === "word" && keyword(line.tokens[2], "from") ? 2 : -1;
    for (let i = leadingClause?.count ?? Math.min(1, line.tokens.length); i < line.tokens.length; i += 1) {
      const token = line.tokens[i]!;
      if (token.text === "(") { depth += 1; continue; }
      if (token.text === ")") { depth -= 1; continue; }
      if (depth !== 0) continue;
      if (token.text === ";") {
        const nextClause = clauseStart(line.tokens.slice(i + 1));
        diagnostics.push(diagnostic("multiple_statements", "semicolon-separated statements are not supported", nextClause === undefined ? token.span : line.tokens[i + 1]!.span));
        continue;
      }
      if (i > 0 && clauseStart(line.tokens.slice(i)) !== undefined) {
        if (i === importHeaderFrom) continue;
        diagnostics.push(diagnostic("multiple_clauses_same_line", "each query clause must start on its own line", token.span));
      }
    }
  }
  return diagnostics;
}

function parseCommaItems(tokens: readonly Token[]): Token[][] {
  const groups: Token[][] = [];
  let group: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (token.text === "," && depth === 0) {
      if (group.length === 0) throw new Error("empty list item");
      groups.push(group); group = []; continue;
    }
    group.push(token);
  }
  if (depth !== 0) throw new Error(depth > 0 ? "unclosed parenthesis" : "unexpected closing parenthesis");
  if (group.length === 0) throw new Error("empty list item");
  groups.push(group);
  return groups;
}

interface ExpressionParser {
  readonly tokens: readonly Token[];
  at: number;
  depth: number;
}

function parseExpression(tokens: readonly Token[]): Readonly<Record<string, unknown>> {
  const parser: ExpressionParser = { tokens, at: 0, depth: 0 };
  const result = parseExpressionAt(parser, 0);
  if (parser.at !== tokens.length) throw new Error(`unexpected token ${JSON.stringify(tokens[parser.at]?.text ?? "")}`);
  return result;
}

function parseExpressionAt(parser: ExpressionParser, minPrecedence: number): Readonly<Record<string, unknown>> {
  if (parser.depth >= 128) throw new Error("expression nesting exceeds 128");
  let left = parseExpressionPrimary(parser);
  while (parser.at < parser.tokens.length) {
    const op = parser.tokens[parser.at]!;
    const precedence = op.text === "+" || op.text === "-" ? 10 : op.text === "*" || op.text === "/" ? 20 : -1;
    if (precedence < minPrecedence) break;
    parser.at += 1;
    const right = parseExpressionAt(parser, precedence + 1);
    left = { binary: { op: op.text, left, right } };
  }
  return left;
}

function parseExpressionPrimary(parser: ExpressionParser): Readonly<Record<string, unknown>> {
  const token = parser.tokens[parser.at];
  if (token === undefined) throw new Error("expected expression");
  parser.at += 1;
  if (token.text.startsWith("@") && token.kind === "word") return { param: token.text.slice(1) };
  if (token.kind === "number") {
    if (token.text.includes(".")) throw new Error(`decimal literal ${JSON.stringify(token.text)} cannot be represented without precision loss`);
    const value = Number(token.text);
    if (!Number.isSafeInteger(value)) throw new Error(`integer literal ${JSON.stringify(token.text)} exceeds the exact portable range`);
    return { value };
  }
  if (token.kind === "string") return { value: token.value };
  if (token.kind === "symbol" && token.text === "*") return { star: true };
  if (token.kind === "symbol" && token.text === "(") {
    parser.depth += 1;
    const inside = parseExpressionAt(parser, 0);
    parser.depth -= 1;
    if (parser.tokens[parser.at]?.text !== ")") throw new Error("expected closing parenthesis");
    parser.at += 1;
    return inside;
  }
  if (token.kind !== "word" && token.kind !== "quoted-identifier") throw new Error(`expected expression, got ${JSON.stringify(token.text)}`);
  if (token.kind === "word") {
    if (token.value.toLowerCase() === "true") return { value: true };
    if (token.value.toLowerCase() === "false") return { value: false };
    if (token.value.toLowerCase() === "null") return { value: null };
  }
  const name = token.kind === "quoted-identifier" ? token.value : token.text;
  if (parser.tokens[parser.at]?.text === "(") {
    parser.at += 1;
    parser.depth += 1;
    const args: Readonly<Record<string, unknown>>[] = [];
    if (parser.tokens[parser.at]?.text !== ")") {
      while (parser.at < parser.tokens.length && parser.tokens[parser.at]?.text !== ")") {
        args.push(parseExpressionAt(parser, 0));
        if (parser.tokens[parser.at]?.text !== ",") break;
        parser.at += 1;
      }
    }
    parser.depth -= 1;
    if (parser.tokens[parser.at]?.text !== ")") throw new Error(`function ${name} is missing closing parenthesis`);
    parser.at += 1;
    const normalizedName = name.toLowerCase();
    if (["count", "sum", "avg", "min", "max", "first", "last"].includes(normalizedName)) return { aggregate: { function: name, args } };
    return { call: { function: name, args } };
  }
  if (parser.tokens[parser.at]?.text === ".") {
    parser.at += 1;
    const fieldToken = parser.tokens[parser.at];
    if (fieldToken === undefined || (fieldToken.kind !== "word" && fieldToken.kind !== "quoted-identifier" && fieldToken.text !== "*")) throw new Error("expected field name after qualifier");
    parser.at += 1;
    if (fieldToken.text === "*") throw new Error("unsupported_projection: qualified wildcard is not representable by the existing structured-query model");
    return { field: fieldToken.kind === "quoted-identifier" ? fieldToken.value : fieldToken.text, source: name };
  }
  return { field: name };
}

function parseFrom(tokens: readonly Token[]): Readonly<Record<string, unknown>> {
  if (tokens.length === 0) throw new Error("source name is required");
  const first = tokens[0]!;
  if (first.kind !== "word" && first.kind !== "quoted-identifier") throw new Error("source name must be an identifier");
  const parts = [first.kind === "quoted-identifier" ? first.value : first.text];
  let at = 1;
  while (tokens[at]?.text === ".") {
    const part = tokens[at + 1];
    if (part === undefined || (part.kind !== "word" && part.kind !== "quoted-identifier")) throw new Error("expected identifier after '.'");
    parts.push(part.kind === "quoted-identifier" ? part.value : part.text);
    at += 2;
  }
  const from: Record<string, unknown> = { name: parts.at(-1)! };
  if (parts.length > 1) from.schema = parts.slice(0, -1).join(".");
  if (at < tokens.length) {
    if (!keyword(tokens[at], "as") || at + 2 !== tokens.length) throw new Error("aliases require AS followed by one identifier");
    const alias = tokens[at + 1]!;
    if (alias.kind !== "word" && alias.kind !== "quoted-identifier") throw new Error("aliases require AS followed by one identifier");
    from.alias = alias.kind === "quoted-identifier" ? alias.value : alias.text;
  }
  return from;
}

function parseCondition(tokens: readonly Token[], depth = 0): Readonly<Record<string, unknown>> {
  if (tokens.length === 0) throw new Error("condition is required");
  if (depth >= 128) throw new Error("condition nesting exceeds 128");
  for (const word of ["or", "and"]) {
    const children = splitAtWord(tokens, word);
    if (children !== undefined) return { [word]: children.map((child) => parseCondition(child, depth + 1)) };
  }
  if (tokens[0]?.text === "(" && tokens.at(-1)?.text === ")") return parseCondition(tokens.slice(1, -1), depth + 1);
  if (tokens.length >= 2 && keyword(tokens.at(-2), "is")) {
    if (keyword(tokens.at(-1), "null")) return { isNull: parseExpression(tokens.slice(0, -2)) };
  }
  if (tokens.length >= 3 && keyword(tokens.at(-3), "is") && keyword(tokens.at(-2), "not") && keyword(tokens.at(-1), "null")) {
    return { isNotNull: parseExpression(tokens.slice(0, -3)) };
  }
  let parens = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.text === "(") { parens += 1; continue; }
    if (token.text === ")") { parens -= 1; continue; }
    if (parens === 0 && ["=", "==", "!=", "<>", "<", ">", "<=", ">="].includes(token.text)) {
      if (i === 0 || i + 1 === tokens.length) throw new Error("comparison requires left and right expressions");
      return { op: token.text === "=" ? "==" : token.text, left: parseExpression(tokens.slice(0, i)), right: parseExpression(tokens.slice(i + 1)) };
    }
  }
  throw new Error("unsupported condition");
}

function splitAtWord(tokens: readonly Token[], word: string): Token[][] | undefined {
  let depth = 0;
  let start = 0;
  const result: Token[][] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (depth === 0 && keyword(token, word)) {
      if (i === start) throw new Error(`empty expression around ${word.toUpperCase()}`);
      result.push(tokens.slice(start, i)); start = i + 1;
    }
  }
  if (result.length === 0) return undefined;
  if (start === tokens.length) throw new Error(`missing expression after ${word.toUpperCase()}`);
  result.push(tokens.slice(start));
  return result;
}

function parseColumns(tokens: readonly Token[], source: string): Readonly<Record<string, unknown>>[] {
  const opening = tokens[0];
  const closing = tokens.at(-1);
  const block = opening?.text === "(" && closing?.text === ")" && opening.span.start.line !== closing.span.start.line;
  if (block) {
    const rawLines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const closingLine = rawLines[closing.span.start.line - 1] ?? "";
    const openingLine = rawLines[opening.span.start.line - 1] ?? "";
    const openingIndent = (/^[ \t]*/u.exec(openingLine)?.[0]) ?? "";
    const closingIndent = (/^[ \t]*/u.exec(closingLine)?.[0]) ?? "";
    if (closingLine.trim() !== ")" || closingIndent !== openingIndent) throw new Error("SELECT block closing ')' must be alone and aligned with SELECT");
  }
  const items = block ? splitSelectBlock(tokens.slice(1, -1)) : parseCommaItems(tokens);
  return items.map((item) => {
    if (block && item.length >= 4 && (item[0]!.kind === "word" || item[0]!.kind === "quoted-identifier") && keyword(item[1], "as") && item[2]!.text === "(") {
      return parseScalarColumn(item, source);
    }
    let depth = 0;
    let aliasIndex = -1;
    for (let i = 0; i < item.length; i += 1) {
      if (item[i]!.text === "(") depth += 1;
      if (item[i]!.text === ")") depth -= 1;
      if (depth === 0 && keyword(item[i], "as")) aliasIndex = i;
    }
    const column: Record<string, unknown> = {};
    if (aliasIndex >= 0) {
      if (aliasIndex === 0 || aliasIndex + 2 !== item.length) throw new Error("selected-field aliases require AS and one identifier");
      const alias = item[aliasIndex + 1]!;
      if (alias.kind !== "word" && alias.kind !== "quoted-identifier") throw new Error("selected-field aliases require AS and one identifier");
      Object.assign(column, parseExpression(item.slice(0, aliasIndex)), { as: alias.kind === "quoted-identifier" ? alias.value : alias.text });
    } else Object.assign(column, parseExpression(item));
    return column;
  });
}

function splitSelectBlock(tokens: readonly Token[]): Token[][] {
  const items: Token[][] = [];
  let item: Token[] = [];
  let depth = 0;
  let priorLine = -1;
  for (const token of tokens) {
    if (depth === 0 && item.length > 0 && token.span.start.line > priorLine) { items.push(item); item = []; }
    if (token.text === "," && depth === 0) {
      throw new Error("commas are not allowed in a SELECT block");
    }
    item.push(token);
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    priorLine = token.span.start.line;
  }
  if (depth !== 0) throw new Error("unclosed SELECT block parenthesis");
  if (item.length === 0) throw new Error("SELECT block must contain at least one item");
  items.push(item);
  return items;
}

function parseScalarColumn(item: readonly Token[], source: string): Readonly<Record<string, unknown>> {
  const open = item[2]!;
  const close = item.at(-1)!;
  if (open.span.start.line === close.span.start.line) throw new Error("scalar subquery requires a nested body and a closing ')' on its own line");
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const startLine = open.span.start.line;
  const closeLine = close.span.start.line;
  const itemIndent = (/^[ \t]*/u.exec(lines[item[0]!.span.start.line - 1] ?? ""))?.[0] ?? "";
  if ((lines[closeLine - 1] ?? "").trim() !== ")" || ((/^[ \t]*/u.exec(lines[closeLine - 1] ?? ""))?.[0] ?? "") !== itemIndent) throw new Error("scalar subquery closing ')' must be alone and aligned with its name");
  const indentation = structuralIndentUnit(linesFromTokens(source, tokenizeTugQL(source).tokens)).unit;
  const prefix = itemIndent + indentation;
  const bodyLines = lines.slice(startLine, closeLine - 1);
  for (const line of bodyLines) if (line.trim().length > 0 && !line.startsWith(prefix)) throw new Error("nested query body must add one structural indentation level");
  const bodyText = bodyLines.map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).join("\n");
  const parsed = parseDocumentInner(bodyText, false, 1);
  if (parsed.diagnostics.length > 0 || parsed.document.tree === undefined) throw new Error(`nested scalar query: ${parsed.diagnostics[0]?.message ?? "invalid nested query"}`);
  const name = item[0]!.kind === "quoted-identifier" ? item[0]!.value : item[0]!.text;
  const tree = parsed.document.tree;
  return { query: { ...(tree.definitions === undefined ? {} : { definitions: tree.definitions }), query: tree.query }, as: name };
}

function parseOrders(tokens: readonly Token[]): Readonly<Record<string, unknown>>[] {
  return parseCommaItems(tokens).map((item) => {
    let desc = false;
    const last = item.at(-1);
    if (keyword(last, "asc") || keyword(last, "desc")) {
      desc = keyword(last, "desc");
      item.pop();
    }
    if (item.length === 0) throw new Error("order key is required");
    return { ...parseExpression(item), ...(desc ? { desc: true } : {}) };
  });
}

function parseQuery(source: string): { readonly query?: TugQLQueryDocument; readonly diagnostics: readonly TugQLDiagnostic[]; readonly spans: readonly TugQLSourceNode[] } {
  const tokenized = tokenizeTugQL(source);
  const lines = linesFromTokens(source, tokenized.tokens);
  const keywordDiagnostics = validateKeywordStyle(tokenized.tokens);
  const diagnostics = [...tokenized.diagnostics];
  const { clauses, diagnostics: clauseDiagnostics } = collectClauses(lines);
  diagnostics.push(...clauseDiagnostics);
  diagnostics.push(...validateInlineSyntax(lines));
  diagnostics.push(...validateQueryIndentation(lines, clauses));
  const allowed = new Set(["from", "join", "left join", "on", "where", "group by", "having", "order by", "limit", "offset", "select"]);
  const orderRank = new Map([["from", 0], ["join", 1], ["left join", 1], ["on", 1], ["where", 2], ["group by", 3], ["having", 4], ["order by", 5], ["limit", 6], ["offset", 6], ["select", 7]]);
  const seen = new Set<string>();
  let lastRank = 0;
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i]!;
    if (!allowed.has(clause.name)) diagnostics.push(diagnostic("unsupported_clause", `unsupported TugQL clause ${clause.name.toUpperCase()}`, clause.span));
    if (!new Set(["join", "left join", "on"]).has(clause.name) && seen.has(clause.name)) diagnostics.push(diagnostic("duplicate_clause", `clause appears more than once: ${clause.name.toUpperCase()}`, clause.span));
    seen.add(clause.name);
    const rank = orderRank.get(clause.name);
    if (rank !== undefined && i > 0 && rank < lastRank) diagnostics.push(diagnostic("clause_order", "query clauses are out of order", clause.span));
    if (rank !== undefined) lastRank = rank;
    if (clause.name === "select" && i !== clauses.length - 1) diagnostics.push(diagnostic("select_must_be_last", "SELECT must be the final clause", clause.span));
    if (i > 0 && clause.name === "from") diagnostics.push(diagnostic("multiple_statements", "a TugQL query may contain only one FROM body", clause.span));
  }
  if (clauses.length === 0 || clauses[0]?.name !== "from") diagnostics.push(diagnostic("expected_from", "a TugQL query must begin with FROM", zeroSpan));
  if (diagnostics.length > 0) return { diagnostics, spans: clauses.map((clause, i) => ({ path: `query.clauses[${i.toString()}]`, span: clause.span })) };
  let rootFrom: Record<string, unknown>;
  try { rootFrom = { ...parseFrom(clauses[0]!.tokens) }; }
  catch (error) {
    const derivedClose = clauses[0]!.tokens[0]?.text === "("
      ? lines.find((line) => line.tokens[0]?.text === ")" && line.tokens.length > 1)
      : undefined;
    if (derivedClose !== undefined) return { diagnostics: [diagnostic("indentation", "expression continuation must use one structural indent level", spanForLine(derivedClose))], spans: [] };
    return { diagnostics: [diagnostic("invalid_from", errorMessage(error), clauses[0]!.span)], spans: [] };
  }
  const query: Record<string, unknown> = { from: rootFrom };
  const spans: TugQLSourceNode[] = [{ path: "query.from", span: clauses[0]!.span }];
  const joins: Record<string, unknown>[] = [];
  let currentJoin: Record<string, unknown> | undefined;
  for (const clause of clauses.slice(1)) {
    try {
      switch (clause.name) {
        case "join": case "left join": {
          const join: Record<string, unknown> = { from: parseFrom(clause.tokens), on: [] as unknown[] };
          if (clause.name === "left join") join.type = "left";
          joins.push(join); rootFrom.joins = joins; currentJoin = join; break;
        }
        case "on": {
          if (currentJoin === undefined) throw new Error("ON must follow a JOIN");
          const on = currentJoin.on as unknown[];
          if (clause.tokens.length === 1 || (clause.tokens.length === 3 && clause.tokens[1]?.text === ".")) {
            const shorthand = parseExpression(clause.tokens);
            if (!isFieldNode(shorthand)) throw new Error("ON shorthand requires one field reference");
            on.push({ op: "relationship", left: shorthand });
          } else on.push(parseCondition(clause.tokens));
          break;
        }
        case "where": query.where = parseCondition(clause.tokens); break;
        case "group by": query.groupBy = parseCommaItems(clause.tokens).map(parseExpression); break;
        case "having": query.having = parseCondition(clause.tokens); break;
        case "order by": query.orderBy = parseOrders(clause.tokens); break;
        case "limit": case "offset": {
          if (clause.tokens.length !== 1 || clause.tokens[0]!.kind !== "number" || clause.tokens[0]!.text.includes(".")) throw new Error(`${clause.name.toUpperCase()} requires one non-negative integer`);
          const value = Number(clause.tokens[0]!.text);
          if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${clause.name.toUpperCase()} is outside the supported range`);
          query[clause.name] = value; break;
        }
        case "select": query.columns = parseColumns(clause.tokens, source); break;
        default: break;
      }
      spans.push({ path: `query.${clause.name.replaceAll(" ", "_")}`, span: clause.span });
    } catch (error) {
      const message = errorMessage(error);
      const explicitCode = /^([a-z_]+): /u.exec(message)?.[1];
      const code = explicitCode ?? (clause.name === "from" ? "invalid_from" : clause.name === "select" ? "invalid_select" : clause.name === "limit" || clause.name === "offset" ? `invalid_${clause.name}` : clause.name === "group by" ? "invalid_group_by" : clause.name === "order by" ? "invalid_order_by" : "invalid_condition");
      diagnostics.push(diagnostic(code, explicitCode === undefined ? message : message.slice(explicitCode.length + 2), clause.span));
    }
  }
  if (diagnostics.length === 0) diagnostics.push(...keywordDiagnostics);
  return diagnostics.length === 0 ? { query: query as TugQLQueryDocument, diagnostics, spans } : { diagnostics, spans };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function findBlockClose(lines: readonly SourceLine[], start: number, headerIndent: string): number {
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.tokens.length === 1 && line.tokens[0]!.text === ")" && line.indent === headerIndent) return i;
    if (line.tokens.length > 0 && line.indent.length <= headerIndent.length) return -1;
  }
  return -1;
}

function parseParameter(tokens: readonly Token[]): TugQLParameter {
  if (tokens.length < 3 || !tokens[0]?.text.startsWith("@") || tokens[0].text.length < 2 || (tokens[1]?.kind !== "word" && tokens[1]?.kind !== "quoted-identifier")) {
    throw new Error("declaration must be @Name <type> REQUIRED or DEFAULT <literal>");
  }
  const name = tokens[0].text.slice(1);
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) throw new Error(`invalid parameter name ${JSON.stringify(name)}`);
  const type = tokens[1].kind === "quoted-identifier" ? tokens[1].value : tokens[1].text;
  if (!["integer", "decimal", "string", "boolean", "date", "datetime", "timestamp"].includes(type.toLowerCase())) throw new Error(`unsupported parameter type ${JSON.stringify(type)}`);
  if (tokens.length === 3 && keyword(tokens[2], "required")) return { name, type, required: true };
  if (!keyword(tokens[2], "default") || (tokens.length !== 4 && tokens.length !== 5)) throw new Error("declaration must use REQUIRED or DEFAULT; DEFAULT accepts one literal");
  const sign = tokens.length === 5 ? tokens[3]!.text : "";
  if (tokens.length === 5 && (tokens[3]!.kind !== "symbol" || (sign !== "+" && sign !== "-"))) throw new Error("DEFAULT accepts only an optional numeric sign");
  const literal = tokens[tokens.length - 1]!;
  if (tokens.length === 5 && !["integer", "decimal"].includes(type.toLowerCase())) throw new Error(`${type} DEFAULT does not accept a numeric sign`);
  const numericLexeme = `${sign}${literal.text}`;
  const foldedType = type.toLowerCase();
  if (foldedType === "integer") {
    if (literal.kind !== "number" || literal.text.includes(".")) throw new Error(`${type} DEFAULT requires an integer literal`);
    const number = Number(numericLexeme);
    if (!Number.isSafeInteger(number)) throw new Error("integer DEFAULT exceeds the exact portable range");
    return { name, type, default: number };
  }
  if (foldedType === "decimal") {
    if (literal.kind !== "number" || !isValidExactDecimal(numericLexeme)) throw new Error("DECIMAL DEFAULT requires a finite decimal literal");
    // Keep the decimal lexeme exact; conversion to JS number is lossy.
    return { name, type, default: numericLexeme };
  }
  if (foldedType === "string") {
    if (literal.kind !== "string") throw new Error(`${type} DEFAULT requires a quoted string literal`);
    return { name, type, default: literal.value };
  }
  if (foldedType === "boolean") {
    if (keyword(literal, "true")) return { name, type, default: true };
    if (keyword(literal, "false")) return { name, type, default: false };
    throw new Error(`${type} DEFAULT requires TRUE or FALSE`);
  }
  if (foldedType === "date") {
    if (literal.kind !== "string" || !isValidISODate(literal.value)) throw new Error("DATE DEFAULT must be a real YYYY-MM-DD date");
    return { name, type, default: literal.value };
  }
  if (["datetime", "timestamp"].includes(foldedType)) {
    if (literal.kind !== "string" || !isValidRFC3339Nano(literal.value)) throw new Error(`${type} DEFAULT must be a valid RFC3339 timestamp`);
    return { name, type, default: literal.value };
  }
  throw new Error(`unsupported parameter type ${JSON.stringify(type)}`);
}

function parseDefinition(lines: readonly SourceLine[], rawLines: readonly string[], start: number, depth = 0): { readonly definition?: TugQLDefinition; readonly next: number; readonly diagnostics: readonly TugQLDiagnostic[]; readonly nodes: readonly TugQLSourceNode[] } {
  const line = lines[start]!;
  const tokens = line.tokens;
  const headerSpan = spanForLine(line);
  if (depth >= 128) return { next: start + 1, diagnostics: [diagnostic("nesting_limit", "TugQL query nesting exceeds 128", headerSpan)], nodes: [] };
  if (tokens.length >= 4 && (tokens[1]!.kind === "word" || tokens[1]!.kind === "quoted-identifier") && keyword(tokens[2], "as")) {
      if (tokens[3]!.text !== "(" || tokens.length !== 4) return { next: start + 1, diagnostics: [diagnostic("invalid_cte", "WITH name AS ( must keep '(' on the declaration line", headerSpan)], nodes: [] };
    const close = findBlockClose(lines, start + 1, line.indent);
    if (close < 0) return { next: lines.length, diagnostics: [diagnostic("unclosed_cte", "WITH query must close with ')' on its own line", headerSpan)], nodes: [] };
    const bodyResult = parseNestedBody(lines, rawLines, start + 1, close, depth + 1);
    const nameToken = tokens[1]!;
    const name = nameToken.kind === "quoted-identifier" ? nameToken.value : nameToken.text;
    const definition: TugQLCTEDefinition = { kind: "cte", name, query: bodyResult.body };
    return { definition, next: close + 1, diagnostics: bodyResult.diagnostics, nodes: [{ path: `definitions.${name}`, span: headerSpan }, ...bodyResult.nodes] };
  }
  if (tokens.length === 4 && (tokens[1]!.kind === "word" || tokens[1]!.kind === "quoted-identifier") && keyword(tokens[2], "from") && (tokens[3]!.kind === "string" || tokens[3]!.kind === "quoted-identifier")) {
    const nameToken = tokens[1]!;
    const name = nameToken.kind === "quoted-identifier" ? nameToken.value : nameToken.text;
    const definition: TugQLImportDefinition = { kind: "import", name, path: tokens[3]!.value };
    if (lines[start + 1]?.tokens[0] === undefined || !keyword(lines[start + 1]!.tokens[0], "using")) return { definition, next: start + 1, diagnostics: [], nodes: [{ path: `definitions.${name}`, span: headerSpan }] };
    const usingLine = lines[start + 1]!;
    const indent = structuralIndentUnit(lines).unit;
    const diagnostics: TugQLDiagnostic[] = [];
    if (usingLine.indent !== line.indent + indent) diagnostics.push(diagnostic("indentation", "USING must be indented one structural level beneath its import", spanForLine(usingLine)));
    if (usingLine.tokens.length !== 2 || usingLine.tokens[1]!.text !== "(") return { definition, next: start + 2, diagnostics: [diagnostic("invalid_using", "USING ( must keep '(' on its header line", spanForLine(usingLine))], nodes: [] };
    const close = findBlockClose(lines, start + 2, usingLine.indent);
    if (close < 0) return { definition, next: lines.length, diagnostics: [diagnostic("unclosed_using", "USING mappings must close with ')' on its own line", spanForLine(usingLine))], nodes: [] };
    const mappings: TugQLImportMapping[] = [];
    for (let i = start + 2; i < close; i += 1) {
      const mappingTokens = lines[i]!.tokens;
      if (mappingTokens.length === 0) continue;
      try {
        if (lines[i]!.indent !== usingLine.indent + indent) throw new Error("parameter mappings must be indented one structural level beneath USING");
        if (!mappingTokens[0]!.text.startsWith("@") || mappingTokens[1]?.text !== "=") throw new Error("mapping must be @Name = expression");
        const expression = parseExpression(mappingTokens.slice(2));
        mappings.push({ name: mappingTokens[0]!.text.slice(1), expression });
      } catch (error) { diagnostics.push(diagnostic("invalid_mapping", errorMessage(error), spanForLine(lines[i]!))); }
    }
    return { definition: { ...definition, using: mappings }, next: close + 1, diagnostics, nodes: [{ path: `definitions.${name}`, span: headerSpan }] };
  }
  return { next: start + 1, diagnostics: [diagnostic("invalid_with", "WITH must declare a CTE using AS ( or an import using FROM", headerSpan)], nodes: [] };
}

function parseNestedBody(lines: readonly SourceLine[], rawLines: readonly string[], start: number, close: number, depth: number): { readonly body: TugQLBody; readonly diagnostics: readonly TugQLDiagnostic[]; readonly nodes: readonly TugQLSourceNode[] } {
  const headerIndent = lines[start - 1]?.indent ?? "";
  const indentation = structuralIndentUnit(lines);
  const prefix = headerIndent + indentation.unit;
  const diagnostics = [...indentation.diagnostics];
  for (let i = start; i < close; i += 1) {
    const line = lines[i]!;
    if (line.tokens.length > 0 && !line.indent.startsWith(prefix)) diagnostics.push(diagnostic("indentation", "nested query body must add one structural indentation level", spanForLine(line)));
  }
  const dedented = rawLines.slice(start, close).map((raw) => raw.startsWith(prefix) ? raw.slice(prefix.length) : raw).join("\n");
  const parsed = parseDocumentInner(dedented, false, depth);
  const nodes: TugQLSourceNode[] = [];
  return { body: { ...(parsed.document.tree?.definitions === undefined ? {} : { definitions: parsed.document.tree.definitions }), query: parsed.document.tree?.query ?? ({ from: {} }) }, diagnostics: [...diagnostics, ...parsed.diagnostics.map((item) => ({ ...item, span: shiftSpan(item.span, start, prefix.length) }))], nodes };
}

function shiftSpan(span: TugQLSpan, lines: number, columns: number): TugQLSpan {
  const shift = (position: TugQLPosition): TugQLPosition => ({ line: position.line + lines, column: position.column + columns });
  return { start: shift(span.start), end: shift(span.end) };
}

function parseDocumentInner(source: string, allowParameters: boolean, depth: number): TugQLParseResult {
  const lexed = tokenizeTugQL(source);
  const lines = linesFromTokens(source, lexed.tokens);
  const rawLines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const indentation = structuralIndentUnit(lines);
  const keywordDiagnostics = validateKeywordStyle(lexed.tokens);
  const diagnostics = [...lexed.diagnostics, ...indentation.diagnostics];
  const spans: TugQLSourceNode[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.tokens.length === 0) index += 1;
  const parameters: TugQLParameter[] = [];
  if (index < lines.length && keyword(lines[index]!.tokens[0], "parameters")) {
    if (!allowParameters) diagnostics.push(diagnostic("nested_parameters", "PARAMETERS is declared once and shared by nested queries", spanForLine(lines[index]!)));
    const header = lines[index]!;
    if (header.indent !== "") diagnostics.push(diagnostic("indentation", "PARAMETERS must not be indented", spanForLine(header)));
    if (header.tokens.length !== 2 || header.tokens[1]!.text !== "(") diagnostics.push(diagnostic("invalid_parameters", "PARAMETERS must be followed by '(' on its header line", spanForLine(header)));
    else {
      const close = findBlockClose(lines, index + 1, header.indent);
      if (close < 0) diagnostics.push(diagnostic("unclosed_parameters", "PARAMETERS block must close with ')' on its own line", spanForLine(header)));
      else {
        const seen = new Set<string>();
        for (let i = index + 1; i < close; i += 1) {
          const item = lines[i]!;
          if (item.tokens.length === 0) continue;
          try {
            if (item.indent !== header.indent + indentation.unit) throw new Error("parameter declarations must be indented one structural level");
            const parameter = parseParameter(item.tokens);
            const key = parameter.name;
            if (seen.has(key)) throw new Error("parameter is declared more than once");
            seen.add(key); parameters.push(parameter);
            spans.push({ path: `parameters.${parameter.name}`, span: spanForLine(item) });
          } catch (error) { diagnostics.push(diagnostic(errorMessage(error).includes("more than once") ? "duplicate_parameter" : "invalid_parameter", errorMessage(error), spanForLine(item))); }
        }
        spans.push({ path: "parameters", span: spanForLine(header) });
        index = close + 1;
      }
    }
  }
  const definitions: TugQLDefinition[] = [];
  while (index < lines.length) {
    while (index < lines.length && lines[index]!.tokens.length === 0) index += 1;
    if (index >= lines.length || !keyword(lines[index]!.tokens[0], "with")) break;
    if (lines[index]!.indent !== "") diagnostics.push(diagnostic("indentation", "WITH declarations must not be indented", spanForLine(lines[index]!)));
    const parsed = parseDefinition(lines, rawLines, index, depth);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.definition !== undefined) definitions.push(parsed.definition);
    spans.push(...parsed.nodes);
    if (parsed.next <= index) break;
    index = parsed.next;
  }
  const mainSource = rawLines.slice(index).join("\n");
  const queryResult = mainSource.trim().length === 0 ? { diagnostics: [diagnostic("expected_from", "a TugQL document must contain a main FROM query", zeroSpan)], spans: [] as readonly TugQLSourceNode[] } : parseQuery(mainSource);
  diagnostics.push(...queryResult.diagnostics.map((item) => ({ ...item, span: shiftSpan(item.span, index, 0) })));
  spans.push(...queryResult.spans.map((item) => ({ ...item, span: shiftSpan(item.span, index, 0) })));
  const tree = queryResult.query === undefined || diagnostics.length > 0 ? undefined : {
    format: TUGQL_TREE_FORMAT,
    version: TUGQL_VERSION,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(definitions.length === 0 ? {} : { definitions }),
    query: queryResult.query,
  } satisfies TugQLTree;
  if (diagnostics.length === 0) diagnostics.push(...keywordDiagnostics);
  const finalDiagnostics = uniqueDiagnostics(diagnostics);
  if (finalDiagnostics.length === 0 && tree !== undefined && depth === 0) {
    try { preflightTugQLTree(tree); }
    catch (error) {
      if (error instanceof ResolveFailure && (error.code === "document_depth_exceeded" || error.code === "document_node_limit")) {
        let projectionIsTooDeep = false;
        const query = asRecord(queryResult.query);
        const from = { ...(asRecord(query?.from) ?? {}) };
        delete from.joins;
        if (error.code === "document_depth_exceeded" && Array.isArray(query?.columns)) {
          try {
            preflightTugQLTree({ format: TUGQL_TREE_FORMAT, version: TUGQL_VERSION, query: { from, columns: query.columns } });
          } catch (projectionError) {
            projectionIsTooDeep = projectionError instanceof ResolveFailure && projectionError.code === "document_depth_exceeded";
          }
        }
        const rootQuerySpan = spans.find((node) => node.path === "query.from")?.span ?? zeroSpan;
        const rootSelectSpan = spans.find((node) => node.path === "query.select")?.span ?? rootQuerySpan;
        finalDiagnostics.push(projectionIsTooDeep
          ? diagnostic("invalid_select", "expression nesting exceeds 128", rootSelectSpan)
          : diagnostic(error.code, error.message, rootQuerySpan));
      } else throw error;
    }
  }
  const uniqueFinalDiagnostics = uniqueDiagnostics(finalDiagnostics);
  const validTree = uniqueFinalDiagnostics.length === 0 ? tree : undefined;
  const document: TugQLDocument = { source, ...(validTree === undefined ? {} : { tree: validTree }), sourceMetadata: { format: TUGQL_SOURCE_FORMAT, version: TUGQL_VERSION } };
  return { document, diagnostics: uniqueFinalDiagnostics };
}

function uniqueDiagnostics(diagnostics: readonly TugQLDiagnostic[]): TugQLDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = `${item.code}:${item.span.start.line.toString()}:${item.span.start.column.toString()}:${item.span.end.line.toString()}:${item.span.end.column.toString()}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Parses complete TugQL syntax and preserves source plus source-position metadata. */
export function parseTugQL(source: string): TugQLParseResult {
  if (typeof source !== "string") return { document: { source: "", sourceMetadata: { format: TUGQL_SOURCE_FORMAT, version: TUGQL_VERSION } }, diagnostics: [diagnostic("invalid_source", "TugQL source must be text", zeroSpan)] };
  const malformedSurrogate = firstUnpairedSurrogate(source);
  if (malformedSurrogate !== undefined) return { document: { source, sourceMetadata: { format: TUGQL_SOURCE_FORMAT, version: TUGQL_VERSION } }, diagnostics: [malformedSurrogate] };
  return parseDocumentInner(source, true, 0);
}

/** Formats a TugQL source draft, including drafts that currently have diagnostics. */
export function formatTugQL(input: string | TugQLDocument, options: TugQLFormatOptions = {}): TugQLFormatResult {
  const source = typeof input === "string" ? input : input.source;
  if (source === undefined) return { source: "", diagnostics: [diagnostic("source_unavailable", "TugQL formatting requires original source text", zeroSpan)] };
  const lexed = tokenizeTugQL(source);
  if (lexed.tokens.length === 0 && lexed.diagnostics.length > 0) return { source, diagnostics: lexed.diagnostics };
  const keywordCase = resolveKeywordCase(lexed.tokens, options);
  let formatted = rewriteKeywordCase(source, lexed.tokens, keywordCase);
  const sourceWasValid = parseTugQL(source).diagnostics.length === 0;
  formatted = reindentTugQL(formatted, options, lexed.tokens, sourceWasValid);
  const parsed = parseTugQL(formatted);
  return { source: formatted, diagnostics: parsed.diagnostics };
}

/** Resolves a parsed document against explicitly authorized, revision-pinned context. */
export function resolveTugQL(document: TugQLDocument, context: TugQLResolveContext): TugQLResolveResult {
  context = {
    ...context,
    authorizedSchemas: Array.isArray(context.authorizedSchemas) ? context.authorizedSchemas : [],
    relationships: Array.isArray(context.relationships) ? context.relationships : [],
    pinnedImports: Array.isArray(context.pinnedImports) ? context.pinnedImports : [],
    bindings: Array.isArray(context.bindings) ? context.bindings : [],
  };
  const fail = (code: string, message: string): TugQLResolveResult => ({ diagnostics: [diagnostic(code, message, zeroSpan)] });
  try {
    validateKeys(document, ["source", "tree", "sourceMetadata"], "document");
    let parsed: TugQLParseResult | undefined;
    if (document.source !== undefined) {
      if (typeof document.source !== "string") throw new ResolveFailure("invalid_document", "document source must be a string");
      if (document.source.length > 0) {
        parsed = parseTugQL(document.source);
        if (parsed.diagnostics.length > 0) return { diagnostics: parsed.diagnostics };
      }
    }
    if (document.tree === undefined) return fail("missing_tree", "TugQL document has no semantic tree");
    const sourceMetadata = asRecord(document.sourceMetadata);
    if (sourceMetadata === undefined) throw new ResolveFailure("invalid_document", "document source metadata is required");
    validateKeys(sourceMetadata, ["format", "version"], "source metadata");
    if (sourceMetadata.format !== TUGQL_SOURCE_FORMAT || sourceMetadata.version !== TUGQL_VERSION) throw new ResolveFailure("unsupported_version", "unsupported TugQL source format or version");
    const tree = document.tree;
    const authoredNodes = preflightTugQLTree(tree);
    const header = tree as { readonly format: string; readonly version: number };
    if (header.format !== TUGQL_TREE_FORMAT || header.version !== TUGQL_VERSION) return fail("unsupported_version", "unsupported TugQTree format or version");
    validateTugQLTree(tree);
    if (parsed !== undefined && stableJSON(tree) !== stableJSON(parsed.document.tree)) return fail("source_tree_mismatch", "TugQL source and semantic tree do not describe the same query");
    let expandedSemanticNodes = authoredNodes;
    const authoredRootQueryNodes = countTugQLQueryNodes(tree.query, maxSemanticNodes);

    const schemaTables = new Map<string, { readonly schema?: string; readonly database?: string; readonly version: string; readonly fields: Map<string, TugQLTypedField> }>();
    for (const schema of context.authorizedSchemas) for (const table of schema.tables) {
      const key = `${schema.database ?? ""}\0${schema.schema ?? ""}\0${table.name}`;
      if (schemaTables.has(key)) throw new ResolveFailure("ambiguous_schema", `duplicate authorized table ${table.name}`);
      schemaTables.set(key, { ...(schema.schema === undefined ? {} : { schema: schema.schema }), ...(schema.database === undefined ? {} : { database: schema.database }), version: schema.version, fields: new Map(table.fields.filter((field) => field.authorized).map((field) => [field.name, field])) });
    }
    const usedVersions = new Set<string>();
    const dependencies = new Map<string, TugQLDependencyReceipt>();
    const relationshipReceipts: TugQLResolved["relationships"][number][] = [];
    const parameterValues = resolveParameters(tree.parameters ?? [], context.bindings ?? []);
    validateParameterSemantics(tree.parameters ?? []);
    let expandedImportDocuments = 0;

    const lowerBody = (body: TugQLBody, inherited: ReadonlyMap<string, TugQLBody>, bindings: ReadonlyMap<string, unknown>, stack: readonly string[], currentPath = context.importingPath ?? "", outerForwardNames: ReadonlySet<string> = new Set()): TugQLBody => {
      const visible = new Map(inherited);
      const loweredDefinitions: TugQLDefinition[] = [];
      const definitions = body.definitions ?? [];
      for (let definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
        const definition = definitions[definitionIndex]!;
        if (visible.has(definition.name)) throw new ResolveFailure("duplicate_definition", `WITH definition is duplicated: ${definition.name}`);
        const forwardNames = new Set([...outerForwardNames, ...definitions.slice(definitionIndex).map((later) => later.name)]);
        if (definition.kind === "cte") {
          const nested = lowerBody(definition.query, visible, bindings, stack, currentPath, forwardNames);
          visible.set(definition.name, nested);
          loweredDefinitions.push({ kind: "cte", name: definition.name, query: nested });
        } else {
          requireImportContext(context);
          const normalized = normalizeImportPath(currentPath, definition.path);
          if (!isProjectRelativePath(normalized)) throw new ResolveFailure("import_outside_project", "saved-query import must remain inside the project root");
          const matchingPins = context.pinnedImports.filter((item) => item.path === normalized);
          if (matchingPins.length > 1) throw new ResolveFailure("duplicate_pinned_import", `pinned import path appears more than once: ${normalized}`);
          const pinned = matchingPins[0];
          if (pinned === undefined || pinned.revision !== context.projectRevision) throw new ResolveFailure("unpinned_import", `saved-query import is not pinned to the active project revision: ${normalized}`);
          const receipt = { path: normalized, revision: pinned.revision };
          dependencies.set(normalized, receipt);
          if (stack.includes(normalized)) throw new ResolveFailure("import_cycle", `saved-query import cycle includes: ${normalized}`);
          expandedImportDocuments += 1;
          if (expandedImportDocuments > maxExpandedImports) throw new ResolveFailure("import_expansion_limit", "saved-query imports exceed 128 expanded documents");
          const imported = parseTugQL(pinned.source);
          if (imported.diagnostics.length > 0 || imported.document.tree === undefined) {
            if (imported.diagnostics.length > 0) {
              const first = imported.diagnostics[0]!;
              throw new ResolveFailure(first.code, first.message, [first]);
            }
            throw new ResolveFailure("invalid_import", `import ${normalized} is not a valid TugQL document`);
          }
          const importedTree = imported.document.tree;
          const importedNodes = preflightTugQLTree(importedTree);
          expandedSemanticNodes = chargeSemanticNodes(expandedSemanticNodes, importedNodes);
          validateParameterSemantics(importedTree.parameters ?? []);
          const mappings = new Map<string, Readonly<Record<string, unknown>>>();
          for (const mapping of definition.using ?? []) {
            if (mappings.has(mapping.name)) throw new ResolveFailure("duplicate_import_mapping", `import parameter mapping appears more than once: @${mapping.name}`);
            mappings.set(mapping.name, mapping.expression);
          }
          const expected = importedTree.parameters ?? [];
          const replacements = new Map<string, Readonly<Record<string, unknown>>>();
          for (const parameter of expected) {
            const mapping = mappings.get(parameter.name);
            if (mapping === undefined) {
              if (parameter.required === true) throw new ResolveFailure("missing_import_mapping", `required saved-query parameter has no USING mapping: @${parameter.name}`);
              replacements.set(parameter.name, { value: Object.prototype.hasOwnProperty.call(parameter, "default") ? parameter.default : null });
              continue;
            }
            const resolvedMapping = substituteExpression(mapping, parameterValues);
            validateMappingType(resolvedMapping, parameter);
            replacements.set(parameter.name, resolvedMapping as Readonly<Record<string, unknown>>);
          }
          const unknownMapping = [...mappings.keys()].find((name) => !expected.some((parameter) => parameter.name === name));
          if (unknownMapping !== undefined) throw new ResolveFailure("unknown_import_parameter", `saved query has no parameter @${unknownMapping}`);
          const substituted = substituteTreeParameters(importedTree, replacements);
          const importedBody: TugQLBody = { ...(substituted.definitions === undefined ? {} : { definitions: substituted.definitions }), query: substituted.query };
          const loweredImportedBody = lowerBody(importedBody, new Map(), bindings, [...stack, normalized], normalized);
          visible.set(definition.name, loweredImportedBody);
          loweredDefinitions.push({ kind: "cte", name: definition.name, query: loweredImportedBody });
        }
      }
      preflightExpandedQueryBudget(body.query, visible);
      const loweredQuery = lowerQuery(body.query, visible, bindings, outerForwardNames, currentPath, stack);
      const loweredBody: TugQLBody = {
        ...(loweredDefinitions.length === 0 ? {} : { definitions: loweredDefinitions }),
        query: loweredQuery,
      };
      // Every expanded body is independently bounded before its caller can
      // copy or recursively consume it. This also catches unused definitions
      // because lowerBody resolves declarations in lexical order.
      preflightTugQLTree({ format: TUGQL_TREE_FORMAT, version: TUGQL_VERSION, query: loweredBody.query }, true);
      return loweredBody;
    };

    const lowerQuery = (input: TugQLQueryDocument, visible: ReadonlyMap<string, TugQLBody>, bindings: ReadonlyMap<string, unknown>, forwardNames: ReadonlySet<string> = new Set(), currentPath = context.importingPath ?? "", stack: readonly string[] = []): TugQLQueryDocument => {
      const cloned = structuredClone(input) as Record<string, unknown>;
      const from = cloned.from as Record<string, unknown>;
      const relation = (raw: Record<string, unknown>): Record<string, unknown> => {
        if (asRecord(raw.query) !== undefined && typeof raw.name !== "string") return structuredClone(raw);
        const name = stringField(raw, "name");
        const database = typeof raw.database === "string" ? raw.database : undefined;
        const schema = typeof raw.schema === "string" ? raw.schema : undefined;
        const key = `${database ?? ""}\0${schema ?? ""}\0${name}`;
        const cte = visible.get(name);
        if (cte !== undefined) {
          const nested = lowerBody(cte, visible, bindings, stack, currentPath, forwardNames);
          const alias = stringField(raw, "alias") || name;
          const joins = raw.joins;
          return { query: { ...nested.query, as: alias }, ...(joins === undefined ? {} : { joins }) };
        }
        if (forwardNames.has(name)) throw new ResolveFailure("forward_cte_reference", `CTEs may reference only earlier definitions: ${name}`);
        const table = schemaTables.get(key) ?? [...schemaTables.entries()].find(([candidateKey, item]) => item.fields.size > 0 && item.schema === schema && item.database === database && candidateKey.endsWith(`\0${name}`))?.[1];
        if (table === undefined) throw new ResolveFailure("unauthorized_source", `source is not present in authorized schemas: ${name}`);
        usedVersions.add(table.version);
        const rawJoins = Array.isArray(raw.joins) ? raw.joins as Record<string, unknown>[] : [];
        const leftRelations: { readonly table: string; readonly source: string; readonly database?: string; readonly schema?: string }[] = [{
          table: name,
          source: stringField(raw, "alias") || name,
          ...(database === undefined ? {} : { database }),
          ...(schema === undefined ? {} : { schema }),
        }];
        const validateRelationshipFields = (relationship: TugQLRelationship, leftRelation: { readonly table: string; readonly source: string; readonly database?: string; readonly schema?: string }, joinedFrom: Record<string, unknown>, reversed = false): void => {
          const leftSchema = schemaTables.get(`${leftRelation.database ?? ""}\0${leftRelation.schema ?? ""}\0${leftRelation.table}`);
          const rightDatabase = typeof joinedFrom.database === "string" ? joinedFrom.database : "";
          const rightSchemaName = typeof joinedFrom.schema === "string" ? joinedFrom.schema : "";
          const rightTable = stringField(joinedFrom, "name");
          const rightSchema = schemaTables.get(`${rightDatabase}\0${rightSchemaName}\0${rightTable}`);
          for (const pair of relationship.pairs) {
            const leftType = leftSchema?.fields.get(reversed ? pair.toField : pair.fromField)?.type;
            const rightType = rightSchema?.fields.get(reversed ? pair.fromField : pair.toField)?.type;
            if (leftType === undefined || rightType === undefined || leftType !== rightType) throw new ResolveFailure("unauthorized_relationship", "relationship field pairs are not authorized with exact matching types");
          }
        };
        const joins: Record<string, unknown>[] = [];
        for (const join of rawJoins) {
          const joinedFrom = join.from as Record<string, unknown>;
          const rightSource = stringField(joinedFrom, "alias") || stringField(joinedFrom, "name");
          const joinType = typeof join.type === "string" && join.type.toLowerCase() === "left" ? "left" : "inner";
          let predicates: Record<string, unknown>[];
          if (Array.isArray(join.on) && join.on.length > 0) {
            if (join.on.length === 1 && (join.on[0] as Record<string, unknown>).op === "relationship") {
              const shorthand = (join.on[0] as Record<string, unknown>).left;
              if (!isFieldNode(shorthand)) throw new ResolveFailure("invalid_join_condition", "relationship shorthand requires one field reference");
              const candidates = context.relationships.flatMap((candidate) => {
                return leftRelations.flatMap((leftRelation) => {
                  const reversed = relationshipIsReversed(candidate, leftRelation.table, stringField(joinedFrom, "name"), leftRelation.source, rightSource);
                  if (!candidate.exactTypedEquality || reversed === undefined) return [];
                  const pair = candidate.pairs.find((item) => reversed
                    ? (item.toField === shorthand.field && (shorthand.source === undefined || shorthand.source === leftRelation.source)) || (item.fromField === shorthand.field && (shorthand.source === undefined || shorthand.source === rightSource))
                    : (item.fromField === shorthand.field && (shorthand.source === undefined || shorthand.source === leftRelation.source)) || (item.toField === shorthand.field && (shorthand.source === undefined || shorthand.source === rightSource)));
                  return pair === undefined ? [] : [{ candidate, pair, reversed, leftRelation }];
                });
              });
              if (candidates.length !== 1) throw new ResolveFailure("relationship_required", candidates.length === 0 ? "ON shorthand does not identify an authorized relationship" : "ON shorthand matches multiple authorized relationships");
              const match = candidates[0]!;
              validateRelationshipFields(match.candidate, match.leftRelation, joinedFrom, match.reversed);
              predicates = match.candidate.pairs.map((pair) => ({
                left: { field: pair.fromField, source: match.reversed ? rightSource : match.leftRelation.source },
                op: "==",
                right: { field: pair.toField, source: match.reversed ? match.leftRelation.source : rightSource },
              }));
              relationshipReceipts.push({ id: match.candidate.id, version: match.candidate.version, fromSource: match.reversed ? rightSource : match.leftRelation.source, toSource: match.reversed ? match.leftRelation.source : rightSource, joinType, pairs: match.candidate.pairs });
            } else {
              predicates = join.on.flatMap((item) => flattenConditions(item as Record<string, unknown>)).map((item) => {
                if (item.op !== "==" || !isFieldNode(item.left) || !isFieldNode(item.right)) throw new ResolveFailure("invalid_join_condition", "JOIN ON must contain field-to-field equality comparisons");
                return { left: fieldToRecursive(item.left), op: "==", right: fieldToRecursive(item.right) };
              });
              const relationMatches = context.relationships.flatMap((candidate) => {
                return leftRelations.flatMap((leftRelation) => {
                  const reversed = relationshipIsReversed(candidate, leftRelation.table, stringField(joinedFrom, "name"), leftRelation.source, rightSource);
                  return candidate.exactTypedEquality && reversed !== undefined && relationshipPredicatesMatch(predicates, candidate, leftRelation.source, rightSource, reversed)
                    ? [{ candidate, reversed, leftRelation }] : [];
                });
              });
              if (relationMatches.length === 1) {
                const { candidate, reversed, leftRelation } = relationMatches[0]!;
                try {
                  validateRelationshipFields(candidate, leftRelation, joinedFrom, reversed);
                  relationshipReceipts.push({ id: candidate.id, version: candidate.version, fromSource: reversed ? rightSource : leftRelation.source, toSource: reversed ? leftRelation.source : rightSource, joinType, pairs: candidate.pairs });
                } catch (error) {
                  if (!(error instanceof ResolveFailure)) throw error;
                }
              }
            }
          } else {
            const candidates = context.relationships.flatMap((candidate) => {
              return leftRelations.flatMap((leftRelation) => {
                const reversed = relationshipIsReversed(candidate, leftRelation.table, stringField(joinedFrom, "name"), leftRelation.source, rightSource);
                return candidate.exactTypedEquality && reversed !== undefined ? [{ candidate, reversed, leftRelation }] : [];
              });
            });
            if (candidates.length > 1) throw new ResolveFailure("ambiguous_relationship", "more than one authorized exact relationship connects the joined sources");
            if (candidates.length === 0) throw new ResolveFailure("relationship_not_found", "no authorized exact relationship connects the joined sources");
            const { candidate: chosen, reversed, leftRelation } = candidates[0]!;
            validateRelationshipFields(chosen, leftRelation, joinedFrom, reversed);
            relationshipReceipts.push({ id: chosen.id, version: chosen.version, fromSource: reversed ? rightSource : leftRelation.source, toSource: reversed ? leftRelation.source : rightSource, joinType, pairs: chosen.pairs });
            predicates = chosen.pairs.map((pair) => ({
              left: { field: pair.fromField, source: reversed ? rightSource : leftRelation.source },
              op: "==",
              right: { field: pair.toField, source: reversed ? leftRelation.source : rightSource },
            }));
          }
          const joinRelation = relation(joinedFrom);
          const loweredPredicates = predicates.map((predicate) => ({ left: substituteExpression(predicate.left, bindings), op: "==", right: substituteExpression(predicate.right, bindings) }));
          leftRelations.push({ table: stringField(joinedFrom, "name"), source: rightSource, ...(typeof joinedFrom.database === "string" ? { database: joinedFrom.database } : {}), ...(typeof joinedFrom.schema === "string" ? { schema: joinedFrom.schema } : {}) });
          joins.push({ ...(join.type === undefined ? {} : { type: join.type }), from: joinRelation, on: loweredPredicates });
          // Bound composition as each joined body is inserted. Each component
          // was preflighted independently before it was copied here.
          countTugQLQueryNodes({ name, ...(schema === undefined ? {} : { schema }), joins }, maxSemanticNodes);
        }
        return { ...(schema === undefined ? {} : { schema }), name, ...(typeof raw.alias === "string" ? { alias: raw.alias } : {}), ...(joins.length === 0 ? {} : { joins }) };
      };
      cloned.from = relation(from);
      preflightTugQLTree({ format: TUGQL_TREE_FORMAT, version: TUGQL_VERSION, query: cloned as unknown as TugQLQueryDocument }, true);
      if (!Array.isArray(cloned.columns)) {
        const visibleDefinitions: TugQLDefinition[] = [...visible].map(([name, body]) => ({ kind: "cte", name, query: body }));
        const projected = inferOutputColumns(input, visibleDefinitions, schemaTables, context.relationships);
        cloned.columns = projected.map((column) => {
          const projection = column.projection ?? column.lineage[0]!;
          return { field: projection.field, source: projection.source, as: column.name, __lineage: column.lineage };
        });
      }
      const nestedExpanded = lowerNestedScalarQueries(cloned, visible, bindings, currentPath, stack, forwardNames) as TugQLQueryDocument;
      preflightTugQLTree({ format: TUGQL_TREE_FORMAT, version: TUGQL_VERSION, query: nestedExpanded }, true);
      const lowered = substituteParametersInQuery(normalizeEngineAggregateNames(nestedExpanded) as TugQLQueryDocument, bindings);
      return lowered;
    };

    const lowerNestedScalarQueries = (value: unknown, visible: ReadonlyMap<string, TugQLBody>, bindings: ReadonlyMap<string, unknown>, currentPath: string, stack: readonly string[], forwardNames: ReadonlySet<string>): unknown => {
      if (Array.isArray(value)) {
        const lowered: unknown[] = [];
        for (const item of value) {
          lowered.push(lowerNestedScalarQueries(item, visible, bindings, currentPath, stack, forwardNames));
          countTugQLQueryNodes(lowered, maxSemanticNodes);
        }
        return lowered;
      }
      if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const key of ["exists", "notExists"]) {
          const wrapper = asRecord(record[key]);
          const nestedQuery = asRecord(wrapper?.query);
          if (wrapper !== undefined && nestedQuery?.from !== undefined) {
            const nestedBody: TugQLBody = {
              ...(Array.isArray(wrapper.definitions) ? { definitions: wrapper.definitions as TugQLDefinition[] } : {}),
              query: nestedQuery as TugQLQueryDocument,
            };
            const lowered = lowerBody(nestedBody, visible, bindings, stack, currentPath, forwardNames);
            return { ...record, [key]: { query: lowered.query } };
          }
        }
        const nestedBody = asRecord(record.query);
        if (nestedBody !== undefined && asRecord(nestedBody.query) !== undefined) {
          const nestedQuery = nestedBody.query as TugQLQueryDocument;
          const body: TugQLBody = { ...(Array.isArray(nestedBody.definitions) ? { definitions: nestedBody.definitions as TugQLDefinition[] } : {}), query: nestedQuery };
          const lowered = lowerBody(body, visible, bindings, stack, currentPath, forwardNames);
          const alias = optionalStringField(record, "as") ?? optionalStringField(nestedQuery, "as");
          return { query: alias === undefined ? lowered.query : { ...lowered.query, as: alias } };
        }
        const lowered: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(record)) {
          lowered[key] = lowerNestedScalarQueries(item, visible, bindings, currentPath, stack, forwardNames);
          countTugQLQueryNodes(lowered, maxSemanticNodes);
        }
        return lowered;
      }
      return value;
    };

    const loweredRootBody = lowerBody({ ...(tree.definitions === undefined ? {} : { definitions: tree.definitions }), query: tree.query }, new Map(), parameterValues, [], context.importingPath);
    const finalExpandedRootQueryNodes = countTugQLQueryNodes(loweredRootBody.query, maxSemanticNodes);
    expandedSemanticNodes = chargeSemanticNodes(expandedSemanticNodes, Math.max(0, finalExpandedRootQueryNodes - authoredRootQueryNodes));
    preflightTugQLTree({ format: TUGQL_TREE_FORMAT, version: TUGQL_VERSION, query: loweredRootBody.query }, true);
    const rootDefinitions = loweredRootBody.definitions ?? [];
    validateSafeOperations(loweredRootBody.query, rootDefinitions, schemaTables, context.relationships);
    const validateDefinition = (definition: TugQLDefinition): void => {
      if (definition.kind !== "cte") return;
      const nested = definition.query.definitions ?? [];
      validateSafeOperations(definition.query.query, nested, schemaTables, context.relationships);
      for (const child of nested) validateDefinition(child);
    };
    for (const definition of rootDefinitions) validateDefinition(definition);
    const inferredColumns = inferOutputColumns(loweredRootBody.query, [], schemaTables, context.relationships);
    const recursiveDoc = stripInternalLineage(loweredRootBody.query) as TugQLQueryDocument;
    const schemas: DTQLSchema = { tables: [...schemaTables.entries()].map(([key, table]) => ({ ...(table.schema === undefined ? {} : { schema: table.schema }), name: key.split("\0").at(-1) ?? "", fields: [...table.fields.keys()] })) };
    const unsupportedFunction = findFunctionCall(recursiveDoc);
    if (unsupportedFunction !== undefined) throw new ResolveFailure("unsupported_function", `unsupported_function: scalar function ${JSON.stringify(unsupportedFunction)} is not executable by DALgo`);
    if (containsBareStar(recursiveDoc)) throw new ResolveFailure("unsupported_projection", "wildcard projection cannot be resolved to a stable typed output");
    let recursive: RecursiveDTQLQuery;
    try {
      recursive = parseRecursiveDTQL(recursiveDoc, schemas);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const duplicateOutput = /duplicate output field ([^\s]+)/u.exec(message);
      if (duplicateOutput !== null) throw new ResolveFailure("duplicate_output_name", `output column name is duplicated: ${duplicateOutput[1] ?? ""}`);
      const unknown = /unknown field ([^\s]+)/.exec(message);
      if (unknown !== null) throw new ResolveFailure("unauthorized_field", `field is unavailable or unauthorized: ${unknown[1] ?? "unknown"}`);
      const unknownAlias = /unknown source alias ([^\s]+)/.exec(message);
      if (unknownAlias !== null) {
        const field = findFieldForSource(recursiveDoc, unknownAlias[1]!) ?? "unknown";
        throw new ResolveFailure("unauthorized_field", `field is unavailable or unauthorized: ${field}`);
      }
      if (message.includes("scalar query requires exactly one column")) throw new ResolveFailure("scalar_column_count", "scalar subqueries must return exactly one column");
      throw error;
    }
    // Infer metadata from the validated, fully expanded executable tree so
    // imported and nested local definitions have the same resolved scope as
    // execution (including scalar-query lineage).
    const columns = inferredColumns.map(({ name, type, lineage }) => ({ name, type, lineage: lineage.length === 0 ? null : lineage }));
    return { resolved: { query: recursive, columns, schemaVersion: [...usedVersions].sort().join(","), dependencies: [...dependencies.values()], relationships: uniqueTugQLRelationshipReceipts(relationshipReceipts) }, diagnostics: [] };
  } catch (error) {
    if (error instanceof ResolveFailure) return error.diagnostics === undefined ? fail(error.code, error.message) : { diagnostics: [...error.diagnostics] };
    return fail("resolution_error", error instanceof Error ? error.message : String(error));
  }
}

function uniqueTugQLRelationshipReceipts(receipts: readonly TugQLResolved["relationships"][number][]): TugQLResolved["relationships"][number][] {
  const seen = new Set<string>();
  const unique: TugQLResolved["relationships"][number][] = [];
  for (const receipt of receipts) {
    const identity = JSON.stringify([
      receipt.id,
      receipt.version,
      receipt.fromSource,
      receipt.toSource,
      receipt.joinType,
      receipt.pairs.map(({ fromField, toField }) => [fromField, toField]),
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(receipt);
  }
  return unique;
}

function findFieldForSource(value: unknown, source: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findFieldForSource(item, source);
      if (result !== undefined) return result;
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.source === source && typeof record.field === "string") return record.field;
    for (const item of Object.values(record)) {
      const result = findFieldForSource(item, source);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

class ResolveFailure extends Error {
  public constructor(public readonly code: string, message: string, public readonly diagnostics?: readonly TugQLDiagnostic[]) { super(message); }
}

function requireImportContext(context: TugQLResolveContext): void {
  if (typeof context.projectRoot !== "string" || context.projectRoot.length === 0
    || typeof context.importingPath !== "string" || context.importingPath.length === 0
    || typeof context.projectRevision !== "string" || context.projectRevision.length === 0) {
    throw new ResolveFailure("import_context_required", "imports require projectRoot, importingPath, and projectRevision");
  }
  if (!isNormalizedProjectRelativePath(context.importingPath)) {
    throw new ResolveFailure("invalid_importing_path", "importingPath must be a normalized project-relative path");
  }
}

function validateTugQLTree(tree: TugQLTree): void {
  validateKeys(tree, ["format", "version", "parameters", "definitions", "query"], "tree");
  if (!Array.isArray(tree.parameters ?? [])) invalidTree("parameters must be an array");
  for (const parameter of tree.parameters ?? []) {
    validateKeys(parameter, ["name", "type", "required", "default"], "parameter");
    if (typeof parameter.name !== "string" || typeof parameter.type !== "string") invalidTree("parameter name and type must be strings");
  }
  validateDefinitions(tree.definitions ?? []);
  validateQuery(tree.query);
}

function preflightTugQLTree(tree: TugQLTree, ignoreInternalLineage = false): number {
  const pending: { readonly value: unknown; readonly depth: number; readonly kind: "generic" | "parameter" | "definition" | "body" }[] = [];
  let nodes = 0;
  const enqueue = (value: unknown, depth: number, kind: "generic" | "parameter" | "definition" | "body" = "generic"): void => {
    if (value === undefined) return;
    if (depth > maxSemanticDepth) throw new ResolveFailure("document_depth_exceeded", "TugQL semantic tree depth exceeds 128");
    if (nodes + pending.length + 1 > maxSemanticNodes) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
    pending.push({ value, depth, kind });
  };
  enqueue(tree.query, 0);
  for (const parameter of tree.parameters ?? []) enqueue(parameter, 0, "parameter");
  for (const definition of tree.definitions ?? []) enqueue(definition, 0, "definition");
  while (pending.length > 0) {
    const current = pending.pop()!;
    const value = current.value;
    nodes += 1;
    if (nodes > maxSemanticNodes) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
    if (current.kind === "parameter") {
      const parameter = asRecord(value);
      if (parameter !== undefined && Object.prototype.hasOwnProperty.call(parameter, "default")) enqueue(parameter.default, current.depth + 1);
      continue;
    }
    if (current.kind === "definition") {
      const definition = asRecord(value);
      if (definition === undefined) continue;
      if (definition.kind === "cte") enqueue(definition.query, current.depth, "body");
      else if (definition.kind === "import" && Array.isArray(definition.using)) {
        for (const mapping of definition.using) {
          const record = asRecord(mapping);
          if (record !== undefined) enqueue(record.expression, current.depth + 1);
        }
      }
      continue;
    }
    if (current.kind === "body") {
      const body = asRecord(value);
      if (body === undefined) continue;
      enqueue(body.query, current.depth);
      if (Array.isArray(body.definitions)) for (const definition of body.definitions) enqueue(definition, current.depth + 1, "definition");
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) enqueue(item, current.depth + 1);
      continue;
    }
    const record = asRecord(value);
    if (record === undefined) continue;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || (ignoreInternalLineage && key === "__lineage")) continue;
      enqueue(record[key], current.depth + 1);
    }
  }
  return nodes;
}

function chargeSemanticNodes(current: number, additional: number): number {
  const total = current + additional;
  if (total > maxSemanticNodes) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
  return total;
}

function countTugQLQueryNodes(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes + pending.length > limit) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
    if (Array.isArray(current)) {
      for (const item of current) {
        if (nodes + pending.length + 1 > limit) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
        pending.push(item);
      }
      continue;
    }
    const record = asRecord(current);
    if (record === undefined) continue;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || key === "__lineage") continue;
      if (nodes + pending.length + 1 > limit) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
      pending.push(record[key]);
    }
  }
  return nodes;
}

function preflightExpandedQueryBudget(query: TugQLQueryDocument, visible: ReadonlyMap<string, TugQLBody>): void {
  const active = new Set<TugQLBody>();
  const measureQuery = (candidate: TugQLQueryDocument, definitions: ReadonlyMap<string, TugQLBody>): number => {
    let nodes = countTugQLQueryNodes(candidate, maxSemanticNodes);
    const from = asRecord(candidate.from);
    if (from !== undefined) nodes += measureRelationExpansion(from, definitions) - countTugQLQueryNodes(from, maxSemanticNodes);
    if (nodes > maxSemanticNodes) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
    return nodes;
  };
  const measureBody = (body: TugQLBody, inherited: ReadonlyMap<string, TugQLBody>): number => {
    if (active.has(body)) return countTugQLQueryNodes(body.query, maxSemanticNodes);
    active.add(body);
    const definitions = new Map(inherited);
    for (const definition of body.definitions ?? []) if (definition.kind === "cte") definitions.set(definition.name, definition.query);
    const nodes = measureQuery(body.query, definitions);
    active.delete(body);
    return nodes;
  };
  const measureRelationExpansion = (relation: Readonly<Record<string, unknown>>, definitions: ReadonlyMap<string, TugQLBody>): number => {
    let nodes = countTugQLQueryNodes(relation, maxSemanticNodes);
    const nestedQuery = asRecord(relation.query);
    const nestedFrom = asRecord(nestedQuery?.from);
    if (nestedFrom !== undefined) nodes += measureRelationExpansion(nestedFrom, definitions) - countTugQLQueryNodes(nestedFrom, maxSemanticNodes);
    const name = optionalStringField(relation, "name");
    const body = name === undefined ? undefined : definitions.get(name);
    if (body !== undefined && !active.has(body)) {
      const base = { name, ...(typeof relation.database === "string" ? { database: relation.database } : {}), ...(typeof relation.schema === "string" ? { schema: relation.schema } : {}), ...(typeof relation.alias === "string" ? { alias: relation.alias } : {}) };
      // The expanded source replaces its authored name/schema/alias fields
      // with a query wrapper, the query itself, and one output alias.
      nodes += 2 + measureBody(body, definitions) - countTugQLQueryNodes(base, maxSemanticNodes);
    }
    for (const join of joinRecords(Array.isArray(relation.joins) ? relation.joins : [])) {
      const joinedFrom = asRecord(join.from);
      if (joinedFrom !== undefined) nodes += measureRelationExpansion(joinedFrom, definitions) - countTugQLQueryNodes(joinedFrom, maxSemanticNodes);
    }
    if (nodes > maxSemanticNodes) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
    return nodes;
  };
  const expanded = measureQuery(query, visible);
  if (expanded > maxSemanticNodes) throw new ResolveFailure("document_node_limit", "TugQL semantic tree exceeds 5000 nodes");
}

function joinRecords(values: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] {
  return values.map(asRecord).filter((value): value is Readonly<Record<string, unknown>> => value !== undefined);
}

function validateBody(body: TugQLBody): void {
  validateKeys(body, ["definitions", "query"], "query body");
  validateDefinitions(body.definitions ?? []);
  validateQuery(body.query);
}

function validateDefinitions(definitions: readonly TugQLDefinition[]): void {
  if (!Array.isArray(definitions)) invalidTree("definitions must be an array");
  for (const candidate of definitions as readonly unknown[]) {
    const definition = asRecord(candidate);
    if (definition === undefined) invalidTree("definition must be an object");
    if (definition.kind === "cte") {
      validateKeys(definition, ["kind", "name", "query"], "definition");
      if (typeof definition.name !== "string") invalidTree("definition name must be a string");
      validateBody(definition.query as TugQLBody);
    } else if (definition.kind === "import") {
      validateKeys(definition, ["kind", "name", "path", "using"], "definition");
      if (typeof definition.name !== "string" || typeof definition.path !== "string") invalidTree("import name and path must be strings");
      const mappings = definition.using;
      if (mappings !== undefined && !Array.isArray(mappings)) invalidTree("import mappings must be an array");
      for (const mapping of (mappings ?? []) as readonly unknown[]) {
        const mappingRecord = asRecord(mapping);
        if (mappingRecord === undefined) invalidTree("import mapping must be an object");
        validateKeys(mappingRecord, ["name", "expression"], "import mapping");
        if (typeof mappingRecord.name !== "string") invalidTree("import mapping name must be a string");
        validateExpression(mappingRecord.expression);
      }
    } else invalidTree("definition kind must be cte or import");
  }
}

function validateQuery(query: TugQLQueryDocument, derived = false): void {
  validateKeys(query, ["from", "where", "groupBy", "having", "orderBy", "limit", "offset", "columns", ...(derived ? ["as"] : [])], "query");
  if (derived && query.as !== undefined && typeof query.as !== "string") invalidTree("derived query alias must be a string");
  validateRelation(query.from);
  if (query.where !== undefined) validateCondition(query.where);
  if (query.groupBy !== undefined) for (const expression of query.groupBy as readonly Readonly<Record<string, unknown>>[]) validateExpression(expression);
  if (query.having !== undefined) validateCondition(query.having);
  if (query.orderBy !== undefined) for (const order of query.orderBy as readonly Readonly<Record<string, unknown>>[]) validateExpression(order, true);
  if (query.columns !== undefined) for (const column of query.columns as readonly Readonly<Record<string, unknown>>[]) validateExpression(column, true);
}

function validateRelation(relation: Readonly<Record<string, unknown>>): void {
  validateKeys(relation, ["name", "database", "schema", "alias", "joins", "query"], "source");
  if (relation.query !== undefined) {
    const nested = asRecord(relation.query);
    if (nested === undefined) invalidTree("derived query must be an object");
    validateQuery(nested as TugQLQueryDocument, true);
  } else if (typeof relation.name !== "string") invalidTree("source name must be a string");
  if (relation.joins !== undefined) {
    if (!Array.isArray(relation.joins)) invalidTree("joins must be an array");
    for (const join of relation.joins as readonly Readonly<Record<string, unknown>>[]) {
      validateKeys(join, ["type", "from", "on"], "join");
      validateRelation(join.from as Readonly<Record<string, unknown>>);
      if (join.on !== undefined) {
        if (!Array.isArray(join.on)) invalidTree("join predicates must be an array");
        for (const condition of join.on as readonly Readonly<Record<string, unknown>>[]) validateCondition(condition);
      }
    }
  }
}

function validateCondition(value: unknown): void {
  const condition = asRecord(value);
  if (condition === undefined) invalidTree("condition must be an object");
  if (condition.and !== undefined || condition.or !== undefined) {
    const key = condition.and !== undefined ? "and" : "or";
    validateKeys(condition, [key], "condition");
    const children = condition[key];
    if (!Array.isArray(children)) invalidTree(`${key} condition must be an array`);
    for (const child of children as readonly Readonly<Record<string, unknown>>[]) validateCondition(child);
    return;
  }
  if (condition.isNull !== undefined || condition.isNotNull !== undefined) {
    const key = condition.isNull !== undefined ? "isNull" : "isNotNull";
    validateKeys(condition, [key], "condition");
    validateExpression(condition[key]);
    return;
  }
  if (condition.exists !== undefined || condition.notExists !== undefined) {
    const key = condition.exists !== undefined ? "exists" : "notExists";
    validateKeys(condition, [key], "condition");
    const body = condition[key] as TugQLBody;
    if (asRecord(body)?.definitions !== undefined) {
      invalidTree("invalid TugQTree query: yaml: unmarshal errors:\n  line 9: field definitions not found in type dtql.existsYAML");
    }
    validateKeys(body, ["query"], "EXISTS query body");
    validateQuery(body.query);
    return;
  }
  if (typeof condition.op === "string") {
    if (condition.op === "relationship") {
      validateKeys(condition, ["op", "left"], "condition");
      validateExpression(condition.left);
    } else {
      validateKeys(condition, ["op", "left", "right"], "condition");
      validateExpression(condition.left);
      validateExpression(condition.right);
    }
    return;
  }
  invalidTree("condition has no recognized discriminator");
}

function validateExpression(value: unknown, allowOrder = false): void {
  const expression = asRecord(value);
  if (expression === undefined) invalidTree("expression must be an object");
  const allowedSuffix = allowOrder ? ["as", "desc"] : ["as"];
  if (typeof expression.field === "string") { validateKeys(expression, ["field", "source", ...allowedSuffix], "field expression"); return; }
  if (Object.prototype.hasOwnProperty.call(expression, "value")) { validateKeys(expression, ["value", ...allowedSuffix], "literal expression"); return; }
  if (Object.prototype.hasOwnProperty.call(expression, "values")) { validateKeys(expression, ["values", ...allowedSuffix], "values expression"); return; }
  if (typeof expression.param === "string") { validateKeys(expression, ["param", ...allowedSuffix], "parameter expression"); return; }
  if (Object.prototype.hasOwnProperty.call(expression, "star")) { validateKeys(expression, ["star", ...allowedSuffix], "wildcard expression"); return; }
  if (expression.binary !== undefined) {
    validateKeys(expression, ["binary", ...allowedSuffix], "binary expression");
    const binary = expression.binary as Readonly<Record<string, unknown>>;
    validateKeys(binary, ["op", "left", "right"], "binary expression");
    validateExpression(binary.left);
    validateExpression(binary.right);
    return;
  }
  if (expression.aggregate !== undefined) {
    validateKeys(expression, ["aggregate", ...allowedSuffix], "aggregate expression");
    const aggregate = expression.aggregate as Readonly<Record<string, unknown>>;
    validateKeys(aggregate, ["function", "args", "distinct", "orderBy"], "aggregate");
    if (Array.isArray(aggregate.args)) for (const argument of aggregate.args as readonly Readonly<Record<string, unknown>>[]) validateExpression(argument);
    if (Array.isArray(aggregate.orderBy)) for (const order of aggregate.orderBy as readonly Readonly<Record<string, unknown>>[]) validateExpression(order, true);
    return;
  }
  if (expression.call !== undefined) {
    validateKeys(expression, ["call", ...allowedSuffix], "call expression");
    const call = expression.call as Readonly<Record<string, unknown>>;
    validateKeys(call, ["function", "args"], "call");
    if (Array.isArray(call.args)) for (const argument of call.args as readonly Readonly<Record<string, unknown>>[]) validateExpression(argument);
    return;
  }
  if (expression.query !== undefined) {
    validateKeys(expression, ["query", ...allowedSuffix], "scalar expression");
    validateBody(expression.query as TugQLBody);
    return;
  }
  invalidTree("expression has no recognized discriminator");
}

function validateKeys(value: unknown, allowed: readonly string[], kind: string): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidTree(`${kind} must be an object`);
  const record = value as Record<string, unknown>;
  const known = new Set(allowed);
  for (const key of Object.keys(record)) if (!known.has(key)) {
    if (kind === "source") invalidTree(`invalid TugQTree query: yaml: unmarshal errors:\n  field ${key} not found in from`);
    invalidTree(`unknown field ${JSON.stringify(key)} in ${kind}`);
  }
}

function invalidTree(message: string): never {
  throw new ResolveFailure("invalid_tree", message);
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSON((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function resolveParameters(parameters: readonly TugQLParameter[], bindings: NonNullable<TugQLResolveContext["bindings"]>): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  const provided = new Map<string, NonNullable<TugQLResolveContext["bindings"]>[number]>();
  const declared = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.name.length === 0 || declared.has(parameter.name)) throw new ResolveFailure("duplicate_parameter", "parameter names must be non-empty and unique");
    declared.add(parameter.name);
    const type = parameter.type.toLowerCase();
    if (!["integer", "decimal", "string", "boolean", "date", "datetime", "timestamp"].includes(type)) throw new ResolveFailure("unsupported_parameter_type", `unsupported parameter type ${parameter.type}`);
    if (parameter.required === true && Object.prototype.hasOwnProperty.call(parameter, "default")) throw new ResolveFailure("required_parameter_default", "required parameters cannot also have defaults");
    if (Object.prototype.hasOwnProperty.call(parameter, "default")) {
      const error = parameterValueError(type, parameter.default, parameter.required === true);
      if (error !== undefined) throw new ResolveFailure("invalid_parameter_default", `parameter @${parameter.name}: ${error}`);
    }
  }
  for (const binding of bindings) {
    if (provided.has(binding.name)) throw new ResolveFailure("duplicate_binding", `binding appears more than once: @${binding.name}`);
    if (!declared.has(binding.name)) throw new ResolveFailure("unknown_binding", `binding has no declared parameter: @${binding.name}`);
    provided.set(binding.name, binding);
  }
  for (const parameter of parameters) {
    const binding = provided.get(parameter.name);
    let value: unknown;
    if (binding?.set === true) value = Object.prototype.hasOwnProperty.call(binding, "value") ? binding.value : null;
    else if (Object.prototype.hasOwnProperty.call(parameter, "default")) value = parameter.default;
    else if (parameter.required === true) throw new ResolveFailure("missing_required_binding", `required binding is missing: @${parameter.name}`);
    else value = null;
    const type = parameter.type.toLowerCase();
    if (binding?.set === true) {
      const error = parameterValueError(type, value, parameter.required === true);
      if (error !== undefined) throw new ResolveFailure("invalid_binding", `binding @${parameter.name}: ${error}`);
    }
    values.set(parameter.name, { value });
  }
  return values;
}

function parameterValueError(type: string, value: unknown, required: boolean): string | undefined {
  if (value === null) return required ? "required parameter cannot be explicitly null" : undefined;
  switch (type) {
    case "integer":
      if (typeof value !== "number") return "expected an integer value";
      return Number.isSafeInteger(value) ? undefined : "integer must be whole and within the exact portable range";
    case "decimal":
      if (typeof value !== "string") return "decimal values must use exact decimal text";
      return isValidExactDecimal(value) ? undefined : "decimal value must be finite exact decimal text";
    case "string": return typeof value === "string" ? undefined : "expected a string value";
    case "boolean": return typeof value === "boolean" ? undefined : "expected a boolean value";
    case "date":
    case "datetime":
    case "timestamp":
      if (typeof value !== "string") return "expected a string value";
      if (type === "date" ? isValidISODate(value) : isValidRFC3339Nano(value)) return undefined;
      return `value must be a valid ${type.toUpperCase()} literal`;
    default: return `unsupported parameter type ${JSON.stringify(type)}`;
  }
}

function validateParameterSemantics(parameters: readonly TugQLParameter[]): void {
  for (const parameter of parameters) {
    const type = parameter.type.toLowerCase();
    if (type === "decimal") throw new ResolveFailure("unsupported_decimal_semantics", `DECIMAL parameter @${parameter.name} is preserved exactly, but this query engine cannot guarantee exact decimal comparison semantics`);
    if (type === "datetime" || type === "timestamp") throw new ResolveFailure("unsupported_temporal_semantics", `${parameter.type.toUpperCase()} parameter @${parameter.name} is preserved exactly, but this query engine cannot guarantee timestamp comparison semantics`);
  }
}

function validateMappingType(value: unknown, parameter: TugQLParameter): void {
  const type = parameter.type.toLowerCase();
  if (type === "decimal" || type === "numeric") throw new ResolveFailure("unsupported_decimal_semantics", `DECIMAL parameter @${parameter.name} is preserved exactly, but this query engine cannot guarantee exact decimal comparison semantics`);
  const expression = asRecord(value);
  if (expression === undefined || !Object.prototype.hasOwnProperty.call(expression, "value")) {
    throw new ResolveFailure("unsupported_import_mapping_expression", "USING currently supports typed scalar literals and importing-query parameters");
  }
  const literal = expression.value;
  const error = parameterValueError(type, literal, parameter.required === true);
  if (error !== undefined) throw new ResolveFailure("invalid_import_mapping", `mapping for @${parameter.name}: ${error}`);
  if (type === "datetime" || type === "timestamp") throw new ResolveFailure("unsupported_temporal_semantics", `${parameter.type.toUpperCase()} parameter @${parameter.name} is preserved exactly, but this query engine cannot guarantee timestamp comparison semantics`);
}

function substituteExpression(value: unknown, bindings: ReadonlyMap<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => substituteExpression(item, bindings));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.param === "string") {
      const bound = bindings.get(record.param);
      if (bound === undefined) throw new ResolveFailure("undeclared_parameter", `parameter is not declared: @${record.param}`);
      return bound;
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, substituteExpression(item, bindings)]));
  }
  return value;
}

function substituteParametersInQuery(query: TugQLQueryDocument, bindings: ReadonlyMap<string, unknown>): TugQLQueryDocument {
  return substituteExpression(query, bindings) as TugQLQueryDocument;
}

function substituteTreeParameters(tree: TugQLTree, mappings: ReadonlyMap<string, Readonly<Record<string, unknown>>>): TugQLTree {
  const replacements = new Map<string, unknown>(mappings);
  return { format: tree.format, version: tree.version, query: substituteExpression(tree.query, replacements) as TugQLQueryDocument, ...(tree.definitions === undefined ? {} : { definitions: substituteExpression(tree.definitions, replacements) as readonly TugQLDefinition[] }) };
}

function flattenConditions(value: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(value.and)) return value.and.flatMap((item) => flattenConditions(item as Record<string, unknown>));
  return [value];
}

function isFieldNode(value: unknown): value is { readonly field: string; readonly source?: string } {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).field === "string";
}

function fieldToRecursive(value: unknown): Record<string, unknown> {
  if (!isFieldNode(value)) throw new ResolveFailure("invalid_join_condition", "JOIN ON requires fields");
  return { field: value.field, ...(value.source === undefined ? {} : { source: value.source }) };
}

function relationshipPredicateMatches(predicate: Readonly<Record<string, unknown>>, pair: TugQLRelationship["pairs"][number], leftSource: string, rightSource: string): boolean {
  if (predicate.op !== "==" || !isFieldNode(predicate.left) || !isFieldNode(predicate.right)) return false;
  const left = predicate.left; const right = predicate.right;
  return (left.field === pair.fromField && left.source === leftSource && right.field === pair.toField && right.source === rightSource)
    || (right.field === pair.fromField && right.source === leftSource && left.field === pair.toField && left.source === rightSource);
}

function relationshipIsReversed(relationship: TugQLRelationship, leftTable: string, rightTable: string, leftSource: string, rightSource: string): boolean | undefined {
  const forward = relationship.from.table === leftTable && relationship.to.table === rightTable
    && (relationship.from.source === undefined || relationship.from.source === leftSource)
    && (relationship.to.source === undefined || relationship.to.source === rightSource);
  if (forward) return false;
  const reverse = relationship.to.table === leftTable && relationship.from.table === rightTable
    && (relationship.to.source === undefined || relationship.to.source === leftSource)
    && (relationship.from.source === undefined || relationship.from.source === rightSource);
  return reverse ? true : undefined;
}

function relationshipPredicatesMatch(predicates: readonly Readonly<Record<string, unknown>>[], relationship: TugQLRelationship, leftSource: string, rightSource: string, reversed: boolean): boolean {
  if (predicates.length !== relationship.pairs.length || predicates.length === 0) return false;
  const matched = new Set<number>();
  for (const predicate of predicates) {
    const index = relationship.pairs.findIndex((pair) => {
      const effectivePair = reversed ? { fromField: pair.toField, toField: pair.fromField } : pair;
      return relationshipPredicateMatches(predicate, effectivePair, leftSource, rightSource);
    });
    if (index < 0 || matched.has(index)) return false;
    matched.add(index);
  }
  return matched.size === relationship.pairs.length;
}

function findFunctionCall(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findFunctionCall(item); if (found !== undefined) return found; }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const call = asRecord(record.call);
    if (call !== undefined && typeof call.function === "string") return call.function;
    for (const item of Object.values(record)) { const found = findFunctionCall(item); if (found !== undefined) return found; }
  }
  return undefined;
}

function containsBareStar(value: unknown, insideAggregate = false): boolean {
  if (Array.isArray(value)) return value.some((item) => containsBareStar(item, insideAggregate));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.star === true) return !insideAggregate;
    if (record.aggregate !== undefined) return containsBareStar(record.aggregate, true);
    return Object.values(record).some((item) => containsBareStar(item, insideAggregate));
  }
  return false;
}

function normalizeEngineAggregateNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEngineAggregateNames);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const aggregate = asRecord(record.aggregate);
    if (aggregate !== undefined && typeof aggregate.function === "string") return {
      ...record,
      aggregate: { ...aggregate, function: aggregate.function.toLowerCase(), ...(Array.isArray(aggregate.args) ? { args: normalizeEngineAggregateNames(aggregate.args) } : {}) },
    };
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, normalizeEngineAggregateNames(item)]));
  }
  return value;
}

function stripInternalLineage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalLineage);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "__lineage").map(([key, item]) => [key, stripInternalLineage(item)]));
  }
  return value;
}

function normalizeImportPath(importingPath: string, requestedPath: string): string {
  if (requestedPath.startsWith("/") || requestedPath.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(requestedPath)) return `../${requestedPath}`;
  const base = importingPath.replaceAll("\\", "/").split("/").slice(0, -1).join("/");
  const parts: string[] = [];
  for (const part of `${base}/${requestedPath}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (parts.length === 0) return `../${parts.join("/")}`; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}

function isNormalizedProjectRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function isProjectRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.startsWith("../") && !path.includes("/../");
}

interface TugQLInferredOutputColumn extends Omit<TugQLOutputColumn, "lineage"> {
  readonly lineage: readonly { readonly source: string; readonly field: string }[];
  readonly projection?: { readonly source: string; readonly field: string };
}

type TugQLResolvedExpressionSources = ReadonlyMap<string, readonly TugQLInferredOutputColumn[]>;

function validateSafeOperations(
  query: TugQLQueryDocument,
  definitions: readonly TugQLDefinition[],
  schemas: ReadonlyMap<string, { readonly database?: string; readonly schema?: string; readonly version: string; readonly fields: Map<string, TugQLTypedField> }>,
  relationships: readonly TugQLRelationship[],
): void {
  const unsupportedDecimal = (): never => { throw new ResolveFailure("unsupported_decimal_semantics", "exact DECIMAL/NUMERIC arithmetic or comparison is not supported by the current query engine"); };
  const unsupportedTemporal = (): never => { throw new ResolveFailure("unsupported_temporal_semantics", "temporal comparison or ordering is not supported by the current query engine"); };
  const unsupportedArithmetic = (): never => { throw new ResolveFailure("unsupported_output_type", "arithmetic requires supported numeric operands"); };
  const numeric = (type: string): boolean => ["integer", "int", "int32", "int64", "decimal", "numeric", "float", "float32", "float64", "number"].includes(type.toLowerCase());
  const exact = (type: string): boolean => ["decimal", "numeric"].includes(type.toLowerCase());
  const temporal = (type: string): boolean => ["datetime", "timestamp"].includes(type.toLowerCase());
  const orderedOperators = new Set([">", ">=", "<", "<=", "gt", "gte", "lt", "lte"]);
  const compatibleOrderedTypes = (left: string, right: string, leftExpression: Readonly<Record<string, unknown>>, rightExpression: Readonly<Record<string, unknown>>): boolean => {
    if (numeric(left) && numeric(right)) return true;
    if (left.toLowerCase() === "date" && typeof rightExpression.value === "string" && isValidISODate(rightExpression.value)) return true;
    if (right.toLowerCase() === "date" && typeof leftExpression.value === "string" && isValidISODate(leftExpression.value)) return true;
    const safeSameType = new Set(["string", "boolean", "date"]);
    return left.toLowerCase() === right.toLowerCase() && safeSameType.has(left.toLowerCase());
  };

  const visitQuery = (current: TugQLQueryDocument, scope: readonly TugQLDefinition[], outer: TugQLResolvedExpressionSources): void => {
    const local = tugqlQueryExpressionSources(current, scope, schemas, relationships);
    const sources = new Map(outer);
    for (const [name, columns] of local) sources.set(name, columns);
    const info = (expression: Readonly<Record<string, unknown>>): TugQLInferredOutputColumn => {
      const inferred = inferOutputColumns({ ...current, columns: [{ ...expression, as: "__tugql_safe_expression" }] }, scope, schemas, relationships, new Set(), sources)[0];
      if (inferred === undefined) throw new ResolveFailure("unknown_output_type", "cannot infer the output type of this expression");
      return inferred;
    };
    const checkExpression = (expression: Readonly<Record<string, unknown>>): void => {
      const binary = asRecord(expression.binary);
      if (binary !== undefined) {
        const left = asRecord(binary.left); const right = asRecord(binary.right);
        if (left === undefined || right === undefined) throw new ResolveFailure("invalid_expression", "binary expression operands must be expressions");
        checkExpression(left); checkExpression(right);
        const leftType = info(left).type; const rightType = info(right).type;
        if (exact(leftType) || exact(rightType)) unsupportedDecimal();
        if (!numeric(leftType) || !numeric(rightType)) unsupportedArithmetic();
      }
      const aggregate = asRecord(expression.aggregate);
      if (aggregate !== undefined) {
        const functionName = stringField(aggregate, "function").toLowerCase();
        for (const arg of Array.isArray(aggregate.args) ? aggregate.args : []) {
          const argRecord = asRecord(arg);
          if (argRecord === undefined) continue;
          if (argRecord.star === true && functionName === "count") continue;
          if (argRecord.star === true && (functionName === "sum" || functionName === "avg")) {
            throw new ResolveFailure("unsupported_output_type", "SUM/AVG requires a supported numeric argument");
          }
          checkExpression(argRecord);
          const type = info(argRecord).type;
          if ((functionName === "sum" || functionName === "avg") && !numeric(type)) {
            throw new ResolveFailure("unsupported_output_type", "SUM/AVG requires a supported numeric argument");
          }
          if (exact(type) && ["sum", "avg", "min", "max"].includes(functionName)) unsupportedDecimal();
          if (temporal(type) && ["min", "max"].includes(functionName)) unsupportedTemporal();
          if (exact(type) && aggregate.distinct === true) unsupportedDecimal();
          if (temporal(type) && aggregate.distinct === true) unsupportedTemporal();
        }
        for (const item of Array.isArray(aggregate.orderBy) ? aggregate.orderBy : []) {
          const order = asRecord(item);
          if (order === undefined) continue;
          checkExpression(order);
          const call = asRecord(order.call);
          if (call !== undefined) {
            for (const arg of Array.isArray(call.args) ? call.args : []) {
              const argument = asRecord(arg);
              if (argument === undefined) continue;
              info(argument); // Resolve fields first so authorization wins over unsupported ordering.
            }
            throw new ResolveFailure("unsupported_aggregate_order", "aggregate ORDER BY is not supported by the current query model");
          }
          const type = info(order).type;
          if (exact(type)) unsupportedDecimal();
          if (temporal(type)) unsupportedTemporal();
          throw new ResolveFailure("unsupported_aggregate_order", "aggregate ORDER BY is not supported by the current query model");
        }
      }
      const nested = asRecord(expression.query);
      if (nested !== undefined) {
        const nestedQuery = asRecord(nested.query) ?? (nested.from === undefined ? undefined : nested);
        if (nestedQuery === undefined) throw new ResolveFailure("invalid_scalar_query", "scalar query body is malformed");
        const nestedDefinitions = Array.isArray(nested.definitions) ? nested.definitions as TugQLDefinition[] : [];
        visitQuery(nestedQuery as TugQLQueryDocument, [...scope, ...nestedDefinitions], sources);
      }
    };
    const checkCondition = (condition: unknown): void => {
      if (Array.isArray(condition)) { for (const item of condition) checkCondition(item); return; }
      const item = asRecord(condition);
      if (item === undefined) return;
      for (const key of ["left", "right", "isNull", "isNotNull"]) {
        const operand = asRecord(item[key]);
        if (operand !== undefined) checkExpression(operand);
      }
      if (typeof item.op === "string" && item.left !== undefined && item.right !== undefined) {
        const left = asRecord(item.left); const right = asRecord(item.right);
        const leftType = left === undefined ? undefined : info(left).type;
        const rightType = right === undefined ? undefined : info(right).type;
        for (const type of [leftType, rightType]) {
          if (type === undefined) continue;
          if (exact(type)) unsupportedDecimal();
          if (temporal(type)) unsupportedTemporal();
        }
        if (orderedOperators.has(item.op.toLowerCase()) && leftType !== undefined && rightType !== undefined && left !== undefined && right !== undefined && !compatibleOrderedTypes(leftType, rightType, left, right)) {
          throw new ResolveFailure("unsupported_comparison_type", "ordered comparison requires compatible operand types");
        }
      }
      for (const key of ["and", "or"]) if (Array.isArray(item[key])) checkCondition(item[key]);
      for (const key of ["exists", "notExists"]) {
        const wrapper = asRecord(item[key]);
        const nested = asRecord(wrapper?.query);
        if (nested !== undefined) visitQuery(nested as TugQLQueryDocument, scope, sources);
      }
    };

    for (const column of Array.isArray(current.columns) ? current.columns as Record<string, unknown>[] : []) checkExpression(column);
    for (const expression of Array.isArray(current.groupBy) ? current.groupBy : []) {
      const item = asRecord(expression);
      if (item === undefined) continue;
      checkExpression(item);
      const type = info(item).type;
      if (exact(type)) unsupportedDecimal();
      if (temporal(type)) unsupportedTemporal();
    }
    for (const expression of Array.isArray(current.orderBy) ? current.orderBy as Record<string, unknown>[] : []) {
      checkExpression(expression);
      const type = info(expression).type;
      if (exact(type)) unsupportedDecimal();
      if (temporal(type)) unsupportedTemporal();
      if (!isFieldNode(expression)) throw new ResolveFailure("unsupported_order_expression", "computed ORDER BY expressions are not supported by the current query model");
    }
    checkCondition(current.where);
    checkCondition(current.having);
    const from = asRecord(current.from);
    const visitJoin = (relation: Record<string, unknown>): void => {
      if (Array.isArray(relation.joins)) for (const joinValue of relation.joins) {
        const join = asRecord(joinValue);
        if (join === undefined) continue;
        checkCondition(join.on);
        const joined = asRecord(join.from);
        if (joined !== undefined) visitJoin(joined);
      }
      const derived = asRecord(relation.query);
      if (derived !== undefined) visitQuery(derived as TugQLQueryDocument, scope, sources);
    };
    if (from !== undefined) visitJoin(from);
  };

  visitQuery(query, definitions, new Map());
}

function tugqlQueryExpressionSources(
  query: TugQLQueryDocument,
  definitions: readonly TugQLDefinition[],
  schemas: ReadonlyMap<string, { readonly database?: string; readonly schema?: string; readonly version: string; readonly fields: Map<string, TugQLTypedField> }>,
  relationships: readonly TugQLRelationship[],
): Map<string, readonly TugQLInferredOutputColumn[]> {
  const scope = new Map(definitions.map((definition) => [definition.name, definition]));
  const fieldsFor = (from: Readonly<Record<string, unknown>>): readonly TugQLInferredOutputColumn[] => {
    const nestedRelation = asRecord(from.query);
    if (nestedRelation !== undefined && typeof from.name !== "string") {
      const alias = optionalStringField(nestedRelation, "as") ?? optionalStringField(from, "as") ?? "";
      return inferOutputColumns(nestedRelation as TugQLQueryDocument, definitions, schemas, relationships).map((column) => ({ ...column, projection: { source: alias, field: column.name } }));
    }
    const name = stringField(from, "name");
    const alias = optionalStringField(from, "alias") ?? name;
    const definition = scope.get(name);
    if (definition?.kind === "cte") {
      const nestedScope = new Map(scope);
      for (const nested of definition.query.definitions ?? []) nestedScope.set(nested.name, nested);
      return inferOutputColumns(definition.query.query, [...nestedScope.values()], schemas, relationships).map((column) => ({ ...column, projection: { source: alias, field: column.name } }));
    }
    const schemaName = stringField(from, "schema");
    const database = stringField(from, "database");
    const matches = [...schemas.entries()].filter(([key, table]) => key.endsWith(`\0${schemaName}\0${name}`) && table.database === (database || undefined));
    if (matches.length !== 1) throw new ResolveFailure(matches.length === 0 ? "unauthorized_source" : "ambiguous_schema", matches.length === 0 ? `source is not present in authorized schemas: ${name}` : `source ${name} does not identify one authorized schema table`);
    return [...matches[0]![1].fields.values()].map((field) => ({ name: field.name, type: field.type, lineage: [{ source: alias, field: field.name }], projection: { source: alias, field: field.name } }));
  };
  const from = query.from as Record<string, unknown>;
  const sources = new Map<string, readonly TugQLInferredOutputColumn[]>();
  const fromName = stringField(from, "name");
  sources.set(optionalStringField(from, "alias") ?? fromName, fieldsFor(from));
  const addJoinedSources = (relation: Readonly<Record<string, unknown>>): void => {
    for (const join of Array.isArray(relation.joins) ? relation.joins as Record<string, unknown>[] : []) {
      const joined = join.from as Record<string, unknown>;
      const name = stringField(joined, "name");
      sources.set(optionalStringField(joined, "alias") ?? name, fieldsFor(joined));
      addJoinedSources(joined);
    }
  };
  addJoinedSources(from);
  return sources;
}

function inferOutputColumns(query: TugQLQueryDocument, definitions: readonly TugQLDefinition[], schemas: ReadonlyMap<string, { readonly database?: string; readonly schema?: string; readonly version: string; readonly fields: Map<string, TugQLTypedField> }>, relationships: readonly TugQLRelationship[] = [], ancestors: ReadonlySet<string> = new Set(), outerSources: TugQLResolvedExpressionSources = new Map()): TugQLInferredOutputColumn[] {
  const scope = new Map(definitions.map((definition) => [definition.name, definition]));
  const fieldsFor = (from: Readonly<Record<string, unknown>>): readonly TugQLInferredOutputColumn[] => {
    const nestedRelation = asRecord(from.query);
    if (nestedRelation !== undefined && typeof from.name !== "string") {
      const alias = optionalStringField(nestedRelation, "as") ?? optionalStringField(from, "as") ?? "";
      const columns = inferOutputColumns(nestedRelation as TugQLQueryDocument, definitions, schemas, relationships, ancestors);
      return columns.map((column) => ({ ...column, projection: { source: alias, field: column.name } }));
    }
    const name = stringField(from, "name");
    const nestedQuery = asRecord(from.query);
    const alias = optionalStringField(from, "alias") ?? (nestedQuery === undefined ? undefined : optionalStringField(nestedQuery, "as")) ?? name;
    const definition = scope.get(name);
    if (definition?.kind === "cte") {
      if (ancestors.has(name)) throw new ResolveFailure("recursive_cte", `recursive CTE ${name} is not supported`);
      const nestedScope = new Map(scope);
      for (const nested of definition.query.definitions ?? []) nestedScope.set(nested.name, nested);
      const columns = inferOutputColumns(definition.query.query, [...nestedScope.values()], schemas, relationships, new Set([...ancestors, name]));
      return columns.map((column) => ({ ...column, projection: { source: alias, field: column.name } }));
    }
    const schema = stringField(from, "schema");
    const database = stringField(from, "database");
    const matches = [...schemas.entries()].filter(([key, table]) => key.endsWith(`\0${schema}\0${name}`) && table.database === (database || undefined));
    if (matches.length !== 1) throw new ResolveFailure(matches.length === 0 ? "unauthorized_source" : "ambiguous_schema", matches.length === 0 ? `source is not present in authorized schemas: ${name}` : `source ${name} does not identify one authorized schema table`);
    return [...matches[0]![1].fields.values()].map((field) => ({ name: field.name, type: field.type, lineage: [{ source: alias, field: field.name }], projection: { source: alias, field: field.name } }));
  };
  const from = query.from as Record<string, unknown>;
  const sources = new Map<string, readonly TugQLInferredOutputColumn[]>(outerSources);
  const localSources = new Map<string, readonly TugQLInferredOutputColumn[]>();
  const fromName = stringField(from, "name");
  const nestedQueryAlias = asRecord(from.query);
  const baseAlias = optionalStringField(from, "alias") ?? (nestedQueryAlias === undefined ? undefined : optionalStringField(nestedQueryAlias, "as")) ?? fromName;
  localSources.set(baseAlias, fieldsFor(from));
  sources.set(baseAlias, localSources.get(baseAlias)!);
  const addJoinedSources = (relation: Readonly<Record<string, unknown>>): void => {
    for (const join of Array.isArray(relation.joins) ? relation.joins as Record<string, unknown>[] : []) {
      const joinFrom = join.from as Record<string, unknown>;
      const joinName = stringField(joinFrom, "name");
      const alias = optionalStringField(joinFrom, "alias") ?? joinName;
      localSources.set(alias, fieldsFor(joinFrom));
      sources.set(alias, localSources.get(alias)!);
      addJoinedSources(joinFrom);
    }
  };
  addJoinedSources(from);
  const selected = query.columns as readonly Record<string, unknown>[] | undefined;
  const groupBy = query.groupBy as readonly Record<string, unknown>[] | undefined;
  if (selected === undefined && groupBy?.some((expression) => !isFieldNode(expression)) === true) {
    throw new ResolveFailure("invalid_projection", "computed GROUP BY expressions require an explicit aliased projection");
  }
  const expressions: readonly Readonly<Record<string, unknown>>[] = selected ?? (groupBy ?? buildDefaultProjection(query, sources, relationships));
  const candidate = (field: { readonly field: string; readonly source?: string }): TugQLInferredOutputColumn => {
    const local = field.source === undefined ? [...localSources.values()].flat() : localSources.get(field.source) ?? [];
    const visible = field.source === undefined ? [...sources.values()].flat() : sources.get(field.source) ?? [];
    const localMatches = local.filter((column) => column.name === field.field);
    const found = localMatches.length > 0 ? localMatches : visible.filter((column) => column.name === field.field);
    if (found.length === 0) throw new ResolveFailure("unauthorized_field", `field is unavailable or unauthorized: ${field.field}`);
    if (found.length > 1) throw new ResolveFailure("ambiguous_field", `field ${field.field} does not identify one authorized source`);
    return found[0]!;
  };
  const expressionInfo = (value: Readonly<Record<string, unknown>>): { readonly type: string; readonly lineage: readonly { source: string; field: string }[]; readonly inferredName?: string; readonly projection?: { readonly source: string; readonly field: string } } => {
    if (isFieldNode(value)) {
      const result = candidate(value);
      const projection = result.projection ?? result.lineage[0];
      return { type: result.type, lineage: result.lineage, inferredName: value.field, ...(projection === undefined ? {} : { projection }) };
    }
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      const literal = value.value;
      return { type: typeof literal === "string" ? "string" : typeof literal === "boolean" ? "boolean" : typeof literal === "number" ? Number.isSafeInteger(literal) ? "integer" : "decimal" : "unknown", lineage: [] };
    }
    const aggregate = asRecord(value.aggregate);
    if (aggregate !== undefined) {
      const functionName = stringField(aggregate, "function").toLowerCase();
      if (functionName === "count") return { type: "integer", lineage: [], inferredName: functionName };
      const args = Array.isArray(aggregate.args) ? aggregate.args : [];
      const argInfo = args[0] !== undefined && asRecord(args[0]) !== undefined ? expressionInfo(asRecord(args[0])!) : { type: "unknown", lineage: [] };
      if ((functionName === "sum" || functionName === "avg") && !isTugQLNumericType(argInfo.type)) {
        throw new ResolveFailure("unsupported_output_type", "SUM/AVG requires a supported numeric argument");
      }
      const outputType = functionName === "avg" || functionName === "sum" ? "number" : argInfo.type;
      if (outputType === "unknown") throw new ResolveFailure("unknown_output_type", `cannot infer ${functionName} output type`);
      return { type: outputType, lineage: argInfo.lineage, inferredName: functionName };
    }
    const binary = asRecord(value.binary);
    if (binary !== undefined) {
      const left = asRecord(binary.left); const right = asRecord(binary.right);
      if (left === undefined || right === undefined) throw new ResolveFailure("invalid_expression", "binary expression operands must be expressions");
      const leftInfo = expressionInfo(left); const rightInfo = expressionInfo(right);
      if (!isTugQLNumericType(leftInfo.type) || !isTugQLNumericType(rightInfo.type)) throw new ResolveFailure("unsupported_output_type", "output type cannot be inferred safely from the authorized schema");
      const type = "number";
      return { type, lineage: mergeLineage(leftInfo.lineage, rightInfo.lineage) };
    }
    const nestedBody = asRecord(value.query);
    if (nestedBody !== undefined) {
      const nestedQuery = asRecord(nestedBody.query) ?? (nestedBody.from === undefined ? undefined : nestedBody);
      if (nestedQuery === undefined) throw new ResolveFailure("invalid_scalar_query", "scalar query body is malformed");
      const nestedDefinitions = Array.isArray(nestedBody.definitions) ? nestedBody.definitions as TugQLDefinition[] : [];
      const columns = inferOutputColumns(nestedQuery as TugQLQueryDocument, [...scope.values(), ...nestedDefinitions], schemas, relationships, ancestors, sources);
      if (columns.length !== 1) throw new ResolveFailure("scalar_column_count", "scalar subqueries must return exactly one column");
      const inferredName = optionalStringField(nestedQuery, "as");
      return { type: columns[0]!.type, lineage: columns[0]!.lineage, ...(inferredName === undefined ? {} : { inferredName }) };
    }
    if (value.call !== undefined) {
      const functionName = asRecord(value.call)?.function ?? "";
      throw new ResolveFailure("unsupported_function", `unsupported_function: scalar function ${JSON.stringify(functionName)} is not executable by DALgo`);
    }
    if (value.star === true) throw new ResolveFailure("unsupported_projection", "wildcard projection cannot be resolved to a stable typed output");
    throw new ResolveFailure("unknown_output_type", "cannot infer the output type of this expression");
  };
  const names = new Set<string>();
  return expressions.map((expression) => {
    const info = expressionInfo(expression);
    const outputName = optionalStringField(expression, "as") ?? info.inferredName;
    if (outputName === undefined) throw new ResolveFailure("invalid_projection", "every computed output column requires an alias");
    if (names.has(outputName)) throw new ResolveFailure("duplicate_output_name", `output column name is duplicated: ${outputName}`);
    names.add(outputName);
    const mergedLineage = Array.isArray(expression.__lineage) ? expression.__lineage as { source: string; field: string }[] : info.lineage;
    return { name: outputName, type: info.type, lineage: mergedLineage, ...(info.projection === undefined ? {} : { projection: info.projection }) };
  });
}

function isTugQLNumericType(typeName: string): boolean {
  return ["integer", "int", "int32", "int64", "decimal", "numeric", "float", "float32", "float64", "number"].includes(typeName.toLowerCase());
}

function buildDefaultProjection(query: TugQLQueryDocument, sources: ReadonlyMap<string, readonly TugQLInferredOutputColumn[]>, relationships: readonly TugQLRelationship[]): Readonly<Record<string, unknown>>[] {
  const from = query.from as Record<string, unknown>;
  const parents = new Map<string, string>();
  const find = (key: string): string => {
    const parent = parents.get(key);
    if (parent === undefined) { parents.set(key, key); return key; }
    if (parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };
  const leftRelations: { readonly table: string; readonly source: string }[] = [{ table: stringField(from, "name"), source: optionalStringField(from, "alias") ?? stringField(from, "name") }];
  for (const join of Array.isArray(from.joins) ? from.joins as Record<string, unknown>[] : []) {
    const joinedFrom = join.from as Record<string, unknown>;
    const rightTable = stringField(joinedFrom, "name");
    const rightSource = optionalStringField(joinedFrom, "alias") ?? rightTable;
    const joinType = typeof join.type === "string" ? join.type.toLowerCase() : "inner";
    if (joinType === "inner") {
      const candidates = relationships.flatMap((relationship) => leftRelations.flatMap((leftRelation) => {
        const reversed = relationshipIsReversed(relationship, leftRelation.table, rightTable, leftRelation.source, rightSource);
        if (!relationship.exactTypedEquality || reversed === undefined || relationship.pairs.length === 0) return [];
        const typesMatch = relationship.pairs.every((pair) => {
          const leftField = sources.get(leftRelation.source)?.find((field) => field.name === (reversed ? pair.toField : pair.fromField));
          const rightField = sources.get(rightSource)?.find((field) => field.name === (reversed ? pair.fromField : pair.toField));
          return leftField?.type !== undefined && leftField.type === rightField?.type;
        });
        return typesMatch && relationshipJoinPredicatesMatch(join, relationship, leftRelation.source, rightSource, reversed)
          ? [{ relationship, reversed, leftRelation }] : [];
      }));
      if (candidates.length === 1) {
        const { relationship, reversed, leftRelation } = candidates[0]!;
        for (const pair of relationship.pairs) {
          const leftField = reversed ? pair.toField : pair.fromField;
          const rightField = reversed ? pair.fromField : pair.toField;
          union(`${leftRelation.source}\0${leftField}`, `${rightSource}\0${rightField}`);
        }
      }
    }
    leftRelations.push({ table: rightTable, source: rightSource });
  }

  const components = new Map<string, { readonly key: string; readonly column: TugQLInferredOutputColumn; readonly source: string }[]>();
  for (const [source, columns] of sources) for (const column of columns) {
    const key = `${source}\0${column.name}`;
    const root = find(key);
    const members = components.get(root) ?? [];
    members.push({ key, column, source });
    components.set(root, members);
  }
  const names = new Set<string>();
  const result: Readonly<Record<string, unknown>>[] = [];
  for (const [source, columns] of sources) for (const column of columns) {
    const key = `${source}\0${column.name}`;
    const component = components.get(find(key)) ?? [{ key, column, source }];
    if (component[0]?.key !== key) continue;
    const lineage = mergeLineage(...component.map((item) => item.column.lineage));
    let outputName = column.name;
    if (names.has(outputName)) outputName = `${source}_${column.name}`;
    for (let suffix = 2; names.has(outputName); suffix += 1) outputName = `${source}_${column.name}_${suffix.toString()}`;
    names.add(outputName);
    const projection = column.projection ?? { source, field: column.name };
    result.push({ field: projection.field, source: projection.source, as: outputName, __lineage: lineage });
  }
  return result;
}

function relationshipJoinPredicatesMatch(join: Readonly<Record<string, unknown>>, relationship: TugQLRelationship, leftSource: string, rightSource: string, reversed: boolean): boolean {
  if (join.on === undefined || (Array.isArray(join.on) && join.on.length === 0)) return true;
  if (!Array.isArray(join.on)) return false;
  const conditions = join.on.flatMap((item) => flattenConditions(item as Record<string, unknown>));
  if (conditions.length === 1 && conditions[0]!.op === "relationship") {
    const field = conditions[0]!.left;
    return isFieldNode(field) && relationship.pairs.some((pair) => (field.field === pair.fromField && (field.source === undefined || field.source === leftSource)) || (field.field === pair.toField && (field.source === undefined || field.source === rightSource)));
  }
  return relationshipPredicatesMatch(conditions, relationship, leftSource, rightSource, reversed);
}

function mergeLineage(...groups: readonly (readonly { readonly source: string; readonly field: string }[])[]): { source: string; field: string }[] {
  const result: { source: string; field: string }[] = [];
  const seen = new Set<string>();
  for (const item of groups.flat()) {
    const key = `${item.source}\0${item.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ source: item.source, field: item.field });
  }
  return result;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function optionalStringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function resolveKeywordCase(tokens: readonly Token[], options: TugQLFormatOptions): "lower" | "upper" {
  const preferences = [options.keywordCase, options.projectTeamKeywordCase, options.userKeywordCase];
  for (const preference of preferences) {
    if (preference === "lowercase") return "lower";
    if (preference === "uppercase") return "upper";
    if (preference === "preserve-existing") break;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!isKeywordRole(tokens, index)) continue;
    if (token.value === token.value.toLowerCase()) return "lower";
    if (token.value === token.value.toUpperCase()) return "upper";
  }
  return options.defaultKeywordCase === "uppercase" ? "upper" : "lower";
}

function rewriteKeywordCase(source: string, tokens: readonly Token[], style: "lower" | "upper"): string {
  const edits = tokens.flatMap((token, index) => isKeywordRole(tokens, index) ? [{ token }] : [])
    .map(({ token }) => ({ start: token.startOffset, end: token.endOffset, value: style === "lower" ? token.value.toLowerCase() : token.value.toUpperCase() }))
    .filter((edit) => source.slice(edit.start, edit.end) !== edit.value);
  let result = source;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

function resolveIndentUnit(source: string, options: TugQLFormatOptions, tokens: readonly Token[]): string {
  const preferences = [options.indentation, options.projectTeamIndentation, options.userIndentation];
  let explicit: "tab" | "two-spaces" | "preserve-existing" | undefined;
  for (const preference of preferences) {
    if (preference !== undefined) { explicit = preference; break; }
  }
  if (explicit === "tab") return "\t";
  if (explicit === "two-spaces") return "  ";
  const lines = linesFromTokens(source, tokens);
  let existing: "tab" | "spaces" | undefined;
  let consistent = true;
  for (const line of lines) {
    if (line.tokens.length === 0 || line.indent.length === 0) continue;
    const tab = line.indent.includes("\t");
    if (tab && line.indent.includes(" ")) { consistent = false; break; }
    if (!tab && line.indent.length % 2 !== 0) { consistent = false; break; }
    const current = tab ? "tab" : "spaces";
    if (existing !== undefined && existing !== current) { consistent = false; break; }
    existing ??= current;
  }
  if (consistent && existing === "tab") return "\t";
  if (consistent && existing === "spaces") return "  ";
  return options.defaultIndentation === "tab" ? "\t" : "  ";
}

function reindentTugQL(source: string, options: TugQLFormatOptions, originalTokens: readonly Token[], sourceWasValid: boolean): string {
  const unit = resolveIndentUnit(source, options, originalTokens);
  const tokenized = tokenizeTugQL(source);
  const lines = linesFromTokens(source, tokenized.tokens);
  const rawLines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks: { readonly kind: "parameters" | "cte" | "using" | "scalar" | "select-items"; readonly level: number }[] = [];
  let queryDepth = 0;
  let scalarDepth = 0;
  let lastClauseLevel = 0;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const raw = rawLines[i] ?? "";
    const content = raw.trimStart();
    if (content.length === 0) { out.push(""); continue; }
    const tokens = line.tokens;
    let level: number;
    const closing = tokens.length === 1 && tokens[0]!.text === ")" ? blocks.at(-1) : undefined;
    if (closing !== undefined) {
      level = closing.level;
      blocks.pop();
      if (closing.kind === "cte") queryDepth = Math.max(0, closing.level - scalarDepth);
      if (closing.kind === "scalar" || closing.kind === "select-items") scalarDepth = Math.max(0, scalarDepth - 1);
    } else if (keyword(tokens[0], "select") && tokens[1]?.text === "(") {
      level = queryDepth + scalarDepth;
      blocks.push({ kind: "select-items", level });
      scalarDepth += 1;
    } else if (keyword(tokens[0], "parameters") && tokens[1]?.text === "(") {
      level = 0; blocks.push({ kind: "parameters", level });
    } else if (keyword(tokens[0], "with") && keyword(tokens[2], "as") && tokens[3]?.text === "(") {
      level = queryDepth + scalarDepth; blocks.push({ kind: "cte", level }); queryDepth += 1;
    } else if (keyword(tokens[0], "using") && tokens[1]?.text === "(") {
      level = queryDepth + scalarDepth + 1; blocks.push({ kind: "using", level });
    } else if (tokens.some((token) => keyword(token, "as")) && tokens.at(-1)?.text === "(") {
      level = queryDepth + scalarDepth;
      blocks.push({ kind: "scalar", level });
      scalarDepth += 1;
    } else if (blocks.at(-1)?.kind === "parameters") {
      level = blocks.at(-1)!.level + 1;
    } else if (blocks.at(-1)?.kind === "using") {
      level = blocks.at(-1)!.level + 1;
    } else if (keyword(tokens[0], "with") && keyword(tokens[2], "from")) {
      level = queryDepth + scalarDepth;
    } else {
      const clause = clauseStart(tokens);
      if (clause !== undefined) {
        level = clause.name === "on" ? queryDepth + scalarDepth + 1 : queryDepth + scalarDepth;
        lastClauseLevel = level;
      } else if (content.startsWith("--")) level = blocks.at(-1)?.kind === "parameters" ? (blocks.at(-1)?.level ?? 0) + 1 : queryDepth + scalarDepth;
      else if (!sourceWasValid && line.indent.length === 0) level = 0;
      else level = lastClauseLevel + 1;
    }
    out.push(unit.repeat(level) + content);
  }
  return out.join("\n");
}
