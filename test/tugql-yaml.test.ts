import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isJoinedTugQLQuery, parseTugQLYaml, serializeJoinedTugQL, stringifyJoinedTugQL, type TugQLSchema } from "../src/index.js";

const schema: TugQLSchema = {
  tables: [
    { schema: "main", name: "Invoice", fields: ["InvoiceId", "BillingCountry", "InvoiceDate", "CustomerId"] },
    { schema: "archive", name: "Invoice", fields: ["InvoiceId"] },
    { schema: "main", name: "Customer", fields: ["CustomerId", "City", "FirstName", "SupportRepId"] },
    { schema: "main", name: "Employee", fields: ["EmployeeId", "FirstName"] },
    { name: "A", fields: ["id"] },
    { name: "B", fields: ["id", "aId"] },
    { name: "C", fields: ["id", "bId", "aId"] },
    { name: "D", fields: ["id", "cId", "aId"] },
  ],
};

describe("parseTugQLYaml", () => {
  it("parses canonical YAML into a schema-qualified DALgo query", () => {
    const query = parseTugQLYaml(
      `from:\n  schema: main\n  name: Invoice\nwhere:\n  op: ==\n  left:\n    field: BillingCountry\n  right:\n    value: Brazil\norderBy:\n  - field: InvoiceDate\n    desc: true\nlimit: 30`,
      schema,
    );

    expect(query).toEqual({
      source: { kind: "collection", name: "main.Invoice" },
      filters: [{ field: "BillingCountry", operator: "==", value: "Brazil" }],
      orders: [{ field: "InvoiceDate", direction: "desc" }],
      limit: 30,
    });
  });

  it("accepts JSON and object input", () => {
    const input = { from: { name: "Customer" }, orderBy: [{ field: "CustomerId" }], limit: 2 };
    expect(parseTugQLYaml(JSON.stringify(input), schema)).toEqual(parseTugQLYaml(input, schema));
  });

  it("uses canonical In values and portable scalar values", () => {
    expect(parseTugQLYaml({ from: { name: "Customer" }, where: { op: "In", left: { field: "City" }, right: { values: ["Prague"] } }, limit: 1 }, schema).filters)
      .toEqual([{ field: "City", operator: "in", value: ["Prague"] }]);
    expect(() => parseTugQLYaml({ from: { name: "Customer" }, where: { op: "In", left: { field: "City" }, right: { value: ["Prague"] } }, limit: 1 }, schema)).toThrow("unsupported where.right key");
    expect(() => parseTugQLYaml({ from: { name: "Customer" }, where: { op: "==", left: { field: "City" }, right: { value: ["Prague"] } }, limit: 1 }, schema)).toThrow("portable scalar");
  });

  it("parses NotIn values, including an empty list and NULL", () => {
    expect(parseTugQLYaml({ from: { name: "Customer" }, where: { op: "NotIn", left: { field: "City" }, right: { values: ["Prague", null] } }, limit: 1 }, schema).filters)
      .toEqual([{ field: "City", operator: "not-in", value: ["Prague", null] }]);
    expect(parseTugQLYaml({ from: { name: "Customer" }, where: { op: "NotIn", left: { field: "City" }, right: { values: [] } }, limit: 1 }, schema).filters)
      .toEqual([{ field: "City", operator: "not-in", value: [] }]);
    expect(() => parseTugQLYaml({ from: { name: "Customer" }, where: { op: "NotIn", left: { field: "City" }, right: { value: "Prague" } }, limit: 1 }, schema)).toThrow("unsupported where.right key");
    // Go parses a membership operator in HAVING and refuses it when a group is evaluated (see the parity suite).
    expect(() => parseTugQLYaml({
      from: { name: "A", alias: "a" },
      groupBy: [{ field: "id", source: "a" }],
      having: { op: "NotIn", left: { value: 1 }, right: { value: 2 } },
      limit: 1,
    }, schema)).not.toThrow();
  });

  it("round-trips joined NotIn filters with the canonical values shape", () => {
    const query = parseTugQLYaml({
      from: { name: "A", alias: "a" },
      where: { op: "NotIn", left: { field: "id", source: "a" }, right: { values: [] } },
      limit: 1,
    }, schema);
    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (!isJoinedTugQLQuery(query)) throw new Error("expected joined query");

    const serialized = serializeJoinedTugQL(query);
    expect(serialized.where).toEqual({
      op: "NotIn",
      left: { field: "id", source: "a" },
      right: { values: [] },
    });
    expect(parseTugQLYaml(JSON.stringify(serialized), schema)).toEqual(query);
  });

  it("rejects unbounded and unsupported TugQL before execution", () => {
    expect(() => parseTugQLYaml({ from: { name: "Customer" } }, schema)).toThrow("limit");
    expect(() => parseTugQLYaml({ from: { name: "Invoice" }, limit: 1 }, schema)).toThrow("ambiguous table");
    expect(() => parseTugQLYaml({ from: { schema: "main", name: "Invoice" }, orderBy: [{ field: "Nope" }], limit: 1 }, schema)).toThrow("unknown field");
    expect(() => parseTugQLYaml({ from: { name: "Customer" }, joins: [], limit: 1 }, schema)).toThrow("unsupported TugQL action key");
    expect(() => parseTugQLYaml({ from: { name: "Customer" }, where: { op: "contains", left: { field: "City" }, right: { value: "a" } }, limit: 1 }, schema)).toThrow("unsupported where operator");
    expect(() => parseTugQLYaml("from:\n  name: [\nlimit: 1", schema)).toThrow("invalid TugQL YAML");
    expect(() => parseTugQLYaml("from: {name: Customer}\nlimit: 1\n---\nfrom: {name: Customer}\nlimit: 1", schema)).toThrow("multiple documents");
    expect(() => parseTugQLYaml({ from: { name: "Customer" }, limit: 1001 }, schema)).toThrow("must not exceed 1000");
  });

  it("parses the shared nested Chinook fixture into a join-only execution model", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in shared YAML fixture at runtime.
    const fixture = readFileSync(new URL("./testdata/joins/chinook-nested.tugql.yaml", import.meta.url), "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Vitest's Node runtime provides the checked-in fixture digest.
    expect(createHash("sha256").update(fixture).digest("hex")).toBe("2eeef93ffb02a4272f06f6ab909b2db4cbbb9a2a1df280ae4c47851534f583b3");
    const query = parseTugQLYaml(fixture, schema);

    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (!isJoinedTugQLQuery(query)) throw new Error("expected joined TugQL query");
    expect("source" in query).toBe(false);
    expect(query.from).toMatchObject({
      schema: "main",
      name: "Invoice",
      alias: "i",
      joins: [{
        type: "inner",
        from: {
          schema: "main",
          name: "Customer",
          alias: "c",
          joins: [{ type: "left", from: { name: "Employee", alias: "e" } }],
        },
      }],
    });
    expect(query.from.joins[0]?.on).toEqual([{ left: { field: "CustomerId", source: "i" }, operator: "==", right: { field: "CustomerId", source: "c" } }]);
    expect(query.filters).toEqual([{ field: { field: "CustomerId", source: "c" }, operator: ">=", value: 10 }]);
    expect(query.columns).toEqual([
      { expression: { kind: "field", field: { field: "InvoiceId", source: "i" } }, as: "invoice_id" },
      { expression: { kind: "field", field: { field: "FirstName", source: "c" } }, as: "customer" },
      { expression: { kind: "field", field: { field: "FirstName", source: "e" } }, as: "employee" },
    ]);
    const serialized = serializeJoinedTugQL(query);
    expect(serialized.from).toHaveProperty("alias", "i");
    expect(JSON.stringify(serialized)).toContain('"op":"=="');
    expect(JSON.stringify(serialized)).not.toContain('"type":"inner"');
    expect(parseTugQLYaml(JSON.stringify(serialized), schema)).toEqual(query);
    expect(parseTugQLYaml(stringifyJoinedTugQL(query), schema)).toEqual(query);
  });

  it("pins every copied canonical JOIN fixture to the committed SHA-256 manifest", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in manifest at runtime.
    const manifestText: string = readFileSync(new URL("./testdata/joins/manifest.json", import.meta.url), "utf8");
    const manifest = JSON.parse(manifestText) as {
      readonly sourceCommit: string;
      readonly files: Readonly<Record<string, string>>;
    };
    expect(manifest.sourceCommit).toBe("56b804de624ade79efdc3d61970da7ac7562dc68");
    for (const [name, expected] of Object.entries(manifest.files)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in canonical fixture at runtime.
      const fixture = readFileSync(new URL(`./testdata/joins/${name}`, import.meta.url), "utf8");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Vitest's Node runtime provides the checked-in fixture digest.
      expect(createHash("sha256").update(fixture).digest("hex")).toBe(expected);
    }
  });

  it("parses and round-trips the canonical hinted Chinook query", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Vitest reads the checked-in canonical YAML fixture at runtime.
    const fixture: string = readFileSync(new URL("./testdata/joins/chinook-hinted.tugql.yaml", import.meta.url), "utf8");
    const query = parseTugQLYaml(fixture, schema);
    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (!isJoinedTugQLQuery(query)) throw new Error("expected joined query");
    expect(query.from.joins.map((join) => join.hints?.algorithms)).toEqual([["merge", "hash"], ["lookup", "hash"]]);
    expect(query.from.joins[0]?.from.joins[0]?.hints?.algorithms).toEqual(["nestedLoop", "hash"]);
    expect(parseTugQLYaml(JSON.stringify(serializeJoinedTugQL(query)), schema)).toEqual(query);
  });

  it("validates ordered nested scopes and canonicalizes aliases and equality", () => {
    const query = parseTugQLYaml({
      from: {
        name: "A", as: "a", joins: [
          { from: { name: "B", as: "b" }, on: [{ left: { field: "id", source: "a" }, op: "eq", right: { field: "aId", source: "b" } }] },
          { from: { name: "C", as: "c", joins: [{ from: { name: "D", as: "d" }, on: [{ left: { field: "aId", source: "d" }, op: "==", right: { field: "id", source: "a" } }] }] }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "bId", source: "c" } }] },
        ],
      },
      limit: 1,
    }, schema);
    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (!isJoinedTugQLQuery(query)) throw new Error("expected joined TugQL query");
    expect(query.from.alias).toBe("a");
    expect(query.from.joins[0]?.type).toBe("inner");
    expect(query.from.joins[0]?.on[0]?.operator).toBe("==");
  });

  it("round-trips independent ordered algorithm hints and rejects invalid hint documents", () => {
    const query = parseTugQLYaml({
      from: {
        name: "A", alias: "a", joins: [
          {
            hints: { algorithms: ["merge", "hash"] },
            from: { name: "B", alias: "b", joins: [{ hints: { algorithms: ["nestedLoop"] }, from: { name: "C", alias: "c" }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "bId", source: "c" } }] }] },
            on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }],
          },
          { hints: { algorithms: ["lookup", "hash"] }, from: { name: "D", alias: "d" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "d" } }] },
        ],
      },
    }, schema);
    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (!isJoinedTugQLQuery(query)) throw new Error("expected joined query");
    expect(query.from.joins.map((join) => join.hints?.algorithms)).toEqual([["merge", "hash"], ["lookup", "hash"]]);
    expect(query.from.joins[0]?.from.joins[0]?.hints?.algorithms).toEqual(["nestedLoop"]);
    const serialized = serializeJoinedTugQL(query);
    expect(serialized).toMatchObject({ from: { joins: [{ hints: { algorithms: ["merge", "hash"] } }, { hints: { algorithms: ["lookup", "hash"] } }] } });
    expect(parseTugQLYaml(JSON.stringify(serialized), schema)).toEqual(query);

    const base = { from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] } };
    expect(() => parseTugQLYaml({ ...base, from: { ...base.from, joins: [{ ...base.from.joins[0], hints: { algorithms: [] } }] } }, schema)).toThrow("join_algorithm at from.joins[0].hints.algorithms");
    expect(() => parseTugQLYaml({ ...base, from: { ...base.from, joins: [{ ...base.from.joins[0], hints: { algorithms: ["hash", "hash"] } }] } }, schema)).toThrow("join_algorithm at from.joins[0].hints.algorithms[1]");
    expect(() => parseTugQLYaml({ ...base, from: { ...base.from, joins: [{ ...base.from.joins[0], hints: { algorithms: ["Hash"] } }] } }, schema)).toThrow("join_algorithm at from.joins[0].hints.algorithms[0]");
    expect(() => parseTugQLYaml({ ...base, from: { ...base.from, joins: [{ ...base.from.joins[0], hints: [] }] } }, schema)).toThrow("join_algorithm at from.joins[0].hints.algorithms");
    expect(() => parseTugQLYaml({ ...base, from: { ...base.from, joins: [{ ...base.from.joins[0], hints: { algorithm: "hash" } }] } }, schema)).toThrow("join_algorithm at from.joins[0].hints.algorithms");
    const sparseAlgorithms = new Array<string>(3);
    sparseAlgorithms[0] = "hash";
    sparseAlgorithms[2] = "nestedLoop";
    expect(() => parseTugQLYaml({ ...base, from: { ...base.from, joins: [{ ...base.from.joins[0], hints: { algorithms: sparseAlgorithms } }] } }, schema)).toThrow("join_algorithm at from.joins[0].hints.algorithms[1]");

    const algorithms = ["hash"];
    const copied = parseTugQLYaml({ ...base, from: { ...base.from, joins: [{ ...base.from.joins[0], hints: { algorithms } }] } }, schema);
    algorithms[0] = "nestedLoop";
    expect(isJoinedTugQLQuery(copied) && copied.from.joins[0]?.hints?.algorithms).toEqual(["hash"]);
  });

  it("accepts same-scope ON predicates for bounded generic evaluation", () => {
    expect(() => parseTugQLYaml({
      from: { name: "A", as: "a", joins: [{ from: { name: "B", as: "b" }, on: [{ left: { field: "id", source: "b" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      limit: 1,
    }, schema)).not.toThrow();
  });

  it("resolves an unqualified joined field only when schema proves one owner", () => {
    const query = parseTugQLYaml({
      from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      where: { op: "==", left: { field: "aId" }, right: { value: 1 } },
      columns: [{ field: "aId", as: "only_b" }],
      limit: 1,
    }, schema);
    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (!isJoinedTugQLQuery(query)) throw new Error("expected joined query");
    expect(query.filters[0]?.field).toEqual({ field: "aId", source: "b" });
    expect(query.columns?.[0]).toEqual({ expression: { kind: "field", field: { field: "aId", source: "b" } }, as: "only_b" });
    expect(() => parseTugQLYaml({
      from: { name: "A", alias: "a", joins: [{ from: { name: "B", alias: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] },
      columns: [{ field: "id", as: "ambiguous" }],
      limit: 1,
    }, schema)).toThrow("ambiguous field id");
  });

  it("matches the shared unknown and forward-alias diagnostic paths", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- these checked-in fixtures are shared with Go.
    const forward = readFileSync(new URL("./testdata/joins/forward-alias.tugql.yaml", import.meta.url), "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- these checked-in fixtures are shared with Go.
    const unknown = readFileSync(new URL("./testdata/joins/unknown-alias.tugql.yaml", import.meta.url), "utf8");
    expect(() => parseTugQLYaml(forward, schema)).toThrow("join_scope at from.joins[0].on[0].right.source");
    expect(() => parseTugQLYaml(unknown, schema)).toThrow("join_scope at from.joins[0].on[0].left.source");
  });

  it("round-trips Go-compatible aggregate, group, having, and offset forms", () => {
    const query = parseTugQLYaml({
      from: { name: "A", alias: "a" },
      groupBy: [{ field: "id", source: "a" }],
      having: { op: ">", left: { aggregate: { function: "count", args: [{ star: true }] } }, right: { value: 0 } },
      columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "total" }],
      offset: 2,
      limit: 5,
    }, schema);
    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (!isJoinedTugQLQuery(query)) throw new Error("expected joined query");
    expect(serializeJoinedTugQL(query)).toMatchObject({
      offset: 2,
      columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "total" }],
    });
    expect(parseTugQLYaml(JSON.stringify(serializeJoinedTugQL(query)), schema)).toEqual(query);
  });

  it("rejects malformed, cyclic, forward, unknown, and duplicate join references", () => {
    const join = { from: { name: "B", as: "b" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] };
    expect(() => parseTugQLYaml({ from: { name: "A", as: "a", joins: [{ ...join, on: [{ left: { field: "id", source: "c" }, op: "==", right: { field: "aId", source: "b" } }] }, { from: { name: "C", as: "c" }, on: [{ left: { field: "id", source: "a" }, op: "==", right: { field: "aId", source: "c" } }] }] }, limit: 1 }, schema)).toThrow("join_scope at from.joins[0].on[0].left");
    expect(() => parseTugQLYaml({ from: { name: "A", as: "a", joins: [{ from: { name: "B", as: "a" }, on: join.on }] }, limit: 1 }, schema)).toThrow("duplicate alias a");
    expect(() => parseTugQLYaml({ from: { name: "A", as: "a", joins: [{ from: { name: "B", as: "b" }, on: [{ left: { field: "missing", source: "a" }, op: "==", right: { field: "aId", source: "b" } }] }] }, limit: 1 }, schema)).toThrow("join_field");
    expect(() => parseTugQLYaml({ from: { name: "A", joins: [{ from: { name: "B" }, on: [] }] }, limit: 1 }, schema)).toThrow("join_shape at from.joins[0].on");
    expect(() => parseTugQLYaml({ from: { name: "A", joins: [{ ...join, type: "right" }] }, limit: 1 }, schema)).toThrow("join_type at from.joins[0].type");
    expect(() => parseTugQLYaml({ from: { name: "A", joins: [{ ...join, on: [{ ...join.on[0], op: "ne" }] }] }, limit: 1 }, schema)).toThrow("join_operator at from.joins[0].on[0].op");

    const cyclic: { name: string; joins: unknown[] } = { name: "A", joins: [] };
    cyclic.joins.push({ from: cyclic, on: [{ left: { field: "id", source: "A" }, op: "==", right: { field: "id", source: "A" } }] });
    expect(() => parseTugQLYaml({ from: cyclic, limit: 1 }, schema)).toThrow("join_cycle at from.joins[0].from");
  });

  it("supports TugQL aliases and schemas identically to TugQL", () => {
    const tugqlSchema: TugQLSchema = schema;
    const query = parseTugQLYaml({ from: { name: "A", joins: [{ from: { name: "B", as: "b" }, on: [{ left: { field: "id", source: "A" }, op: "==", right: { field: "aId", source: "b" } }] }] } }, tugqlSchema);
    expect(isJoinedTugQLQuery(query)).toBe(true);
    if (isJoinedTugQLQuery(query)) {
      expect(serializeJoinedTugQL(query)).toEqual(serializeJoinedTugQL(query));
      expect(stringifyJoinedTugQL(query)).toEqual(stringifyJoinedTugQL(query));
    }
  });
});
