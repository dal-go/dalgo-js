import { Key, type KeyId } from "./key.js";
import { QueryBuilder, type CollectionSource } from "./query.js";
import type { Codec } from "./record.js";

export interface CollectionOptions<T> {
  readonly parent?: Key;
  readonly codec?: Codec<T>;
}

export class Collection<T, Id extends KeyId = string> {
  public readonly source: CollectionSource<T>;

  public constructor(name: string, options: CollectionOptions<T> = {}) {
    if (name.trim().length === 0 || name.includes("/")) {
      throw new TypeError("collection name must be one non-empty path segment");
    }
    this.source = {
      kind: "collection",
      name,
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
    };
  }

  public key(id: Id): Key<Id> {
    return new Key(this.source.name, id, this.source.parent);
  }

  public in(parent: Key): Collection<T, Id> {
    return new Collection(this.source.name, {
      parent,
      ...(this.source.codec === undefined ? {} : { codec: this.source.codec }),
    });
  }

  public query(): QueryBuilder<T> {
    return new QueryBuilder(this.source);
  }
}

export function collection<T, Id extends KeyId = string>(
  name: string,
  options?: CollectionOptions<T>,
): Collection<T, Id> {
  return new Collection(name, options);
}

export function collectionGroup<T>(name: string, codec?: Codec<T>): QueryBuilder<T> {
  if (name.trim().length === 0 || name.includes("/")) {
    throw new TypeError("collection group name must be one non-empty path segment");
  }
  return new QueryBuilder({
    kind: "collection-group",
    name,
    ...(codec === undefined ? {} : { codec }),
  });
}
