import { describe, expect, it } from "vitest";
import { executeRecordLookupPages, executeRecordLookups, key, type ExistingRecord, type LookupProgress, type QueryPage } from "../src/index.js";

describe("per-row lookup", () => {
  it("enriches 20,000 paged rows with cumulative progress", async () => {
    interface Row { id: number; population?: number }
    async function* pages(): AsyncIterable<QueryPage<Row>> {
      for (let start = 1; start <= 20_000; start += 500) {
        await Promise.resolve();
        yield { records: Array.from({ length: 500 }, (_, index) => ({ key: key("Invoice", start + index), exists: true as const, data: { id: start + index } })) };
      }
    }
    let count = 0;
    let last: LookupProgress | undefined;
    for await (const page of executeRecordLookupPages(pages(), {
      keyOf: (row) => row.data.id,
      fetch: async (id) => { await Promise.resolve(); return id; },
      merge: (row, population) => ({ ...row.data, population: Number(population) }),
      onProgress: (progress) => { last = progress; },
    })) {
      count += page.records.length;
      expect(page.records[0]?.data.population).toBe(page.records[0]?.data.id);
    }
    expect(count).toBe(20_000);
    expect(last).toEqual({ rowsLoaded: 20_000, requestsCompleted: 20_000, requestsInFlight: 0, requestsPending: 0 });
  });
  it("bounds HTTP concurrency, reports queue counts, and preserves source order", async () => {
    const rows: ExistingRecord<{ id: number; countryId: number; population?: number }>[] = Array.from({ length: 100 }, (_, index) => ({
      key: key("Invoice", index + 1), exists: true, data: { id: index + 1, countryId: index % 2 + 1 },
    }));
    let active = 0;
    let maxActive = 0;
    const progress: LookupProgress[] = [];
    const result = await executeRecordLookups(rows, {
      concurrency: 4,
      keyOf: (row) => row.data.countryId,
      fetch: async (countryId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return countryId === 1 ? 100 : 200;
      },
      merge: (row, population) => ({ ...row.data, population }),
      onProgress: (item) => progress.push(item),
    });
    expect(maxActive).toBe(4);
    expect(result[0]?.data.population).toBe(100);
    expect(result[1]?.data.population).toBe(200);
    expect(result[99]?.data.id).toBe(100);
    expect(progress[0]).toEqual({ rowsLoaded: 100, requestsCompleted: 0, requestsInFlight: 0, requestsPending: 100 });
    expect(progress.at(-1)).toEqual({ rowsLoaded: 100, requestsCompleted: 100, requestsInFlight: 0, requestsPending: 0 });
  });
  it("aborts sibling requests and stops dispatch after the first lookup failure", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ key: key("Invoice", index), exists: true as const, data: { id: index } }));
    const failure = new Error("lookup failed");
    const started: number[] = [];
    let siblingAborted = false;
    await expect(executeRecordLookups(rows, {
      concurrency: 2,
      keyOf: (row) => row.data.id,
      fetch: (id, signal) => {
        started.push(Number(id));
        if (id === 0) return Promise.reject(failure);
        return new Promise<number>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            siblingAborted = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("lookup aborted"));
          }, { once: true });
        });
      },
      merge: (row) => row.data,
    })).rejects.toBe(failure);
    expect(siblingAborted).toBe(true);
    expect(started).toEqual([0, 1]);
  });
});
