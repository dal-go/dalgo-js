import { describe, expect, it } from "vitest";
import { DOCUMENT_ID, collection, collectionGroup, key } from "../src/index.js";

interface Item {
  readonly done: boolean;
  readonly rank: number;
}

describe("QueryBuilder", () => {
  it("builds an immutable structured query", () => {
    const items = collection<Item>("items", { parent: key("spaces", "s1") });
    const base = items.query().where("done", "==", false);
    const page = base.orderBy("rank").orderBy(DOCUMENT_ID).limit(20);

    expect(base.build().orders).toEqual([]);
    expect(base.build()).not.toHaveProperty("limit");
    expect(page.build()).toMatchObject({
      source: { kind: "collection", name: "items", parent: { id: "s1" } },
      filters: [{ field: "done", operator: "==", value: false }],
      orders: [
        { field: "rank", direction: "asc" },
        { field: DOCUMENT_ID, direction: "asc" },
      ],
      limit: 20,
    });
  });

  it("supports collection-group and value cursors", () => {
    const query = collectionGroup<Item>("items")
      .orderBy("rank", "desc")
      .startAfter(42, "item-42")
      .limit(10)
      .build();

    expect(query.source.kind).toBe("collection-group");
    expect(query.startAfter?.values).toEqual([42, "item-42"]);
  });

  it("validates windows and cursors", () => {
    const query = collection<Item>("items").query();
    expect(() => query.limit(0)).toThrow("positive safe integer");
    expect(() => query.offset(-1)).toThrow("non-negative safe integer");
    expect(() => query.startAfter()).toThrow("at least one value");
  });
});
