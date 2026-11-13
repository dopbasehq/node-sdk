import { type Duration, parseDuration } from './duration';
import { DopbaseConfigError } from './errors';
import type { PlatformInfo } from './platform/detect';
import { readEnv } from './platform/env';
import type { StandardSchemaV1 } from './standard-schema';
import type { CacheStore } from './stores/types';

export type RefreshMode = 'auto' | 'once' | 'poll' | 'ttl';

export interface Logger {
  debug?(message: string): void;
  warn?(message: string): void;
}

export interface FallbackOptions {
  /** Where to keep the encrypted copy. `false` keeps it in memory only. */
  store?: CacheStore | false;
  /** How old a stored copy may be and still be used when the server is down. Default `'7d'`. */
  maxAge?: Duration;
}

export interface DopbaseOptions<T = Record<string, string | undefined>> {
  /** The Dopbase server. Defaults to `DOPBASE_HOST`, then `DOPBASE_URL`. */
  host?: string;
  /** A runner token. Defaults to `DOPBASE_TOKEN`. */
  token?: string;
  /** The environment you expect the token to belong to (`env_…` or `project/env`). Defaults to `DOPBASE_ENV`. */
  env?: string;
  /** How values stay fresh. `'auto'` picks `'poll'` on servers and `'ttl'` on serverless and edge. */
  refresh?: RefreshMode;
  /** How often `'poll'` checks for changes. Default `'5m'`, minimum `'15s'`. */
  interval?: Duration;
  /** How long `'ttl'` trusts values before checking again. Default `'60s'`. */
  ttl?: Duration;
  /** How stale `'ttl'` lets values get before `load()` waits for fresh ones. Default `'10m'`, or `ttl` if longer. */
  maxStale?: Duration;
  /** Timeout for each request. Default `'5s'`. */
  timeout?: Duration;
  /** Retries after a network error, 5xx, 408 or 429. Default `2`. */
  retries?: number;
  /** Any Standard Schema (zod, valibot, arktype) to check and type the values. */
  schema?: StandardSchemaV1<any, T>;
  /** Values for keys the server doesn't return. */
  defaults?: Record<string, string>;
  /** The encrypted last-known-good copy. `false` turns it off. */
  fallback?: false | CacheStore | FallbackOptions;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
}

export interface ResolvedConfig {
  /** The server's origin plus any base path, without a trailing slash. */
  baseUrl: string;
  endpoint: string;
  token: string;
  reference: string | undefined;
  refresh: 'once' | 'poll' | 'ttl';
  intervalMs: number;
  ttlMs: number;
  maxStaleMs: number;
  timeoutMs: number;
  retries: number;
  fallbackMaxAgeMs: number;
}

const KNOWN_OPTIONS = new Set([
  'host',
  'token',
  'env',
  'refresh',
  'interval',
  'ttl',
  'maxStale',
  'timeout',
  'retries',
  'schema',
  'defaults',
  'fallback',
  'fetch',
  'logger',
]);
const TOKEN_PATTERN = /^dbs_[A-Za-z0-9_-]{43}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MIN_INTERVAL_MS = 15_000;
const DEFAULT_MAX_STALE_MS = 10 * 60_000;
export const RUNTIME_PATH = '/api/v1/runtime/secrets';

export function resolveConfig(
  options: DopbaseOptions<any>,
  platform: PlatformInfo,
): ResolvedConfig {
  if (typeof options !== 'object' || options === null) {
    throw new DopbaseConfigError('Options must be an object.');
  }
  const unknown = Object.keys(options).filter((key) => !KNOWN_OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new DopbaseConfigError(
      `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
    );
  }

  const baseUrl = normalizeHost(options.host ?? readEnv('DOPBASE_HOST') ?? readEnv('DOPBASE_URL'));
  const token = checkToken(options.token ?? readEnv('DOPBASE_TOKEN'));
  const reference = options.env ?? readEnv('DOPBASE_ENV');
  const endpoint =
    baseUrl + RUNTIME_PATH + (reference ? `?reference=${encodeURIComponent(reference)}` : '');

  const refresh = resolveRefresh(options.refresh, platform);
  const intervalMs = parseDuration(options.interval ?? '5m', 'interval');
  if (intervalMs < MIN_INTERVAL_MS) {
    throw new DopbaseConfigError("interval must be at least '15s'.");
  }
  const ttlMs = parseDuration(options.ttl ?? '60s', 'ttl');
  // Unset, it grows with ttl, so `ttl: '1h'` alone is enough.
  const maxStaleMs =
    options.maxStale === undefined
      ? Math.max(DEFAULT_MAX_STALE_MS, ttlMs)
      : parseDuration(options.maxStale, 'maxStale');
  if (maxStaleMs < ttlMs) {
    throw new DopbaseConfigError('maxStale must be at least as long as ttl.');
  }
  const timeoutMs = parseDuration(options.timeout ?? '5s', 'timeout');
  if (timeoutMs <= 0) throw new DopbaseConfigError('timeout must be more than 0.');
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new DopbaseConfigError('retries must be a whole number from 0 to 5.');
  }
  const fallback = options.fallback;
  const maxAge =
    typeof fallback === 'object' && fallback !== null && 'maxAge' in fallback
      ? fallback.maxAge
      : undefined;
  const fallbackMaxAgeMs = parseDuration(maxAge ?? '7d', 'fallback.maxAge');

  return {
    baseUrl,
    endpoint,
    token,
    reference,
    refresh,
    intervalMs,
    ttlMs,
    maxStaleMs,
    timeoutMs,
    retries,
    fallbackMaxAgeMs,
  };
}

/** `acme.dopbase.dev` → `https://acme.dopbase.dev`. Keeps a base path, drops a trailing slash. */
export function normalizeHost(raw: string | undefined): string {
  const host = raw?.trim();
  if (!host) {
    throw new DopbaseConfigError(
      'No Dopbase host. Set DOPBASE_HOST (for example acme.dopbase.dev) or pass { host }.',
      'HOST_MISSING',
    );
  }
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(host) ? host : `https://${host}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new DopbaseConfigError("DOPBASE_HOST isn't a valid host or URL.", 'HOST_INVALID');
  }
  if (url.protocol === 'dop:') {
    throw new DopbaseConfigError(
      "dop:// connection strings aren't supported. Set DOPBASE_HOST and DOPBASE_TOKEN instead.",
      'HOST_INVALID',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DopbaseConfigError('DOPBASE_HOST must use https://.', 'HOST_INVALID');
  }
  if (url.username || url.password) {
    throw new DopbaseConfigError(
      "DOPBASE_HOST can't contain credentials. Put the token in DOPBASE_TOKEN.",
      'HOST_INVALID',
    );
  }
  if (url.search || url.hash) {
    throw new DopbaseConfigError(
      "DOPBASE_HOST can't have a query string or #fragment.",
      'HOST_INVALID',
    );
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new DopbaseConfigError(
      'Plain http:// is only allowed for localhost. Use https:// for this host.',
      'HOST_INSECURE',
    );
  }
  let path = url.pathname;
  while (path.endsWith('/')) path = path.slice(0, -1);
  return url.origin + path;
}

function checkToken(token: string | undefined): string {
  const value = token?.trim();
  if (!value) {
    throw new DopbaseConfigError(
      'No runner token. Set DOPBASE_TOKEN or pass { token }.',
      'TOKEN_MISSING',
    );
  }
  if (!TOKEN_PATTERN.test(value)) {
    throw new DopbaseConfigError(
      "DOPBASE_TOKEN isn't a runner token. It should be dbs_ followed by 43 characters.",
      'TOKEN_INVALID',
    );
  }
  return value;
}

function resolveRefresh(mode: unknown, platform: PlatformInfo): ResolvedConfig['refresh'] {
  switch (mode ?? 'auto') {
    case 'auto':
      return platform.longRunning ? 'poll' : 'ttl';
    case 'once':
    case 'poll':
    case 'ttl':
      return mode as ResolvedConfig['refresh'];
    case 'stream':
      throw new DopbaseConfigError(
        "refresh: 'stream' needs change events from the Dopbase server, which aren't available yet. Use 'poll'.",
      );
    default:
      throw new DopbaseConfigError("refresh must be 'auto', 'once', 'poll' or 'ttl'.");
  }
}

/** The token as it may appear anywhere a person could read it. */
export const REDACTED_TOKEN = 'dbs_***';
