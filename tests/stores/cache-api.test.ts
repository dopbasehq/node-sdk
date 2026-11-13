import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheApiStore } from '../../src/stores/cache-api';

/** Just enough of CacheStorage to see what the store writes. */
function fakeCaches() {
  const entries = new Map<string, Response>();
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    put: async (url: string, response: Response) => void entries.set(url, response),
  };
  return { caches: { open: vi.fn(async () => cache) }, entries };
}

afterEach(() => vi.unstubAllGlobals());

describe('CacheApiStore', () => {
  it('is available only when caches exists', () => {
    expect(CacheApiStore.available()).toBe(false);
    vi.stubGlobal('caches', fakeCaches().caches);
    expect(CacheApiStore.available()).toBe(true);
  });

  it('stores bytes with a max-age and reads them back', async () => {
    const { caches, entries } = fakeCaches();
    vi.stubGlobal('caches', caches);
    const store = new CacheApiStore({ maxAgeSeconds: 600 });
    await store.set('abc123', new Uint8Array([1, 2, 3]));
    expect(await store.get('abc123')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.get('missing')).toBeNull();
    expect(entries.get('https://dopbase-sdk.cache/abc123')!.headers.get('cache-control')).toBe(
      'max-age=600',
    );
    expect(caches.open).toHaveBeenCalledTimes(1);
  });
});
