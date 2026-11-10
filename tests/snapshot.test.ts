import { describe, expect, it } from 'vitest';
import { deriveCacheKeys } from '../src/crypto';
import { decodeState, diffValues, encodeState, toValues } from '../src/snapshot';
import { HOST, TOKEN } from './helpers/runtime';

const state = {
  snapshot: {
    projectId: 'prj_1',
    project: 'p',
    environment: 'e',
    environmentId: 'env_1',
    revision: 'r',
    entries: [{ key: 'A', value: 'secret' }],
  },
  etag: '"t"',
  fetchedAt: 1_700_000_000_000,
};

describe('stored state', () => {
  it('round-trips', async () => {
    const { key } = await deriveCacheKeys(HOST, TOKEN);
    expect(await decodeState(key, await encodeState(key, state))).toEqual(state);
  });

  it("can't be read with another token or host, or after tampering", async () => {
    const { key } = await deriveCacheKeys(HOST, TOKEN);
    const blob = await encodeState(key, state);
    const otherToken = await deriveCacheKeys(HOST, `dbs_${'b'.repeat(43)}`);
    const otherHost = await deriveCacheKeys('https://other.dev', TOKEN);
    expect(await decodeState(otherToken.key, blob)).toBeUndefined();
    expect(await decodeState(otherHost.key, blob)).toBeUndefined();
    const tampered = blob.slice();
    tampered[tampered.length - 1]! ^= 1;
    expect(await decodeState(key, tampered)).toBeUndefined();
  });

  it('gives each host and token its own store key', async () => {
    const a = await deriveCacheKeys(HOST, TOKEN);
    const b = await deriveCacheKeys('https://other.dev', TOKEN);
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.id).not.toBe(b.id);
  });
});

describe('values', () => {
  it('lets server values win over defaults', () => {
    expect(toValues([{ key: 'A', value: 's' }], { A: 'd', B: 'd' })).toEqual({ A: 's', B: 'd' });
  });

  it('keeps a key named __proto__ as a value', () => {
    const values = toValues([{ key: '__proto__', value: 'x' }], undefined);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.keys(values)).toEqual(['__proto__']);
  });

  it('diffs by key', () => {
    expect(diffValues({ A: '1', B: '1', C: '1' }, { A: '2', B: '1', D: '1' })).toEqual({
      added: ['D'],
      changed: ['A'],
      removed: ['C'],
    });
  });

  it('diffs keys that share a name with Object.prototype', () => {
    expect(diffValues({ toString: '1' }, { constructor: '1' })).toEqual({
      added: ['constructor'],
      changed: [],
      removed: ['toString'],
    });
  });
});
