import { describe, expect, it } from "vitest";
import { parseTugQL, resolveTugQL, serializeRecursiveTugQL, type TugQLResolveContext, type TugQLResolveResult } from "../src/index.js";

const users = { version: "v1", tables: [{ name: "users", fields: [{ name: "id", type: "string", authorized: true }, { name: "title", type: "string", authorized: true }] }] };

function resolve(source: string, context: Partial<TugQLResolveContext> = {}): TugQLResolveResult {
  const parsed = parseTugQL(source);
  expect(parsed.diagnostics).toEqual([]);
  return resolveTugQL(parsed.document, { authorizedSchemas: [], relationships: [], pinnedImports: [], ...context });
}

function resolvedQuery(result: TugQLResolveResult): Record<string, unknown> {
  expect(result.diagnostics).toEqual([]);
  if (result.resolved === undefined) throw new Error("query did not resolve");
  return serializeRecursiveTugQL(result.resolved.query);
}

function codes(result: TugQLResolveResult): { readonly code: string; readonly message: string }[] {
  expect(result.resolved).toBeUndefined();
  return result.diagnostics.map(({ code, message }) => ({ code, message }));
}

const queriesOfAProject = "parameters (\n  @projectId string required\n)\nfrom spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects/{projectId}/queries\n";
const context = { SneatUserID: "u1", SneatUserPersonalSpaceID: "p9" };

describe("resolveTugQL contextVariables", () => {
  it("binds a context variable used as a value without a declaration", () => {
    const query = resolvedQuery(resolve("from users\nwhere id = @SneatUserID\nselect id\n", { authorizedSchemas: [users], contextVariables: context }));
    expect(query.where).toEqual({ left: { field: "id" }, op: "==", right: { value: "u1" } });
  });

  it("still refuses a parameter that is neither declared nor a context variable", () => {
    expect(codes(resolve("from users\nwhere id = @Other\nselect id\n", { authorizedSchemas: [users], contextVariables: context })))
      .toEqual([{ code: "undeclared_parameter", message: "parameter is not declared: @Other" }]);
  });

  it("does not report a binding named after a context variable as unknown", () => {
    const query = resolvedQuery(resolve("from users\nwhere id = @SneatUserID\nselect id\n", {
      authorizedSchemas: [users], contextVariables: context, bindings: [{ name: "SneatUserID", set: true, value: "spoofed" }],
    }));
    expect(query.where).toEqual({ left: { field: "id" }, op: "==", right: { value: "u1" } });
  });

  it("refuses a declared parameter that has the name of a context variable", () => {
    expect(codes(resolve("parameters (\n  @SneatUserID string required\n)\nfrom users\nwhere id = @SneatUserID\nselect id\n", { authorizedSchemas: [users], contextVariables: context })))
      .toEqual([{ code: "reserved_parameter", message: "parameter @SneatUserID has the name of a context variable" }]);
  });

  it("refuses a declared parameter with a reserved context-variable name even without contextVariables", () => {
    expect(codes(resolve("parameters (\n  @SneatUserID string required\n)\nfrom users/{SneatUserID}/ext\n", { schemaless: true, bindings: [{ name: "SneatUserID", set: true, value: "someone-else" }] })))
      .toEqual([{ code: "reserved_parameter", message: "parameter @SneatUserID has the name of a context variable" }]);
  });

  it("refuses a reserved name declared by an imported query", () => {
    const parsed = parseTugQL("with Mine from './mine.tql'\nfrom Mine\n");
    expect(parsed.diagnostics).toEqual([]);
    const result = resolveTugQL(parsed.document, {
      authorizedSchemas: [], relationships: [], schemaless: true, projectRoot: "/p", importingPath: "q.tql", projectRevision: "r1",
      pinnedImports: [{ path: "mine.tql", revision: "r1", source: "parameters (\n  @SneatUserPersonalSpaceID string default 'x'\n)\nfrom spaces/{SneatUserPersonalSpaceID}/items\n" }],
    });
    expect(codes(result)).toEqual([{ code: "reserved_parameter", message: "parameter @SneatUserPersonalSpaceID has the name of a context variable" }]);
  });

  it("refuses a context variable whose value is not a string", () => {
    expect(codes(resolve("from users\nselect id\n", { authorizedSchemas: [users], contextVariables: { SneatUserID: 7 as unknown as string } })))
      .toEqual([{ code: "invalid_context_variable", message: "context variable SneatUserID must be a string" }]);
  });
});

describe("resolveTugQL {name} path substitution", () => {
  it("substitutes context variables into the parent path", () => {
    const query = resolvedQuery(resolve("from spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects\norder by title\n", { schemaless: true, contextVariables: context }));
    expect(query.from).toEqual({ schema: "spaces/p9/ext/datatug", name: "projects" });
    expect(query.orderBy).toEqual([{ field: "title" }]);
  });

  it("substitutes declared parameters into the parent path and the collection name", () => {
    const result = resolve(queriesOfAProject, { schemaless: true, contextVariables: context, bindings: [{ name: "projectId", set: true, value: "proj1" }] });
    expect(resolvedQuery(result).from).toEqual({ schema: "spaces/p9/ext/datatug/projects/proj1", name: "queries" });
    const named = resolve("parameters (\n  @collection string required\n)\nfrom spaces/abc/{collection}\n", { schemaless: true, bindings: [{ name: "collection", set: true, value: "members" }] });
    expect(resolvedQuery(named).from).toEqual({ schema: "spaces/abc", name: "members" });
  });

  it("substitutes into an authorized schema's parent path", () => {
    const authorized = { version: "v2", schema: "spaces/p9/ext/datatug", tables: [{ name: "projects", fields: [{ name: "title", type: "string", authorized: true }] }] };
    const result = resolve("from spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects\n", { authorizedSchemas: [authorized], contextVariables: context });
    expect(resolvedQuery(result).from).toEqual({ schema: "spaces/p9/ext/datatug", name: "projects" });
    expect(result.resolved?.columns).toEqual([{ name: "title", type: "string", lineage: [{ source: "projects", field: "title" }] }]);
  });

  const refusals: readonly [unknown, string][] = [
    ["a/b", "projectId must be a single path segment (no /)"],
    ["..", "projectId must be a single path segment (not ..)"],
    [".", "projectId must be a single path segment (not .)"],
    ["__x__", "projectId must not match __.*__"],
    ["", "projectId has no value"],
  ];
  for (const [value, message] of refusals) {
    it(`refuses a projectId of ${JSON.stringify(value)}`, () => {
      expect(codes(resolve(queriesOfAProject, { schemaless: true, contextVariables: context, bindings: [{ name: "projectId", set: true, value }] })))
        .toEqual([{ code: "invalid_path_value", message }]);
    });
  }

  it("refuses a missing value, naming the variable", () => {
    expect(codes(resolve(queriesOfAProject, { schemaless: true, contextVariables: context })))
      .toEqual([{ code: "missing_required_binding", message: "required binding is missing: @projectId" }]);
    expect(codes(resolve("parameters (\n  @projectId string default ''\n)\nfrom projects/{projectId}/queries\n", { schemaless: true })))
      .toEqual([{ code: "invalid_path_value", message: "projectId has no value" }]);
    expect(codes(resolve("from spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects\n", { schemaless: true })))
      .toEqual([{ code: "invalid_path_value", message: "SneatUserPersonalSpaceID has no value" }]);
    expect(codes(resolve("from spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects\n", { schemaless: true, contextVariables: { SneatUserPersonalSpaceID: "" } })))
      .toEqual([{ code: "invalid_path_value", message: "SneatUserPersonalSpaceID has no value" }]);
    expect(codes(resolve("from spaces/{other}/projects\n", { schemaless: true })))
      .toEqual([{ code: "undeclared_parameter", message: "parameter is not declared: {other}" }]);
  });

  it("refuses an unsafe context variable value", () => {
    expect(codes(resolve("from spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects\n", { schemaless: true, contextVariables: { SneatUserPersonalSpaceID: "x/y" } })))
      .toEqual([{ code: "invalid_path_value", message: "SneatUserPersonalSpaceID must be a single path segment (no /)" }]);
  });

  it("refuses a non-string parameter value in a path", () => {
    expect(codes(resolve("parameters (\n  @n integer required\n)\nfrom spaces/{n}/items\n", { schemaless: true, bindings: [{ name: "n", set: true, value: 5 }] })))
      .toEqual([{ code: "invalid_path_value", message: "n must be a string to be used as a path segment" }]);
  });

  it("refuses a {name} that is not a whole segment in a tree-form source", () => {
    const tree = { format: "tugqtree", version: 1, query: { from: { schema: "a.{SneatUserID}", name: "x" } } } as const;
    expect(codes(resolveTugQL({ tree, sourceMetadata: { format: "tugql", version: 1 } }, { authorizedSchemas: [], relationships: [], pinnedImports: [], schemaless: true, contextVariables: context })))
      .toEqual([{ code: "invalid_substituted_segment", message: "{name} must be a whole path segment: \"a.{SneatUserID}\"" }]);
  });

  it("leaves a query without braces in its sources untouched", () => {
    const query = resolvedQuery(resolve("from spaces/abc/projects\nselect title\n", { schemaless: true }));
    expect(query.from).toEqual({ schema: "spaces/abc", name: "projects" });
  });

  it("substitutes in JOIN sources too", () => {
    const parsed = parseTugQL("from spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects as p\njoin spaces/{SneatUserPersonalSpaceID}/ext/datatug/members as m\n  on m.project = p.id\nselect p.id\n");
    expect(parsed.diagnostics).toEqual([]);
    const result = resolveTugQL(parsed.document, {
      authorizedSchemas: [], pinnedImports: [], schemaless: true, contextVariables: context,
      relationships: [{ id: "r", version: "1", from: { table: "members" }, to: { table: "projects" }, pairs: [{ fromField: "project", toField: "id" }], exactTypedEquality: true }],
    });
    const from = resolvedQuery(result).from as { readonly joins: readonly { readonly from: unknown }[] };
    expect(from.joins[0]?.from).toEqual({ schema: "spaces/p9/ext/datatug", name: "members", alias: "m" });
  });
});

describe("resolveTugQL schemaless", () => {
  it("refuses an unknown source without the schemaless option", () => {
    expect(codes(resolve("from users\nwhere nickname = 'x'\n"))).toEqual([{ code: "unauthorized_source", message: "source is not present in authorized schemas: users" }]);
  });

  it("accepts any source and field name", () => {
    const result = resolve("from users\nwhere nickname = 'x' and __key__ = @SneatUserID\norder by createdAt desc\nselect nickname, title as t\n", { schemaless: true, contextVariables: context });
    const query = resolvedQuery(result);
    expect(query.from).toEqual({ name: "users" });
    expect(query.columns).toEqual([{ field: "nickname" }, { field: "title", as: "t" }]);
    expect(result.resolved?.columns.map((column) => column.name)).toEqual(["nickname", "t"]);
  });

  it("keeps refusing ordered comparisons on an authorized field typed any without schemaless", () => {
    const typedAny = { version: "v1", tables: [{ name: "users", fields: [{ name: "id", type: "string", authorized: true }, { name: "n", type: "any", authorized: true }] }] };
    expect(codes(resolve("from users\nwhere n > 3\nselect id\n", { authorizedSchemas: [typedAny] })).map(({ code }) => code))
      .toEqual(["unsupported_comparison_type"]);
  });

  it("refuses numeric aggregates over schemaless fields", () => {
    expect(codes(resolve("from projects\nselect SUM(size) as total\n", { schemaless: true })).map(({ code }) => code))
      .toEqual(["unsupported_output_type"]);
  });

  it("allows ordered comparisons on fields of unknown type", () => {
    const query = resolvedQuery(resolve("from projects\nwhere title >= 'm'\n", { schemaless: true }));
    expect(query.where).toEqual({ left: { field: "title" }, op: ">=", right: { value: "m" } });
  });

  it("leaves the projection open when the query has no SELECT", () => {
    const result = resolve("from users\nwhere __key__ = @SneatUserID\n", { schemaless: true, contextVariables: context });
    const query = resolvedQuery(result);
    expect(query.columns).toBeUndefined();
    expect(result.resolved?.columns).toEqual([]);
  });

  it("ignores authorizedSchemas for sources", () => {
    const query = resolvedQuery(resolve("from users\nselect nickname\n", { schemaless: true, authorizedSchemas: [users] }));
    expect(query.columns).toEqual([{ field: "nickname" }]);
  });
});
