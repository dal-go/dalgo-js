import type { ExistingRecord } from "./record.js";
import type { QueryPage } from "./query.js";

export interface LookupProgress {
  readonly rowsLoaded: number;
  readonly requestsCompleted: number;
  readonly requestsInFlight: number;
  readonly requestsPending: number;
}

export interface RecordLookupOptions<T, V> {
  readonly concurrency?: number;
  readonly keyOf: (record: ExistingRecord<T>) => string | number;
  readonly fetch: (key: string | number, signal?: AbortSignal) => Promise<V>;
  readonly merge: (record: ExistingRecord<T>, value: V) => T;
  readonly onProgress?: (progress: LookupProgress) => void;
  readonly signal?: AbortSignal;
}

/** Applies an HTTP-style lookup per row with bounded concurrency and stable output order. */
export async function executeRecordLookups<T, V>(records: readonly ExistingRecord<T>[], options: RecordLookupOptions<T, V>): Promise<readonly ExistingRecord<T>[]> {
  const concurrency = options.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new RangeError("lookup concurrency must be 1..64");
  const output: (ExistingRecord<T> | undefined)[] = Array.from({ length: records.length }, () => undefined);
  let next = 0;
  let completed = 0;
  let inFlight = 0;
  const report = (): void => options.onProgress?.({ rowsLoaded: records.length, requestsCompleted: completed, requestsInFlight: inFlight, requestsPending: records.length - completed - inFlight });
  report();
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, async () => {
    while (next < records.length) {
      options.signal?.throwIfAborted();
      const index = next++;
      const row = records[index];
      if (row === undefined) throw new Error("missing lookup row");
      inFlight += 1;
      report();
      try {
        const value = await options.fetch(options.keyOf(row), options.signal);
        output[index] = { ...row, data: options.merge(row, value) };
        completed += 1;
      } finally {
        inFlight -= 1;
        report();
      }
    }
  }));
  return output.map((row) => {
    if (row === undefined) throw new Error("lookup result is missing");
    return row;
  });
}

/** Enriches paged source results with bounded in-flight requests and memory. */
export async function* executeRecordLookupPages<T, V>(pages: AsyncIterable<QueryPage<T>>, options: RecordLookupOptions<T, V>): AsyncIterable<QueryPage<T>> {
  let loaded = 0;
  let completed = 0;
  for await (const page of pages) {
    options.signal?.throwIfAborted();
    if (page.records.length > 1000) throw new RangeError("lookup source page exceeds 1000 rows");
    loaded += page.records.length;
    const enriched = await executeRecordLookups(page.records, {
      ...options,
      onProgress: (item) => options.onProgress?.({
        rowsLoaded: loaded,
        requestsCompleted: completed + item.requestsCompleted,
        requestsInFlight: item.requestsInFlight,
        requestsPending: item.requestsPending,
      }),
    });
    completed += enriched.length;
    yield { records: enriched, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  }
}
