import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultCacheDir, FileStore } from '../../src/node/file-store';

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('FileStore', () => {
  it('writes files only the owner can read, and reads them back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dopbase-test-'));
    const store = new FileStore(join(dir, 'cache'));
    expect(await store.get('abc')).toBeNull();
    await store.set('abc', new Uint8Array([9, 8, 7]));
    expect(await store.get('abc')).toEqual(new Uint8Array([9, 8, 7]));
    expect((await stat(join(dir, 'cache', 'abc.bin'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'cache'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(dir, 'cache'))).toEqual(['abc.bin']);
  });

  it('refuses keys that could escape the directory', async () => {
    await expect(new FileStore('/tmp/x').set('../etc', new Uint8Array())).rejects.toThrow();
  });

  it.skipIf(process.getuid === undefined)('refuses a folder other users can write to', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dopbase-test-'));
    await chmod(dir, 0o777);
    const store = new FileStore(dir);
    await expect(store.set('abc', new Uint8Array([1]))).rejects.toThrow(/others can't write/);
    await expect(store.get('abc')).rejects.toThrow(/others can't write/);
  });

  it('removes its temp file when the write fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dopbase-test-'));
    // A non-empty folder where the file should go makes the rename fail.
    await mkdir(join(dir, 'abc.bin', 'inside'), { recursive: true });
    await expect(new FileStore(dir).set('abc', new Uint8Array([1]))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['abc.bin']);
  });
});

describe('defaultCacheDir', () => {
  it('uses DOPBASE_CACHE_DIR, node_modules/.cache on a server, and a per-user temp dir on serverless', () => {
    vi.stubEnv('DOPBASE_CACHE_DIR', '');
    expect(defaultCacheDir({ name: 'server', longRunning: true, runtime: '' })).toBe(
      join(process.cwd(), 'node_modules', '.cache', 'dopbase'),
    );
    expect(defaultCacheDir({ name: 'serverless', longRunning: false, runtime: '' })).toBe(
      join(tmpdir(), `dopbase-${process.getuid?.() ?? userInfo().username}`),
    );
    vi.stubEnv('DOPBASE_CACHE_DIR', '/var/cache/app');
    expect(defaultCacheDir({ name: 'server', longRunning: true, runtime: '' })).toBe(
      '/var/cache/app',
    );
  });
});
