import type { CacheStore } from '../stores/types';
import type { PlatformInfo } from './detect';

/**
 * What a platform entry point adds to the web core. Each published entry
 * (`node`, `workerd`) fills these in when it loads.
 */
export interface PlatformHooks {
  /** Reads an env var from a platform source, such as `cloudflare:workers`. */
  env?: (name: string) => string | undefined;
  /** A `waitUntil` the platform exposes globally. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The store to use when `fallback` doesn't name one. */
  defaultStore?: (context: { platform: PlatformInfo; maxAgeSeconds: number }) => CacheStore | null;
}

export const hooks: PlatformHooks = {};
