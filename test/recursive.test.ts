/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeRecursiveDTQLQuery, key, parseRecursiveDTQL, serializeRecursiveDTQL, type DTQLSchema, type QueryExecutor, type StructuredQuery } from "../src/index.js";

const root = new URL("./testdata/subqueries/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { readonly sourceCommit: string; readonly files: Readonly<Record<string, string>> };
const schemaDocument = JSON.parse(readFileSync(new URL("schema.json", root), "utf8")) as { readonly tables: Readonly<Record<string, readonly string[]>> };
const data = JSON.parse(readFileSync(new URL("dataset.json", root), "utf8")) as { readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>> };
const schema: DTQLSchema = { tables: Object.entries(schemaDocument.tables).map(([name, fields]) => ({ name, fields })) };

class MemoryExecutor implements QueryExecutor {
  public readonly calls: string[] = [];
  public async query<T>(query: StructuredQuery<T>) {
    if (query.source.kind !== "collection") throw new Error("unexpected source");
    this.calls.push(query.source.name);
    return { records: (data.tables[query.source.name] ?? []).map((value, index) => ({ key: key(query.source.name, index.toString()), exists: true as const, data: value as T })) };
  }
}

function fixture(name: string): string { return readFileSync(new URL(name, root), "utf8"); }

describe("recursive DTQL fixtures", () => {
  it("pins every vendored byte to the Go manifest and source commit", () => {
    expect(manifest.sourceCommit).toBe("da4e671be46e9c2c4906cb645d9e16c0fd90d590");
    expect(readdirSync(root).sort()).toContain("suite.json");
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(fixture(name)).digest("hex")).toBe(digest);
    }
  });

  it("executes scalar correlation, derived relations, and NULL-aware membership through leaf scans", async () => {
    for (const name of ["scalar-values", "derived-from-join", "membership-in", "membership-not-in", "pipeline-order-limit", "pipeline-order-offset", "customer-invoice-composition"] as const) {
      const query = parseRecursiveDTQL(fixture(`${name}.dtql.yaml`), schema);
      expect(serializeRecursiveDTQL(query)).toEqual(serializeRecursiveDTQL(parseRecursiveDTQL(JSON.stringify(serializeRecursiveDTQL(query)), schema)));
      const actual = (await executeRecursiveDTQLQuery(new MemoryExecutor(), query)).records.map((record) => record.data);
      const expected = JSON.parse(fixture(`${name}.rows.json`)) as unknown;
      expect(actual).toEqual(expected);
    }
  });

  it("keeps nested ASTs away from QueryExecutor after an abort", async () => {
    const controller = new AbortController(); controller.abort(new Error("stopped"));
    const executor = new MemoryExecutor();
    await expect(executeRecursiveDTQLQuery(executor, parseRecursiveDTQL(fixture("scalar-values.dtql.yaml"), schema), { signal: controller.signal })).rejects.toThrow("stopped");
    expect(executor.calls).toEqual([]);
  });
});
