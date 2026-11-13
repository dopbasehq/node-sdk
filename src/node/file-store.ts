import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { PlatformInfo } from '../platform/detect';
import { readEnv } from '../platform/env';
import type { CacheStore } from '../stores/types';

/**
 * `DOPBASE_CACHE_DIR` if set. Otherwise `node_modules/.cache/dopbase` on a
 * server, and a per-user folder in the temp dir on serverless, where the app
 * directory is read-only.
 */
export function defaultCacheDir(platform: PlatformInfo): string {
  const configured = readEnv('DOPBASE_CACHE_DIR');
  if (configured) return configured;
  if (platform.longRunning) {
    const modules = join(process.cwd(), 'node_modules');
    if (existsSync(modules)) return join(modules, '.cache', 'dopbase');
  }
  // The temp dir is shared, so another user could create a fixed name first.
  return join(tmpdir(), `dopbase-${currentUser()}`);
}

function currentUser(): string {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  try {
    return userInfo().username.replace(/[^\w.-]/g, '_');
  } catch {
    return 'user';
  }
}

/** One encrypted file per host and token, readable by the current user only. */
export class FileStore implements CacheStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = this.#path(key);
    try {
      await this.#checkDir();
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await this.#checkDir();
    // Write then rename, so a reader never sees half a file.
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temp, value, { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** mkdir's mode doesn't apply to a folder that already exists, so check who owns it. */
  async #checkDir(): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const stats = await lstat(this.#dir);
    if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o002) !== 0) {
      throw new Error(`${this.#dir} must be a folder this user owns and others can't write to.`);
    }
  }

  #path(key: string): string {
    if (!/^[0-9a-f]+$/.test(key)) throw new Error('Store keys must be hex.');
    return join(this.#dir, `${key}.bin`);
  }
}
