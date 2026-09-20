import type { Key } from "./key.js";

export class DalgoError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DalgoError {
  public readonly key: Key;

  public constructor(key: Key, options?: ErrorOptions) {
    super(`record not found: ${key.path}`, options);
    this.key = key;
  }
}

export class AlreadyExistsError extends DalgoError {
  public readonly key: Key;

  public constructor(key: Key, options?: ErrorOptions) {
    super(`record already exists: ${key.path}`, options);
    this.key = key;
  }
}

export class UnsupportedError extends DalgoError {
  public readonly capability: string;

  public constructor(capability: string, options?: ErrorOptions) {
    super(`unsupported DALgo capability: ${capability}`, options);
    this.capability = capability;
  }
}
