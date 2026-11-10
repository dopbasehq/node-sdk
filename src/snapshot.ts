import { open, seal } from './crypto';
import { type RuntimeSnapshot, type SecretEntry, validateSnapshot } from './validate';

/** What the SDK holds, and what a store keeps (encrypted). */
export interface StoredState {
  snapshot: RuntimeSnapshot;
  etag: string | null;
  /** When the server last confirmed these values, in ms since the epoch. */
  fetchedAt: number;
}

export interface ChangeSet {
  added: string[];
  changed: string[];
  removed: string[];
}

const RECORD_VERSION = 1;

export function toValues(
  entries: readonly SecretEntry[],
  defaults: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const values: Record<string, string> = { ...defaults };
  for (const { key, value } of entries) {
    // Not `values[key] =`, which would set the prototype for a key named __proto__.
    Object.defineProperty(values, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return values;
}

/** Key names only: values never leave the SDK through a change event's diff. */
export function diffValues(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): ChangeSet {
  const changes: ChangeSet = { added: [], changed: [], removed: [] };
  // Object.hasOwn, not `in`: keys such as toString exist on every object's prototype.
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) changes.added.push(key);
    else if (before[key] !== after[key]) changes.changed.push(key);
  }
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) changes.removed.push(key);
  }
  return changes;
}

export function hasChanges(changes: ChangeSet): boolean {
  return changes.added.length + changes.changed.length + changes.removed.length > 0;
}

export async function encodeState(key: CryptoKey, state: StoredState): Promise<Uint8Array> {
  const json = JSON.stringify({ v: RECORD_VERSION, ...state });
  return seal(key, new TextEncoder().encode(json));
}

/** `undefined` for anything that doesn't decrypt or doesn't look like a record. */
export async function decodeState(
  key: CryptoKey,
  blob: Uint8Array,
): Promise<StoredState | undefined> {
  try {
    const record = JSON.parse(new TextDecoder().decode(await open(key, blob))) as Record<
      string,
      unknown
    >;
    if (record.v !== RECORD_VERSION || typeof record.fetchedAt !== 'number') return undefined;
    const etag = typeof record.etag === 'string' ? record.etag : null;
    return { snapshot: validateSnapshot(record.snapshot), etag, fetchedAt: record.fetchedAt };
  } catch {
    return undefined;
  }
}
