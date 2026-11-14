import { type DopbaseOptions, REDACTED_TOKEN, type ResolvedConfig, resolveConfig } from './config';
import { type CacheKeys, deriveCacheKeys } from './crypto';
import { MAX_TIMER_MS } from './duration';
import {
  type Caller,
  DopbaseConfigError,
  DopbaseError,
  type DopbaseIssue,
  DopbaseValidationError,
  fromCaller,
  isAccessError,
  isAvailabilityError,
  withoutFrames,
} from './errors';
import { type InjectOptions, inject, processEnv } from './inject';
import { detectPlatform, type PlatformInfo } from './platform/detect';
import { readEnv, takeEnv } from './platform/env';
import { hooks } from './platform/hooks';
import { discoverWaitUntil, type WaitUntil } from './platform/wait';
import {
  type ChangeSet,
  decodeState,
  diffValues,
  encodeState,
  hasChanges,
  type StoredState,
  toValues,
} from './snapshot';
import type { StandardSchemaV1 } from './standard-schema';
import { CacheApiStore } from './stores/cache-api';
import { type CacheStore, isCacheStore } from './stores/types';
import { type FetchResult, RuntimeApi } from './transport';

export interface LoadOptions {
  /** Copy the values into `process.env` (Node, Bun, Deno). */
  inject?: boolean | InjectOptions;
  /**
   * Keeps a background refresh alive after the response is sent. Pass the
   * platform's own: `ctx.waitUntil` on Cloudflare, `waitUntil` from
   * `@vercel/functions`, `context.waitUntil` on Netlify. Supabase's is found
   * on its own.
   */
  waitUntil?: WaitUntil;
}

export interface SnapshotInfo {
  project: string;
  projectId: string;
  environment: string;
  environmentId: string;
  revision: string;
  /** When the server last confirmed these values. */
  fetchedAt: Date;
  /** `'store'` when the values came from the encrypted copy and the server hasn't confirmed them yet. */
  source: 'live' | 'store';
  /** The last refresh failed, or refreshing stopped after the token was refused. */
  stale: boolean;
}

export type ChangeListener<T> = (values: Readonly<T>, changes: ChangeSet) => void;
export type ErrorListener = (error: DopbaseError) => void;

type Values = Record<string, string | undefined>;
type HeldState = StoredState & { source: 'live' | 'store' };
interface ChangeSubscription<T> {
  keys: Set<string> | undefined;
  listener: ChangeListener<T>;
}

const MAX_POLL_BACKOFF_MS = 30 * 60_000;
// A 304 only moves fetchedAt. Poll mode reads that just for fallback.maxAge, so hourly is enough.
const POLL_PERSIST_UNCHANGED_MS = 60 * 60_000;

/**
 * Loads the secrets of one Dopbase environment with a runner token and keeps
 * them fresh. Construct it once at module scope; `load()` does the network
 * work and is cheap to call again.
 */
export class DopbaseSDK<T extends Record<string, unknown> = Values> {
  readonly #config: ResolvedConfig;
  readonly #platform: PlatformInfo;
  readonly #api: RuntimeApi;
  readonly #schema: StandardSchemaV1<any, T> | undefined;
  readonly #defaults: Readonly<Record<string, string>> | undefined;
  readonly #store: CacheStore | null;
  readonly #debug: (message: string) => void;
  readonly #warn: (message: string) => void;
  // Created on first use: Workers refuse an AbortController at module scope.
  #abort: AbortController | undefined;
  readonly #changeListeners = new Set<ChangeSubscription<T>>();
  readonly #errorListeners = new Set<ErrorListener>();
  readonly #injected = new Set<string>();

  #cacheKeys: Promise<CacheKeys> | undefined;
  #state: HeldState | undefined;
  /** Sent as If-None-Match. Moves ahead of #state when new values fail the schema. */
  #etag: string | null = null;
  #raw: Readonly<Record<string, string>> = {};
  #values: Readonly<T> | undefined;
  #loading: Promise<void> | undefined;
  #inflight: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  /** When the last check failed. In `'ttl'`, `load()` doesn't wait on another check for one ttl after it. */
  #failedAt: number | undefined;
  /** `fetchedAt` of the copy last written to the store. */
  #persistedAt = 0;
  #stale = false;
  /** Set while the server's current revision is one the schema refused. */
  #rejected: DopbaseValidationError | undefined;
  #stopped: DopbaseError | undefined;
  #closed = false;
  #sync: InjectOptions | undefined;

  constructor(options: DopbaseOptions<T> = {}) {
    try {
      this.#platform = detectPlatform();
      if (this.#platform.name === 'browser') {
        throw new DopbaseConfigError(
          'The Dopbase SDK runs on servers and edge functions only. A runner token must never reach a browser.',
          'BROWSER_UNSUPPORTED',
        );
      }
      this.#config = resolveConfig(options, this.#platform);
      this.#schema = options.schema;
      this.#defaults = options.defaults ? Object.freeze({ ...options.defaults }) : undefined;
      this.#store = this.#pickStore(options.fallback);

      const logger = options.logger;
      const debugEnabled = /(^|,)\s*(dopbase|dopbase:\*|\*)\s*(,|$)/.test(readEnv('DEBUG') ?? '');
      this.#debug = (message) =>
        logger?.debug
          ? logger.debug(message)
          : debugEnabled && console.debug(`[dopbase] ${message}`);
      this.#warn = (message) =>
        logger?.warn ? logger.warn(message) : console.warn(`[dopbase] ${message}`);

      const apiOptions = {
        endpoint: this.#config.endpoint,
        baseUrl: this.#config.baseUrl,
        token: this.#config.token,
        timeoutMs: this.#config.timeoutMs,
        retries: this.#config.retries,
        userAgent: `dopbase-node/${__VERSION__} ${this.#platform.runtime}`,
      };
      this.#api = new RuntimeApi(
        options.fetch ? { ...apiOptions, fetch: options.fetch } : apiOptions,
      );
    } catch (error) {
      throw fromCaller(error, new.target);
    }
  }

  /**
   * Fetches the secrets the first time, then keeps them fresh according to
   * `refresh`. Later calls return at once unless `'ttl'` says the values are
   * due for a check. Resolves to the SDK itself.
   */
  async load(options: LoadOptions = {}): Promise<this> {
    try {
      return await this.#load(options);
    } catch (error) {
      throw fromCaller(error, DopbaseSDK.prototype.load);
    }
  }

  /** Checks with the server now, whatever `refresh` says. Rejects if the check fails. */
  async refresh(): Promise<SnapshotInfo> {
    try {
      return await this.#refresh();
    } catch (error) {
      throw fromCaller(error, DopbaseSDK.prototype.refresh);
    }
  }

  async #load(options: LoadOptions): Promise<this> {
    this.#assertOpen();
    const waitUntil = options.waitUntil ?? discoverWaitUntil();
    if (!this.#state) {
      this.#loading ??= this.#firstLoad(waitUntil).finally(() => {
        this.#loading = undefined;
      });
      await this.#loading;
    } else if (this.#config.refresh === 'ttl') {
      await this.#revalidateIfDue(waitUntil);
    }
    if (options.inject) this.#inject(options.inject === true ? {} : options.inject);
    return this;
  }

  async #refresh(): Promise<SnapshotInfo> {
    this.#assertOpen();
    if (!this.#state) {
      await this.#load({});
    } else {
      if (this.#stopped) throw this.#stopped;
      await this.#revalidate();
      // A 304 for a refused revision: the server answered, but these aren't its values.
      if (this.#rejected) throw this.#rejected;
    }
    return this.snapshot()!;
  }

  get<K extends keyof T & string>(key: K): T[K] {
    return this.#loaded(DopbaseSDK.prototype.get)[key];
  }

  /** Like `get`, but throws when the key isn't set. */
  require<K extends keyof T & string>(key: K): NonNullable<T[K]> {
    const value = this.#loaded(DopbaseSDK.prototype.require)[key];
    if (value === undefined || value === null) {
      throw fromCaller(
        new DopbaseError(`${key} isn't set in "${this.#state!.snapshot.environment}".`, {
          code: 'KEY_MISSING',
        }),
        DopbaseSDK.prototype.require,
      );
    }
    return value as NonNullable<T[K]>;
  }

  has(key: string): boolean {
    const values = this.#loaded(DopbaseSDK.prototype.has) as Record<string, unknown>;
    return Object.hasOwn(values, key) && values[key] !== undefined;
  }

  /** Every value, frozen. With a `schema`, the parsed output. */
  getAll(): Readonly<T> {
    return this.#loaded(DopbaseSDK.prototype.getAll);
  }

  /** Where the values came from and how fresh they are. `undefined` before the first `load()`. */
  snapshot(): SnapshotInfo | undefined {
    const state = this.#state;
    if (!state) return undefined;
    const { project, projectId, environment, environmentId, revision } = state.snapshot;
    return {
      project,
      projectId,
      environment,
      environmentId,
      revision,
      fetchedAt: new Date(state.fetchedAt),
      source: state.source,
      stale: this.#stale || this.#stopped !== undefined,
    };
  }

  /** Calls `listener` when values change. Pass keys to hear about those only. Returns an unsubscribe function. */
  onChange(listener: ChangeListener<T>): () => void;
  onChange(keys: readonly (keyof T & string)[], listener: ChangeListener<T>): () => void;
  onChange(
    keysOrListener: readonly (keyof T & string)[] | ChangeListener<T>,
    maybeListener?: ChangeListener<T>,
  ): () => void {
    const subscription: ChangeSubscription<T> =
      typeof keysOrListener === 'function'
        ? { keys: undefined, listener: keysOrListener }
        : { keys: new Set(keysOrListener), listener: maybeListener! };
    if (typeof subscription.listener !== 'function') {
      throw fromCaller(
        new DopbaseConfigError('onChange needs a listener function.'),
        DopbaseSDK.prototype.onChange,
      );
    }
    this.#changeListeners.add(subscription);
    return () => this.#changeListeners.delete(subscription);
  }

  /** Background refresh failures land here instead of crashing the process. Returns an unsubscribe function. */
  onError(listener: ErrorListener): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  /** Stops refreshing and drops listeners. Values stay readable. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#abort?.abort();
    this.#changeListeners.clear();
    this.#errorListeners.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  toJSON(): { host: string; environment: string | null; loaded: boolean } {
    return {
      host: this.#config.baseUrl,
      environment: this.#state?.snapshot.environment ?? null,
      loaded: this.#state !== undefined,
    };
  }

  toString(): string {
    return `DopbaseSDK(${this.#config.baseUrl})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.#describe();
  }

  [Symbol.for('Deno.customInspect')](): string {
    return this.#describe();
  }

  #describe(): string {
    const keys = this.#values ? Object.keys(this.#values).length : 0;
    const environment = this.#state ? `'${this.#state.snapshot.environment}'` : 'null';
    return `DopbaseSDK { host: '${this.#config.baseUrl}', token: '${REDACTED_TOKEN}', environment: ${environment}, keys: ${keys} }`;
  }

  async #firstLoad(waitUntil: WaitUntil | undefined): Promise<void> {
    let stored = await this.#readStore();
    const age = stored ? Date.now() - stored.fetchedAt : Number.POSITIVE_INFINITY;
    if (stored && this.#config.refresh === 'ttl' && age < this.#config.ttlMs) {
      try {
        await this.#apply({ ...stored, source: 'store' }, true);
        this.#debug(`using the stored copy (${Math.round(age / 1000)}s old)`);
        return;
      } catch (error) {
        // Written before a schema change, most likely. Ask the server, without its ETag.
        this.#debug(`ignoring the stored copy: ${(error as Error).message}`);
        stored = undefined;
      }
    }
    try {
      const result = await this.#api.fetch(stored?.etag ?? null, this.#signal());
      if (result.status === 'unchanged' && stored) {
        this.#debug('the stored copy is current (304)');
        await this.#apply(
          { ...stored, etag: result.etag, fetchedAt: Date.now(), source: 'live' },
          true,
        );
      } else if (result.status === 'fetched') {
        await this.#apply(
          { snapshot: result.snapshot, etag: result.etag, fetchedAt: Date.now(), source: 'live' },
          true,
        );
      } else {
        throw new DopbaseError('Dopbase answered 304 to a request without an ETag.', {
          code: 'RESPONSE_INVALID',
        });
      }
      this.#background(this.#persist(), waitUntil);
    } catch (error) {
      if (!isAvailabilityError(error) || !stored || age > this.#config.fallbackMaxAgeMs) {
        throw error;
      }
      try {
        await this.#apply({ ...stored, source: 'store' }, true);
      } catch (invalid) {
        // The outage is the error worth reporting, not the old copy's schema mismatch.
        this.#debug(`ignoring the stored copy: ${(invalid as Error).message}`);
        throw error;
      }
      this.#warn(
        `${(error as Error).message}\nUsing the stored copy from ${new Date(stored.fetchedAt).toISOString()}.`,
      );
      this.#stale = true;
      // So 'ttl' serves this copy for one ttl instead of waiting out the outage again.
      this.#failedAt = Date.now();
    } finally {
      if (this.#state) this.#schedule();
    }
  }

  async #revalidateIfDue(waitUntil: WaitUntil | undefined): Promise<void> {
    if (this.#stopped || !this.#state) return;
    const now = Date.now();
    const age = now - this.#state.fetchedAt;
    if (age < this.#config.ttlMs) return;
    // During an outage, don't make every request wait out the timeout and retries again.
    if (this.#failedAt !== undefined && now - this.#failedAt < this.#config.ttlMs) return;
    if (waitUntil && age < this.#config.maxStaleMs) {
      waitUntil(this.#revalidate(waitUntil).catch((error) => this.#emitError(error)));
      return;
    }
    try {
      await this.#revalidate(waitUntil);
    } catch (error) {
      // Keep serving what we have; the error is reported, not thrown.
      this.#emitError(error);
    }
  }

  /** `waitUntil` keeps the store write that follows a check alive. */
  #revalidate(waitUntil?: WaitUntil): Promise<void> {
    this.#inflight ??= this.#fetchAndApply(waitUntil).finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #fetchAndApply(waitUntil: WaitUntil | undefined): Promise<void> {
    let result: FetchResult;
    try {
      result = await this.#api.fetch(this.#etag, this.#signal());
    } catch (error) {
      if (this.#closed) return;
      this.#failedAt = Date.now();
      if (isAccessError(error)) {
        // A revoked token must not keep pulling. Keep the values, stop asking.
        this.#stopped = error as DopbaseError;
        clearTimeout(this.#timer);
      } else {
        this.#failures++;
      }
      this.#stale = true;
      throw error;
    }
    if (this.#closed) return;
    // The server answered, so polling needs no backoff even if the schema refuses the values.
    this.#failures = 0;
    const now = Date.now();
    let persist = this.#store !== null;
    if (result.status === 'unchanged') {
      if (this.#rejected) {
        // Still the revision the schema refused. The held values are older than the server's.
        this.#debug('no changes (304) to the refused revision');
        this.#failedAt = now;
        this.#stale = true;
        return;
      }
      this.#state = { ...this.#state!, fetchedAt: now, source: 'live' };
      this.#debug('no changes (304)');
      persist &&=
        this.#config.refresh !== 'poll' || now - this.#persistedAt >= POLL_PERSIST_UNCHANGED_MS;
    } else {
      try {
        await this.#apply(
          { snapshot: result.snapshot, etag: result.etag, fetchedAt: now, source: 'live' },
          false,
        );
      } catch (error) {
        this.#failedAt = now;
        this.#stale = true;
        throw error;
      }
    }
    this.#failedAt = undefined;
    this.#stale = false;
    if (persist) this.#background(this.#persist(), waitUntil);
  }

  /** Makes `state` current. Rejected by the schema: throws and keeps the old values. */
  async #apply(state: HeldState, first: boolean): Promise<void> {
    const raw = toValues(state.snapshot.entries, this.#defaults);
    let values: T;
    if (this.#schema) {
      const issues = await validateSchema(this.#schema, raw);
      if (issues.issues) {
        const error = new DopbaseValidationError(
          schemaMessage(state.snapshot.environment, issues.issues),
          issues.issues,
          { code: 'SCHEMA_INVALID' },
        );
        if (!first) {
          // Don't download the same rejected revision again on every check.
          this.#etag = state.etag;
          this.#rejected = error;
        }
        throw error;
      }
      values = issues.value;
    } else {
      values = raw as unknown as T;
    }

    const before = this.#raw;
    this.#state = state;
    this.#etag = state.etag;
    this.#rejected = undefined;
    this.#raw = raw;
    this.#values = Object.freeze(values);
    if (first) return;

    const changes = diffValues(before, raw);
    if (!hasChanges(changes)) return;
    this.#debug(
      `revision ${state.snapshot.revision.slice(0, 12)}: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed`,
    );
    if (this.#sync) this.#inject(this.#sync);
    const touched = [...changes.added, ...changes.changed, ...changes.removed];
    for (const { keys, listener } of [...this.#changeListeners]) {
      if (keys && !touched.some((key) => keys.has(key))) continue;
      try {
        listener(this.#values, changes);
      } catch (error) {
        this.#warn(`An onChange listener threw: ${(error as Error)?.message ?? error}`);
      }
    }
  }

  #schedule(): void {
    if (this.#config.refresh !== 'poll' || this.#closed || this.#stopped) return;
    const { intervalMs } = this.#config;
    const base = Math.min(
      intervalMs * 2 ** this.#failures,
      Math.max(intervalMs, MAX_POLL_BACKOFF_MS),
    );
    const delay = Math.min(base * (0.9 + Math.random() * 0.2), MAX_TIMER_MS);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#revalidate()
        .catch((error) => this.#emitError(error))
        .finally(() => this.#schedule());
    }, delay);
    unrefTimer(this.#timer);
  }

  #inject(options: InjectOptions): void {
    const env = processEnv();
    const result = inject(env, this.#raw, options, this.#injected);
    if (result.blocked.length > 0) {
      this.#warn(
        `Not injecting ${result.blocked.join(', ')}: these names load extra code. List them in inject.allow to inject them anyway.`,
      );
    }
    if (!options.keepToken) takeEnv(env, 'DOPBASE_TOKEN');
    if (options.sync) this.#sync = options;
    this.#debug(`injected ${result.set.length} variables into process.env`);
  }

  #pickStore(fallback: DopbaseOptions<T>['fallback']): CacheStore | null {
    if (fallback === false) return null;
    if (isCacheStore(fallback)) return fallback;
    if (fallback && 'store' in fallback && fallback.store !== undefined) {
      return fallback.store === false ? null : fallback.store;
    }
    const maxAgeSeconds = this.#config.fallbackMaxAgeMs / 1000;
    if (hooks.defaultStore) return hooks.defaultStore({ platform: this.#platform, maxAgeSeconds });
    return CacheApiStore.available() ? new CacheApiStore({ maxAgeSeconds }) : null;
  }

  async #readStore(): Promise<StoredState | undefined> {
    if (!this.#store) return undefined;
    try {
      const { id, key } = await this.#keys();
      const blob = await this.#store.get(id);
      if (!blob) return undefined;
      const state = await decodeState(key, blob);
      if (!state) {
        this.#debug('ignoring a stored copy that did not decrypt');
        return undefined;
      }
      // The copy is keyed by host and token only. Never serve it past a DOPBASE_ENV it doesn't match.
      const { reference } = this.#config;
      const { snapshot } = state;
      if (
        reference !== undefined &&
        reference !== snapshot.environmentId &&
        reference !== `${snapshot.project}/${snapshot.environment}`
      ) {
        this.#debug(`ignoring a stored copy of ${snapshot.environment}: env is ${reference}`);
        return undefined;
      }
      return state;
    } catch (error) {
      this.#debug(`couldn't read the stored copy: ${(error as Error)?.message ?? error}`);
      return undefined;
    }
  }

  async #persist(): Promise<void> {
    const state = this.#state;
    if (!this.#store || !state) return;
    try {
      const { id, key } = await this.#keys();
      const { snapshot, etag, fetchedAt } = state;
      await this.#store.set(id, await encodeState(key, { snapshot, etag, fetchedAt }));
      this.#persistedAt = Math.max(this.#persistedAt, fetchedAt);
    } catch (error) {
      this.#debug(`couldn't save the stored copy: ${(error as Error)?.message ?? error}`);
    }
  }

  #signal(): AbortSignal {
    this.#abort ??= new AbortController();
    return this.#abort.signal;
  }

  #keys(): Promise<CacheKeys> {
    this.#cacheKeys ??= deriveCacheKeys(this.#config.baseUrl, this.#config.token);
    return this.#cacheKeys;
  }

  #background(promise: Promise<unknown>, waitUntil = discoverWaitUntil()): void {
    const guarded = promise.catch(() => {});
    waitUntil?.(guarded);
  }

  #emitError(error: unknown): void {
    // A background failure has no app call to point at, and its frames are SDK internals.
    const wrapped =
      error instanceof DopbaseError
        ? withoutFrames(error)
        : new DopbaseError(String((error as Error)?.message ?? error), {
            code: 'UNEXPECTED',
            cause: error,
          });
    if (this.#errorListeners.size === 0) {
      this.#warn(wrapped.message);
      return;
    }
    for (const listener of [...this.#errorListeners]) {
      try {
        listener(wrapped);
      } catch (thrown) {
        this.#warn(`An onError listener threw: ${(thrown as Error)?.message ?? thrown}`);
      }
    }
  }

  #loaded(caller: Caller): Readonly<T> {
    if (!this.#values) {
      throw fromCaller(
        new DopbaseError('Secrets are not loaded yet. Call await sdk.load() first.', {
          code: 'NOT_LOADED',
        }),
        caller,
      );
    }
    return this.#values;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DopbaseError('This DopbaseSDK was closed.', { code: 'CLOSED' });
    }
  }
}

async function validateSchema<T>(
  schema: StandardSchemaV1<any, T>,
  raw: Record<string, string>,
): Promise<{ value: T; issues?: undefined } | { issues: DopbaseIssue[] }> {
  const result = await schema['~standard'].validate(raw);
  if (!result.issues) return { value: result.value };
  return {
    issues: result.issues.map((issue) => {
      const first = issue.path?.[0];
      const key = typeof first === 'object' && first !== null ? first.key : first;
      return typeof key === 'string' ? { key, message: issue.message } : { message: issue.message };
    }),
  };
}

/** One line per issue, so a long list stays readable. Never includes values. */
function schemaMessage(environment: string, issues: DopbaseIssue[]): string {
  const one = issues.length === 1;
  return [
    `${issues.length} ${one ? 'secret' : 'secrets'} in "${environment}" ${one ? "doesn't" : "don't"} match your schema:`,
    ...issues.map((issue) => `  - ${issue.key ? `${issue.key}: ` : ''}${issue.message}`),
    `Fix ${one ? 'it' : 'them'} in Dopbase, or change the schema.`,
  ].join('\n');
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref(): void }).unref();
    return;
  }
  const deno = (globalThis as { Deno?: { unrefTimer?(id: number): void } }).Deno;
  if (typeof timer === 'number') deno?.unrefTimer?.(timer);
}
