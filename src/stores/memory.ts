import type { CacheStore } from './types';

/** Keeps entries in this process only. Useful in tests, or to share a copy between instances. */
export class MemoryStore implements CacheStore {
  readonly #entries = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.#entries.get(key) ?? null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#entries.set(key, value);
  }
}
