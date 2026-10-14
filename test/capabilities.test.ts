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
});
