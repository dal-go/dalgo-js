export type KeyId = string | number;

const idEscapes: Readonly<Record<string, string>> = {
  ".": "%2E",
  "$": "%24",
  "#": "%23",
  "[": "%5B",
  "]": "%5D",
  "/": "%2F",
};

export function escapeId(id: KeyId): string {
  return String(id).replaceAll(/[.$#[\]/]/g, (character) => idEscapes[character] ?? character);
}

function validateCollection(collection: string): void {
  if (collection.trim().length === 0) {
    throw new TypeError("collection is required");
  }
  if (collection.includes("/")) {
    throw new TypeError("collection must be a single path segment");
  }
}

function validateId(id: KeyId): void {
  if (typeof id === "string" && id.length === 0) {
    throw new TypeError("record id is required");
  }
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new TypeError("numeric record id must be finite");
  }
}

export class Key<Id extends KeyId = KeyId> {
  public readonly collection: string;
  public readonly id: Id;
  public readonly parent: Key | undefined;

  public constructor(collection: string, id: Id, parent?: Key) {
    validateCollection(collection);
    validateId(id);
    this.collection = collection;
    this.id = id;
    this.parent = parent;
  }

  public get path(): string {
    const ownPath = `${this.collection}/${escapeId(this.id)}`;
    return this.parent === undefined ? ownPath : `${this.parent.path}/${ownPath}`;
  }

  public get collectionPath(): string {
    return this.parent === undefined
      ? this.collection
      : `${this.parent.path}/${this.collection}`;
  }

  public child<ChildId extends KeyId>(collection: string, id: ChildId): Key<ChildId> {
    return new Key(collection, id, this);
  }

  public toString(): string {
    return this.path;
  }
}

export function key<Id extends KeyId>(collection: string, id: Id, parent?: Key): Key<Id> {
  return new Key(collection, id, parent);
}
