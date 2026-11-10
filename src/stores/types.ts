/**
 * Where the SDK keeps an encrypted copy of the last good secrets. It's read
 * on a cold start (inside `ttl` instead of the server, otherwise to send the
 * stored ETag) and when the server can't be reached. Values arrive already
 * encrypted, so a store never sees plaintext.
 */
export interface CacheStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
}

export function isCacheStore(value: unknown): value is CacheStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CacheStore).get === 'function' &&
    typeof (value as CacheStore).set === 'function'
  );
}
