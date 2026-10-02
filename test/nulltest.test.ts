import { describe, expect, it } from "vitest";
import {
  executeJoinedDTQLQuery,
  executeRecursiveDTQLQuery,
  isJoinedDTQLQuery,
  key,
  parseDTQL,
  parseRecursiveDTQL,
  serializeJoinedDTQL,
  serializeRecursiveDTQL,
  stringifyJoinedDTQL,
  stringifyRecursiveDTQL,
  type DTQLSchema,
  type ExistingRecord,
  type JoinedDTQLQuery,
  type QueryExecutor,
  type QueryRelation,
  type StructuredQuery,
} from "../src/index.js";

/*
 * `isNull` / `isNotNull`: explicit null tests. Comparisons in a joined,
 * aggregated or nested query are three-valued (`x == null` matches nothing), so
 * these are the way to select or exclude nulls there. Go is the reference; the
 * Go-generated cases live in test/parity/cases/19-null-tests.json.
 */

type Data = Record<string, unknown>;

const tables: Record<string, readonly Data[]> = {
  Chat: [
    { id: 1, Company: null, Region: "eu" },
    { id: 2, Company: "acme", Region: null },
    { id: 3, Region: "us" },
  ],
  Invoice: [
    { id: 10, chat: 1, total: 5 },
    { id: 11, chat: 1, total: null },
    { id: 12, chat: 2, total: 7 },
  ],
};
const schema: DTQLSchema = { tables: Object.entries(tables).map(([name, rows]) => ({ name, fields: [...new Set(rows.flatMap((row) => Object.keys(row)))] })) };

function records(name: string): ExistingRecord<Data>[] {
  return (tables[name] ?? []).map((data, index) => ({ key: key(name, String(index)), exists: true as const, data: { ...data } }));
}

const executor: QueryExecutor = {
  query: <T>(query: StructuredQuery<T>) => Promise.resolve({ records: records(query.source.name) as unknown as readonly ExistingRecord<T>[] }),
};

const join = `from:
  name: Chat
  alias: c
  joins:
    - type: left
      from: {name: Invoice, alias: i}
      on: [{left: {field: id, source: c}, op: '==', right: {field: chat, source: i}}]
`;

function parse(document: string): JoinedDTQLQuery {
  const query = parseDTQL(document, schema);
  if (!isJoinedDTQLQuery(query)) throw new Error("expected the relation model");
  return query;
}

async function run(document: string, streaming = false): Promise<Data[]> {
  const options = {
    schema,
    resolveExecutor: () => executor,
    ...(streaming ? { scanPages: async function* (relation: QueryRelation) { await Promise.resolve(); yield { records: records(relation.name) }; } } : {}),
  };
  return (await executeJoinedDTQLQuery(executor, parse(document), options)).records.map((row) => row.data);
}

const ids = (rows: readonly Data[]): unknown[] => rows.map((row) => row.id).sort();

describe("null tests: parsing and serialization", () => {
  const documents: Record<string, string> = {
    "where isNull": `${join}where:\n  isNull: {field: Company, source: c}\n`,
    "where isNotNull": `${join}where:\n  isNotNull: {field: Company, source: c}\n`,
    "group": `${join}where:\n  and:\n    - isNull: {field: Company, source: c}\n    - or:\n        - isNotNull: {field: chat, source: i}\n        - {op: '==', left: {field: Region, source: c}, right: {value: eu}}\n`,
    "having": `from: {name: Invoice, alias: i}\ngroupBy: [{field: chat, source: i}]\nhaving:\n  isNotNull: {aggregate: {function: max, args: [{field: total, source: i}]}}\ncolumns: [{field: chat, source: i}]\n`,
    "expression operand": `${join}where:\n  isNull: {binary: {op: '+', left: {field: id, source: c}, right: {field: total, source: i}}}\n`,
  };

  it.each(Object.entries(documents))("round-trips %s through YAML and JSON", (_name, document) => {
    const query = parse(document);
    expect(parseDTQL(stringifyJoinedDTQL(query), schema)).toEqual(query);
    expect(parseDTQL(JSON.stringify(serializeJoinedDTQL(query)), schema)).toEqual(query);
  });

  it("models the tests as null-test conditions, not comparisons", () => {
    expect(parse(documents["where isNull"] ?? "").filters).toEqual([{ kind: "is-null", operand: { kind: "field", field: { field: "Company", source: "c" } } }]);
    expect(parse(documents["where isNotNull"] ?? "").filters).toEqual([{ kind: "is-not-null", operand: { kind: "field", field: { field: "Company", source: "c" } } }]);
    expect(serializeJoinedDTQL(parse(documents["where isNull"] ?? "")).where).toEqual({ isNull: { field: "Company", source: "c" } });
    expect(serializeJoinedDTQL(parse(documents.having ?? "")).having).toEqual({ isNotNull: { aggregate: { function: "max", args: [{ field: "total", source: "i" }] } } });
  });

  it("accepts the same documents Go accepts and rejects the ones it rejects at parse", () => {
    const rejected: Record<string, string> = {
      "an empty operand": "isNull: {}",
      "a scalar operand": "isNull: Company",
      "both null tests": "isNull: {field: Company, source: c}\n  isNotNull: {field: Company, source: c}",
      "a null test and a comparison": "isNull: {field: Company, source: c}\n  op: '=='\n  left: {field: id, source: c}\n  right: {value: 1}",
      "a null test and a group": "isNull: {field: Company, source: c}\n  and: [{isNull: {field: Company, source: c}}]",
      "an unknown alias": "isNull: {field: Company, source: zzz}",
      "two expression forms": "isNull: {field: Company, source: c, value: 1}",
      "an unknown key": "isNull: {field: Company, source: c, bogus: 1}",
      "an explicit null alone": "isNull: null",
    };
    for (const [name, where] of Object.entries(rejected)) {
      expect(() => parseDTQL(`${join}where:\n  ${where}\n`, schema), name).toThrow(TypeError);
    }
    // An explicit null is absent, so the comparison beside it stands alone, as in Go.
    expect(parse(`${join}where:\n  isNull: null\n  op: '=='\n  left: {field: id, source: c}\n  right: {value: 1}\n`).filters).toHaveLength(1);
    expect(() => parseDTQL(`from: {name: Chat, alias: c, joins: [{from: {name: Invoice, alias: i}, on: [{isNull: {field: chat, source: i}}]}]}\n`, schema)).toThrow("on[0]");
  });

  it("parses a null test on a bare single source into the relation model, since the legacy filter cannot carry one", () => {
    for (const test of ["isNull", "isNotNull"]) {
      const query = parseDTQL(`from: {name: Chat}\nwhere:\n  ${test}: {field: Company}\nlimit: 10\n`, schema);
      expect(isJoinedDTQLQuery(query)).toBe(true);
      expect(query).toMatchObject({ kind: "joined-dtql", from: { name: "Chat", joins: [] }, limit: 10 });
      expect(query).not.toHaveProperty("source");
    }
    const grouped = parseDTQL("from: {name: Chat}\nwhere:\n  and:\n    - isNull: {field: Company}\n    - {op: ==, left: {field: Region}, right: {value: eu}}\n", schema);
    expect(isJoinedDTQLQuery(grouped)).toBe(true);
    // Without a null test the bare source stays the legacy model, groups included in what it refuses.
    expect(isJoinedDTQLQuery(parseDTQL("from: {name: Chat}\nwhere: {op: ==, left: {field: Company}, right: {value: a}}\nlimit: 10\n", schema))).toBe(false);
    expect(() => parseDTQL("from: {name: Chat}\nwhere:\n  and:\n    - {op: ==, left: {field: Company}, right: {value: a}}\nlimit: 10\n", schema)).toThrow("require an aliased or joined relation model");
  });

  it("rejects operands a null test cannot have, with the path of the test, as Go does", () => {
    const bad: [string, string][] = [
      ["{values: [1, 2]}", "query_shape at where.isNull: a values list"],
      ["{star: true}", "query_shape at where.isNull: star"],
      ["{param: who}", "query_shape at where.isNull: a param"],
      ["{aggregate: {function: max, args: [{field: total, source: i}]}}", "query_shape at where.isNull: an aggregate has no value in where"],
      ["{binary: {op: +, left: {value: 1}, right: {values: [1]}}}", "a values list"],
      ["{binary: {op: +, left: {star: true}, right: {value: 1}}}", "star is not a value"],
    ];
    for (const [operand, message] of bad) {
      expect(() => parseDTQL(`${join}where: {isNull: ${operand}}\ncolumns: [{field: id, source: c}]\n`, schema), operand).toThrow(message);
    }
    expect(() => parseDTQL(`${join}where:\n  and:\n    - isNull: {field: Company, source: c}\n    - or:\n        - isNotNull: {param: p}\ncolumns: [{field: id, source: c}]\n`, schema)).toThrow("query_shape at where.and[1].or[0].isNotNull: a param");
    expect(() => parseDTQL(`${join}groupBy: [{field: Region, source: c}]\nhaving: {isNull: {star: true}}\ncolumns: [{field: Region, source: c}]\n`, schema)).toThrow("query_shape at having.isNull: star");
    // An aggregate is fine in having, alone or inside arithmetic.
    expect(() => parseDTQL(`${join}groupBy: [{field: Region, source: c}]\nhaving: {isNull: {binary: {op: /, left: {aggregate: {function: sum, args: [{field: total, source: i}]}}, right: {aggregate: {function: count, args: [{star: true}]}}}}}\ncolumns: [{field: Region, source: c}]\n`, schema)).not.toThrow();
  });
});

describe.each([["generic executor", false], ["streaming scanPages executor", true]] as const)("null tests: execution (%s)", (_label, streaming) => {
  it("keeps three-valued comparisons: == null in a joined WHERE matches nothing", async () => {
    expect(await run(`${join}where: {op: '==', left: {field: Company, source: c}, right: {value: null}}\ncolumns: [{field: id, source: c}]\n`, streaming)).toEqual([]);
  });

  it("selects null and missing fields with isNull, and the rest with isNotNull", async () => {
    const columns = "columns: [{field: id, source: c}]\n";
    expect(ids(await run(`${join}where: {isNull: {field: Company, source: c}}\n${columns}`, streaming))).toEqual([1, 1, 3]);
    expect(ids(await run(`${join}where: {isNotNull: {field: Company, source: c}}\n${columns}`, streaming))).toEqual([2]);
  });

  it("runs a null test on a bare single source through the join-aware executor, a missing field counting as null", async () => {
    const bare = async (where: string): Promise<unknown[]> => ids(await run(`from: {name: Chat}\nwhere:\n  ${where}\ncolumns: [{field: id}]\nlimit: 10\n`, streaming));
    expect(await bare("isNull: {field: Company}")).toEqual([1, 3]);
    expect(await bare("isNotNull: {field: Company}")).toEqual([2]);
    expect(await bare("or: [{isNull: {field: Company}}, {op: ==, left: {field: Region}, right: {value: eu}}]")).toEqual([1, 3]);
    expect(await bare("and: [{isNotNull: {field: Company}}, {isNull: {field: Region}}]")).toEqual([2]);
  });

  it("finds the null-extended side of a LEFT JOIN (an anti-join)", async () => {
    expect(ids(await run(`${join}where: {isNull: {field: chat, source: i}}\ncolumns: [{field: id, source: c}]\n`, streaming))).toEqual([3]);
  });

  it("is two-valued inside and/or groups", async () => {
    const columns = "columns: [{field: id, source: c}]\n";
    expect(ids(await run(`${join}where:\n  or:\n    - {op: '==', left: {field: Company, source: c}, right: {value: null}}\n    - {isNull: {field: Company, source: c}}\n${columns}`, streaming))).toEqual([1, 1, 3]);
    expect(ids(await run(`${join}where:\n  and:\n    - {isNull: {field: Company, source: c}}\n    - {isNotNull: {field: total, source: i}}\n${columns}`, streaming))).toEqual([1]);
  });

  it("tests arithmetic and literal operands as Go does", async () => {
    const columns = "columns: [{field: id, source: c}]\n";
    expect(ids(await run(`${join}where: {isNull: {binary: {op: '*', left: {field: id, source: c}, right: {field: total, source: i}}}}\n${columns}`, streaming))).toEqual([1, 3]);
    expect(await run(`${join}where: {isNull: {value: null}}\n${columns}`, streaming)).toHaveLength(4);
    expect(await run(`${join}where: {isNotNull: {value: 0}}\n${columns}`, streaming)).toHaveLength(4);
  });

  it("applies null tests to groups in HAVING", async () => {
    const grouped = (having: string): string => `${join}groupBy: [{field: Region, source: c}]\nhaving: ${having}\ncolumns:\n  - {field: Region, source: c}\n  - {aggregate: {function: count, args: [{star: true}]}, as: n}\norderBy: [{field: Region, source: c}]\n`;
    expect(await run(grouped("{isNull: {field: Region, source: c}}"), streaming)).toEqual([{ Region: null, n: 1 }]);
    expect(await run(grouped("{isNotNull: {field: Region, source: c}}"), streaming)).toEqual([{ Region: "eu", n: 2 }, { Region: "us", n: 1 }]);
    expect(await run(grouped("{isNull: {aggregate: {function: max, args: [{field: total, source: i}]}}}"), streaming)).toEqual([{ Region: "us", n: 1 }]);
    expect(await run(grouped("{or: [{isNull: {field: Region, source: c}}, {isNotNull: {aggregate: {function: sum, args: [{field: total, source: i}]}}}]}"), streaming)).toEqual([{ Region: null, n: 1 }, { Region: "eu", n: 2 }]);
  });

  it("rejects an ungrouped field in a HAVING null test at parse, like any HAVING operand", () => {
    expect(() => parse(`${join}groupBy: [{field: Region, source: c}]\nhaving: {isNull: {field: total, source: i}}\ncolumns: [{field: Region, source: c}]\n`)).toThrow("neither an aggregate");
  });
});

describe("null tests: recursive queries", () => {
  const recursiveSchema: DTQLSchema = { tables: Object.entries(tables).map(([name, rows]) => ({ name, fields: [...new Set(rows.flatMap((row) => Object.keys(row)))] })) };
  const runRecursive = async (document: string): Promise<Data[]> => (await executeRecursiveDTQLQuery(executor, parseRecursiveDTQL(document, recursiveSchema))).records.map((row) => row.data);

  it("evaluates isNull and isNotNull in WHERE, inside groups and inside a nested query", async () => {
    expect(ids(await runRecursive("from: {name: Chat, alias: c}\nwhere: {isNull: {field: Company, source: c}}\n"))).toEqual([1, 3]);
    expect(ids(await runRecursive("from: {name: Chat, alias: c}\nwhere: {isNotNull: {field: Company, source: c}}\n"))).toEqual([2]);
    expect(ids(await runRecursive("from: {name: Chat, alias: c}\nwhere:\n  or:\n    - {op: '==', left: {field: Company, source: c}, right: {value: null}}\n    - {isNull: {field: Company, source: c}}\n"))).toEqual([1, 3]);
    // Chats that have an invoice without a total.
    const exists = `from: {name: Chat, alias: c}
where:
  exists:
    query:
      from: {name: Invoice, alias: i}
      where:
        and:
          - {op: '==', left: {field: chat, source: i}, right: {field: id, source: c}}
          - {isNull: {field: total, source: i}}
`;
    expect(ids(await runRecursive(exists))).toEqual([1]);
  });

  it("rejects operands a null test cannot have, as parseDTQL does", () => {
    for (const operand of ["{values: [1]}", "{star: true}", "{aggregate: {function: max, args: [{field: total, source: i}]}}"]) {
      expect(() => parseRecursiveDTQL(`from: {name: Invoice, alias: i}\nwhere: {isNull: ${operand}}\n`, recursiveSchema), operand).toThrow("shape at root.where.isNull");
    }
    expect(() => parseRecursiveDTQL("from: {name: Invoice, alias: i}\nwhere:\n  and:\n    - isNotNull: {star: true}\n", recursiveSchema)).toThrow("shape at root.where.and[0].isNotNull: star");
    expect(() => parseRecursiveDTQL("from: {name: Invoice, alias: i}\nwhere:\n  exists:\n    query:\n      from: {name: Chat, alias: c}\n      where: {isNull: {values: [1]}}\n", recursiveSchema)).toThrow("where.isNull: a values list");
    expect(() => parseRecursiveDTQL("from: {name: Invoice, alias: i}\nhaving: {isNull: {star: true}}\n", recursiveSchema)).toThrow("shape at root.having.isNull");
    expect(() => parseRecursiveDTQL("from: {name: Invoice, alias: i}\nhaving: {isNull: {aggregate: {function: max, args: [{field: total, source: i}]}}}\n", recursiveSchema)).not.toThrow();
  });

  it("treats a scalar subquery operand that returns no row as null", async () => {
    const document = `from: {name: Chat, alias: c}
where:
  isNull:
    query:
      as: first_invoice
      from: {name: Invoice, alias: i}
      where: {op: '==', left: {field: chat, source: i}, right: {field: id, source: c}, }
      columns: [{field: total, source: i}]
      limit: 1
`;
    expect(ids(await runRecursive(document))).toEqual([3]);
  });

  it("evaluates a null test in HAVING over the group", async () => {
    const document = "from: {name: Invoice, alias: i}\nhaving: {isNull: {aggregate: {function: max, args: [{field: total, source: i}]}}}\n";
    expect(await runRecursive(document)).toEqual([]);
    expect(await runRecursive(document.replace("isNull", "isNotNull"))).toHaveLength(1);
  });

  it("round-trips and rejects malformed null tests", () => {
    const query = parseRecursiveDTQL("from: {name: Chat, alias: c}\nwhere:\n  and:\n    - {isNull: {field: Company, source: c}}\n    - {isNotNull: {field: Region, source: c}}\n", recursiveSchema);
    expect(parseRecursiveDTQL(stringifyRecursiveDTQL(query), recursiveSchema)).toEqual(query);
    expect(parseRecursiveDTQL(JSON.stringify(serializeRecursiveDTQL(query)), recursiveSchema)).toEqual(query);
    expect(() => parseRecursiveDTQL("from: {name: Chat, alias: c}\nwhere: {isNull: {field: Company, source: c}, isNotNull: {field: Company, source: c}}\n", recursiveSchema)).toThrow("unsupported key isNotNull");
    expect(() => parseRecursiveDTQL("from: {name: Chat, alias: c}\nwhere: {isNull: {field: Company, source: zzz}}\n", recursiveSchema)).toThrow();
    expect(() => parseRecursiveDTQL("from: {name: Chat, alias: c}\nwhere: {isNull: {}}\n", recursiveSchema)).toThrow("unknown expression");
  });
});
