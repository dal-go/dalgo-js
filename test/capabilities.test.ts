import { describe, expect, it } from "vitest";
import {
  isCapabilityAware,
  isResettable,
  type DatabaseCapabilities,
} from "../src/index.js";

const caps: DatabaseCapabilities = {
  read: true,
  query: true,
  write: true,
  delete: true,
  reset: true,
  persistent: false,
};

describe("isCapabilityAware", () => {
  it("accepts sync and async capabilities()", async () => {
    const sync = { capabilities: () => caps };
    const async_ = { capabilities: () => Promise.resolve(caps) };
    expect(isCapabilityAware(sync)).toBe(true);
    expect(isCapabilityAware(async_)).toBe(true);
    if (isCapabilityAware(async_)) {
      expect(await async_.capabilities()).toEqual(caps);
    }
  });

  it("rejects non-objects and missing or non-function members", () => {
    for (const value of [null, undefined, 1, "x", {}, { capabilities: caps }]) {
      expect(isCapabilityAware(value)).toBe(false);
    }
  });

  it("accepts class instances with a prototype method", () => {
    class Db {
      capabilities(): DatabaseCapabilities {
        return caps;
      }
    }
    const db = new Db();
    expect(isCapabilityAware(db)).toBe(true);
    if (isCapabilityAware(db)) {
      expect(db.capabilities()).toEqual(caps);
    }
  });

  it("accepts a capabilities getter that yields a method", () => {
    const db = {
      get capabilities() {
        return () => caps;
      },
    };
    expect(isCapabilityAware(db)).toBe(true);
  });

  it("accepts functions that carry capabilities()", () => {
    const db = Object.assign(() => undefined, { capabilities: () => caps });
    expect(isCapabilityAware(db)).toBe(true);
  });

  it("rejects functions without capabilities() or with a non-function member", () => {
    expect(isCapabilityAware(() => undefined)).toBe(false);
    expect(
      isCapabilityAware(Object.assign(() => undefined, { capabilities: caps })),
    ).toBe(false);
  });

  it("round-trips the optional OVDB keys", () => {
    const full: DatabaseCapabilities = {
      ...caps,
      joins: true,
      aggregation: false,
      dtql: true,
      dtqlStreaming: true,
      dtqlStreamingErrors: false,
    };
    const db = { capabilities: () => full };
    expect(isCapabilityAware(db)).toBe(true);
    if (isCapabilityAware(db)) {
      expect(db.capabilities()).toEqual(full);
    }
  });
});

describe("isResettable", () => {
  it("accepts an object with reset()", () => {
    expect(isResettable({ reset: () => Promise.resolve() })).toBe(true);
  });

  it("rejects non-objects and missing or non-function members", () => {
    for (const value of [null, undefined, 1, {}, { reset: true }]) {
      expect(isResettable(value)).toBe(false);
    }
  });

  it("accepts class instances with a prototype reset()", async () => {
    class Store {
      reset(): Promise<void> {
        return Promise.resolve();
      }
    }
    const store = new Store();
    expect(isResettable(store)).toBe(true);
    if (isResettable(store)) {
      await expect(store.reset()).resolves.toBeUndefined();
    }
  });

  it("accepts functions that carry reset()", () => {
    const fn = Object.assign(() => undefined, {
      reset: () => Promise.resolve(),
    });
    expect(isResettable(fn)).toBe(true);
  });

  it("rejects functions without reset() or with a non-function member", () => {
    expect(isResettable(() => undefined)).toBe(false);
    const fn = Object.assign(() => undefined, { reset: true });
    expect(isResettable(fn)).toBe(false);
  });

  it("reports reset() presence even when capabilities().reset is false", () => {
    const noReset: DatabaseCapabilities = { ...caps, reset: false };
    const db = {
      reset: () => Promise.resolve(),
      capabilities: () => noReset,
    };
    expect(isResettable(db)).toBe(true);
    expect(isCapabilityAware(db)).toBe(true);
  });
});
