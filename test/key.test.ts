import { describe, expect, it } from "vitest";
import { key } from "../src/index.js";

describe("Key", () => {
  it("builds Firestore-compatible hierarchical paths", () => {
    const space = key("spaces", "family-1");
    const item = space.child("items", "milk");

    expect(item.path).toBe("spaces/family-1/items/milk");
    expect(item.collectionPath).toBe("spaces/family-1/items");
  });

  it("uses the same reserved-character escaping as DALgo for Go", () => {
    expect(key("items", "a/b.$#[]").path).toBe("items/a%2Fb%2E%24%23%5B%5D");
  });

  it("rejects invalid segments", () => {
    expect(() => key("", "id")).toThrow("collection is required");
    expect(() => key("a/b", "id")).toThrow("single path segment");
    expect(() => key("items", "")).toThrow("record id is required");
  });
});
