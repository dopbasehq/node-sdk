import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DopbaseOptions } from '../src/config';
import { deriveCacheKeys } from '../src/crypto';
import {
  DopbaseAuthError,
  DopbaseConfigError,
  type DopbaseError,
  DopbaseNetworkError,
  DopbaseValidationError,
} from '../src/errors';
import { DopbaseSDK } from '../src/sdk';
import { encodeState } from '../src/snapshot';
import { MemoryStore } from '../src/stores/memory';
import { fakeRuntime, HOST, TOKEN } from './helpers/runtime';

type Runtime = ReturnType<typeof fakeRuntime>;

function create<T extends Record<string, unknown> = Record<string, string | undefined>>(
  runtime: Runtime,
  options: DopbaseOptions<T> = {},
) {
  return new DopbaseSDK<T>({
    host: HOST,
    token: TOKEN,
    refresh: 'once',
    fallback: false,
    retries: 0,
    fetch: runtime.fetch,
    ...options,
  });
}

/** A store holding a copy written `ageMs` ago. */
async function storeWith(values: Record<string, string>, ageMs: number, etag = '"etag-1"') {
  const store = new MemoryStore();
  const { id, key } = await deriveCacheKeys(HOST, TOKEN);
  const snapshot = {
    projectId: 'prj_1',
    project: 'payment-service',
    environment: 'production',
    environmentId: 'env_000123',
    revision: 'rev-1',
    entries: Object.entries(values).map(([k, value]) => ({ key: k, value })),
  };
  await store.set(id, await encodeState(key, { snapshot, etag, fetchedAt: Date.now() - ageMs }));
  return store;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reading values', () => {
  it('loads once and reads from memory', async () => {
    const runtime = fakeRuntime({ DATABASE_URL: 'postgres://db', EMPTY: '' });
    const env = await create(runtime).load();
    expect(env.get('DATABASE_URL')).toBe('postgres://db');
    expect(env.has('EMPTY')).toBe(true);
    expect(env.has('MISSING')).toBe(false);
    expect(env.require('DATABASE_URL')).toBe('postgres://db');
    expect(Object.isFrozen(env.getAll())).toBe(true);
    expect(env.snapshot()).toMatchObject({
      project: 'payment-service',
      environment: 'production',
      environmentId: 'env_000123',
      revision: 'rev-1',
      source: 'live',
      stale: false,
    });
    await env.load();
    expect(runtime.calls).toHaveLength(1);
  });

  it('throws before load and for a missing required key', async () => {
    const env = create(fakeRuntime({ A: '1' }));
    expect(() => env.get('A')).toThrow(expect.objectContaining({ code: 'NOT_LOADED' }));
    expect(env.snapshot()).toBeUndefined();
    await env.load();
    expect(() => env.require('B')).toThrow(expect.objectContaining({ code: 'KEY_MISSING' }));
  });

  it('shares one request between concurrent loads', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = create(runtime);
    await Promise.all([env.load(), env.load(), env.load()]);
    expect(runtime.calls).toHaveLength(1);
  });

  it('uses defaults only for keys the server lacks', async () => {
    const env = await create(fakeRuntime({ A: 'server' }), {
      defaults: { A: 'default', B: 'default' },
    }).load();
    expect(env.getAll()).toEqual({ A: 'server', B: 'default' });
  });

  it('sends the env guard as ?reference=', async () => {
    const runtime = fakeRuntime({ A: '1' });
    await create(runtime, { env: 'payment-service/production' }).load();
    expect(runtime.calls[0]!.url).toBe(
      `${HOST}/api/v1/runtime/secrets?reference=payment-service%2Fproduction`,
    );
  });
});

describe('schema', () => {
  const schema = z.object({ DATABASE_URL: z.url(), PORT: z.coerce.number().default(3000) });

  it('parses and types values', async () => {
    const env = await create(fakeRuntime({ DATABASE_URL: 'postgres://db', PORT: '8080' }), {
      schema,
    }).load();
    const port: number = env.get('PORT');
    expect(port).toBe(8080);
  });

  it('rejects the first load with key names, never values', async () => {
    const env = create(fakeRuntime({ DATABASE_URL: 'not a url but a secret', PORT: 'eighty' }), {
      schema,
    });
    const error = await env.load().catch((e) => e);
    expect(error).toBeInstanceOf(DopbaseValidationError);
    expect(error.code).toBe('SCHEMA_INVALID');
    expect(error.issues).toEqual([
      expect.objectContaining({ key: 'DATABASE_URL' }),
      expect.objectContaining({ key: 'PORT' }),
    ]);
    expect(error.message.split('\n')).toEqual([
      `2 secrets in "production" don't match your schema:`,
      expect.stringMatching(/^ {2}- DATABASE_URL: \S/),
      expect.stringMatching(/^ {2}- PORT: \S/),
      'Fix them in Dopbase, or change the schema.',
    ]);
    expect(error.message).not.toContain('not a url but a secret');
    expect(error.message).not.toContain('eighty');
  });

  it('words a single failing key in the singular', async () => {
    const env = create(fakeRuntime({ DATABASE_URL: 'nope' }), { schema });
    const error = await env.load().catch((e) => e);
    expect(error.message).toMatch(/^1 secret in "production" doesn't match your schema:\n/);
    expect(error.message).toMatch(/\nFix it in Dopbase, or change the schema\.$/);
  });
});

describe('errors the app sees', () => {
  // Frames inside the SDK. Node and Bun print the source of the first frame
  // above an uncaught error, so none may come before the app's own.
  const sdkFrames = (error: Error) =>
    (error.stack ?? '').split('\n').filter((line) => /\/src\/[\w/-]+\.ts/.test(line));

  it('start the stack at the app call to load() and refresh()', async () => {
    const runtime = fakeRuntime({ PORT: 'eighty' });
    const env = create(runtime, { schema: z.object({ PORT: z.coerce.number() }) });
    const loadError = await env.load().catch((e) => e);
    expect(loadError.code).toBe('SCHEMA_INVALID');
    expect(sdkFrames(loadError)).toEqual([]);
    expect(loadError.stack).toContain('sdk.test.ts');

    runtime.unreachable();
    const refreshError = await env.refresh().catch((e) => e);
    expect(refreshError).toBeInstanceOf(DopbaseNetworkError);
    expect(sdkFrames(refreshError)).toEqual([]);
  });

  it('start the stack at the app call for synchronous methods', async () => {
    const env = create(fakeRuntime({ A: '1' }));
    for (const call of [
      () => env.get('A'),
      () => env.has('A'),
      () => env.getAll(),
      () => env.onChange(undefined as never),
    ]) {
      const error = (() => {
        try {
          call();
        } catch (thrown) {
          return thrown as Error;
        }
        throw new Error('expected a throw');
      })();
      expect(sdkFrames(error)).toEqual([]);
      expect(error.stack).toContain('sdk.test.ts');
    }

    await env.load();
    const missing = (() => {
      try {
        env.require('B');
      } catch (thrown) {
        return thrown as Error;
      }
    })()!;
    expect(missing.message).toBe('B isn\'t set in "production".');
    expect(sdkFrames(missing)).toEqual([]);
  });

  it('start the stack at new DopbaseSDK() for a bad option', () => {
    const error = (() => {
      try {
        new DopbaseSDK({ host: 'http://acme.dopbase.dev', token: TOKEN });
      } catch (thrown) {
        return thrown as Error;
      }
    })()!;
    expect(error).toBeInstanceOf(DopbaseConfigError);
    expect(sdkFrames(error)).toEqual([]);
    expect(error.stack).toContain('sdk.test.ts');
  });

  it('print without empty fields or a second copy of the issues', async () => {
    const env = create(fakeRuntime({ PORT: 'eighty' }), {
      schema: z.object({ PORT: z.coerce.number() }),
    });
    const error = await env.load().catch((e) => e);
    expect(Object.keys(error)).toEqual(['name', 'code']);
    const printed = inspect(error);
    expect(printed).not.toContain('status');
    expect(printed).not.toContain('requestId');
    expect(printed).not.toContain('issues');
    expect(error.issues).toHaveLength(1);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });

  it('keep status and requestId when the server answered', async () => {
    const runtime = fakeRuntime();
    runtime.fail(401, 'AUTHENTICATION_INVALID');
    const error = await create(runtime)
      .load()
      .catch((e) => e);
    expect(error).toMatchObject({
      code: 'AUTHENTICATION_INVALID',
      status: 401,
      requestId: 'req-err',
    });
  });
});

describe('poll', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  it('checks with the ETag and reports changes by key', async () => {
    const runtime = fakeRuntime({ A: '1', B: '1', C: '1' });
    const env = await create(runtime, { refresh: 'poll', interval: '15s' }).load();
    const all = vi.fn();
    const onlyC = vi.fn();
    env.onChange(all);
    env.onChange(['C'], onlyC);

    await vi.advanceTimersByTimeAsync(18_000);
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.headers.get('if-none-match')).toBe('"etag-1"');
    expect(all).not.toHaveBeenCalled();

    runtime.set({ A: '2', B: '1', D: '1' });
    await vi.advanceTimersByTimeAsync(18_000);
    expect(all).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledWith(
      { A: '2', B: '1', D: '1' },
      { added: ['D'], changed: ['A'], removed: ['C'] },
    );
    expect(onlyC).toHaveBeenCalledTimes(1);
    expect(env.get('A')).toBe('2');

    runtime.set({ A: '3', B: '1', D: '1' });
    await vi.advanceTimersByTimeAsync(18_000);
    expect(all).toHaveBeenCalledTimes(2);
    expect(onlyC).toHaveBeenCalledTimes(1);
    env.close();
  });

  it('stops polling once the token is revoked, keeping the values', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'poll', interval: '15s' }).load();
    const errors: DopbaseError[] = [];
    env.onError((error) => errors.push(error));

    runtime.fail(401, 'AUTHENTICATION_INVALID');
    await vi.advanceTimersByTimeAsync(18_000);
    expect(errors[0]).toBeInstanceOf(DopbaseAuthError);
    // No app call led here, and the SDK's own frames would mean nothing to the app.
    expect(errors[0]!.stack).not.toMatch(/\n\s+at /);
    expect(env.snapshot()!.stale).toBe(true);
    expect(env.get('A')).toBe('1');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.calls).toHaveLength(2);
    await expect(env.refresh()).rejects.toBeInstanceOf(DopbaseAuthError);
  });

  it('backs off after a failure and recovers', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'poll', interval: '15s' }).load();
    const errors = vi.fn();
    env.onError(errors);

    runtime.fail(503, 'INSTANCE_RESETTING');
    await vi.advanceTimersByTimeAsync(18_000);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(env.snapshot()!.stale).toBe(true);

    // The next check waits about twice the interval.
    await vi.advanceTimersByTimeAsync(18_000);
    expect(runtime.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(runtime.calls).toHaveLength(3);
    expect(env.snapshot()!.stale).toBe(false);
    env.close();
  });

  it('polls every 5m by default and backs off to 30m while the server is down', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'poll' }).load();
    env.onError(() => {});
    for (let i = 0; i < 5; i++) runtime.fail(503, 'INSTANCE_RESETTING');

    let now = 0;
    const callsAt = async (minutes: number) => {
      await vi.advanceTimersByTimeAsync((minutes - now) * 60_000);
      now = minutes;
      return runtime.calls.length;
    };
    // Each wait is the last one doubled, ±10%: 5m, 10m, 20m, then 30m at most.
    expect(await callsAt(4)).toBe(1);
    expect(await callsAt(6)).toBe(2);
    expect(await callsAt(13)).toBe(2);
    expect(await callsAt(17)).toBe(3);
    expect(await callsAt(31)).toBe(3);
    expect(await callsAt(39)).toBe(4);
    expect(await callsAt(72)).toBe(5);
    expect(await callsAt(85)).toBe(5);
    // Uncapped, this wait would be 80m.
    expect(await callsAt(105)).toBe(6);
    env.close();
  });

  it('writes the stored copy on changes, not on every 304', async () => {
    const store = new MemoryStore();
    const set = vi.spyOn(store, 'set');
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'poll', interval: '15s', fallback: store }).load();
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(54_000);
    expect(runtime.calls.length).toBeGreaterThanOrEqual(3);
    runtime.set({ A: '2' });
    await vi.advanceTimersByTimeAsync(18_000);
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(set).toHaveBeenCalledTimes(2);
    env.close();
  });

  it('keeps old values when new ones fail the schema, without downloading them again', async () => {
    const runtime = fakeRuntime({ PORT: '80' });
    const env = await create(runtime, {
      refresh: 'poll',
      interval: '15s',
      schema: z.object({ PORT: z.coerce.number() }),
    }).load();
    const errors = vi.fn();
    env.onError(errors);

    runtime.set({ PORT: 'eighty' });
    await vi.advanceTimersByTimeAsync(18_000);
    expect(env.get('PORT')).toBe(80);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'SCHEMA_INVALID' }));

    await vi.advanceTimersByTimeAsync(18_000);
    expect(runtime.calls[2]!.headers.get('if-none-match')).toBe(runtime.etag);
    // The 304 confirms the refused revision, not the held one, and isn't reported again.
    expect(env.snapshot()).toMatchObject({ revision: 'rev-1', stale: true });
    expect(errors).toHaveBeenCalledTimes(1);
    await expect(env.refresh()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });

    runtime.set({ PORT: '81' });
    await env.refresh();
    expect(env.snapshot()).toMatchObject({ revision: 'rev-3', stale: false });
    env.close();
  });

  it("doesn't poll in a loop when interval is longer than a timer can wait", async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'poll', interval: '30d' }).load();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.calls).toHaveLength(1);
    env.close();
  });

  it('stops on close', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'poll', interval: '15s' }).load();
    env.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.calls).toHaveLength(1);
    expect(env.get('A')).toBe('1');
    await expect(env.load()).rejects.toMatchObject({ code: 'CLOSED' });
  });
});

describe('ttl', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  it('trusts values inside ttl, refreshes in the background until maxStale, then waits', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'ttl', ttl: '1m', maxStale: '10m' }).load();
    const waitUntil = vi.fn();

    vi.advanceTimersByTime(30_000);
    await env.load({ waitUntil });
    expect(runtime.calls).toHaveLength(1);

    runtime.set({ A: '2' });
    vi.advanceTimersByTime(60_000);
    await env.load({ waitUntil });
    expect(env.get('A')).toBe('1');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
    expect(env.get('A')).toBe('2');

    runtime.set({ A: '3' });
    vi.advanceTimersByTime(11 * 60_000);
    await env.load({ waitUntil });
    expect(env.get('A')).toBe('3');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('waits for the check when there is no waitUntil', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'ttl', ttl: '1m' }).load();
    runtime.set({ A: '2' });
    vi.advanceTimersByTime(61_000);
    await env.load();
    expect(env.get('A')).toBe('2');
  });

  it('keeps serving when the check fails, and waits a ttl before checking again', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'ttl', ttl: '1m' }).load();
    const errors = vi.fn();
    env.onError(errors);
    runtime.unreachable();
    vi.advanceTimersByTime(61_000);
    await env.load();
    expect(env.get('A')).toBe('1');
    expect(errors).toHaveBeenCalledWith(expect.any(DopbaseNetworkError));

    vi.advanceTimersByTime(30_000);
    await env.load();
    expect(runtime.calls).toHaveLength(2);
    vi.advanceTimersByTime(31_000);
    await env.load();
    expect(runtime.calls).toHaveLength(3);
  });

  it('hands the store write after a background check to the same waitUntil', async () => {
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, {
      refresh: 'ttl',
      ttl: '1m',
      fallback: new MemoryStore(),
    }).load({ waitUntil: () => {} });
    const waitUntil = vi.fn();
    vi.advanceTimersByTime(61_000);
    await env.load({ waitUntil });
    await waitUntil.mock.calls[0]![0];
    expect(waitUntil).toHaveBeenCalledTimes(2);
  });
});

describe('stored copy', () => {
  it('sends the stored ETag on a cold start and uses the copy on a 304', async () => {
    const runtime = fakeRuntime({ A: 'stored' });
    const store = await storeWith({ A: 'stored' }, 3_600_000);
    const env = await create(runtime, { fallback: store }).load();
    expect(runtime.calls[0]!.headers.get('if-none-match')).toBe('"etag-1"');
    expect(env.get('A')).toBe('stored');
    expect(env.snapshot()!.source).toBe('live');
  });

  it('skips the server inside ttl', async () => {
    const runtime = fakeRuntime({ A: 'live' });
    const store = await storeWith({ A: 'stored' }, 10_000);
    const env = await create(runtime, { refresh: 'ttl', ttl: '1m', fallback: store }).load();
    expect(runtime.calls).toHaveLength(0);
    expect(env.get('A')).toBe('stored');
    expect(env.snapshot()!.source).toBe('store');
  });

  it('asks the server when the copy inside ttl fails the schema', async () => {
    const runtime = fakeRuntime({ A: 'live', NEW_KEY: 'x' });
    const store = await storeWith({ A: 'stored' }, 10_000);
    const env = await create(runtime, {
      refresh: 'ttl',
      ttl: '1m',
      fallback: store,
      schema: z.object({ A: z.string(), NEW_KEY: z.string() }),
    }).load();
    expect(env.get('NEW_KEY')).toBe('x');
    expect(runtime.calls[0]!.headers.get('if-none-match')).toBeNull();
  });

  it('reports the outage, not the schema, when the fallback copy fails the schema', async () => {
    const runtime = fakeRuntime();
    runtime.unreachable();
    const store = await storeWith({ A: 'stored' }, 3_600_000);
    const env = create(runtime, { fallback: store, schema: z.object({ NEW_KEY: z.string() }) });
    await expect(env.load()).rejects.toBeInstanceOf(DopbaseNetworkError);
  });

  it('uses a copy only for the environment env names', async () => {
    const store = await storeWith({ A: 'stored' }, 10_000);
    const options = { refresh: 'ttl', ttl: '1m', fallback: store } as const;
    const matching = fakeRuntime({ A: 'live' });
    await create(matching, { ...options, env: 'payment-service/production' }).load();
    await create(matching, { ...options, env: 'env_000123' }).load();
    expect(matching.calls).toHaveLength(0);

    const other = fakeRuntime({ A: 'live' });
    const env = await create(other, { ...options, env: 'payment-service/staging' }).load();
    expect(other.calls).toHaveLength(1);
    expect(env.get('A')).toBe('live');
  });

  it('falls back when the server is down', async () => {
    const runtime = fakeRuntime();
    runtime.unreachable();
    const store = await storeWith({ A: 'stored' }, 3_600_000);
    const env = await create(runtime, { fallback: store }).load();
    expect(env.get('A')).toBe('stored');
    expect(env.snapshot()).toMatchObject({ source: 'store', stale: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Using the stored copy'));
  });

  it("waits a ttl after falling back before trying the server again ('ttl')", async () => {
    const runtime = fakeRuntime();
    runtime.unreachable();
    const store = await storeWith({ A: 'stored' }, 3_600_000);
    const env = await create(runtime, { refresh: 'ttl', ttl: '1m', fallback: store }).load();
    await env.load();
    expect(runtime.calls).toHaveLength(1);
    expect(env.get('A')).toBe('stored');
  });

  it('never falls back on an auth error', async () => {
    const runtime = fakeRuntime();
    runtime.fail(401, 'AUTHENTICATION_INVALID');
    const store = await storeWith({ A: 'stored' }, 1_000);
    await expect(create(runtime, { fallback: store }).load()).rejects.toBeInstanceOf(
      DopbaseAuthError,
    );
  });

  it('ignores a copy older than fallback.maxAge', async () => {
    const runtime = fakeRuntime();
    runtime.unreachable();
    const store = await storeWith({ A: 'stored' }, 2 * 86_400_000);
    await expect(
      create(runtime, { fallback: { store, maxAge: '1d' } }).load(),
    ).rejects.toBeInstanceOf(DopbaseNetworkError);
  });

  it('rejects with no network and no copy', async () => {
    const runtime = fakeRuntime();
    runtime.unreachable();
    await expect(create(runtime).load()).rejects.toBeInstanceOf(DopbaseNetworkError);
  });

  it('keeps the copy encrypted', async () => {
    const store = new MemoryStore();
    const set = vi.spyOn(store, 'set');
    await create(fakeRuntime({ A: 'very-secret-value' }), { fallback: store }).load();
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    const [id, blob] = set.mock.calls[0]!;
    const text = new TextDecoder().decode(blob);
    expect(text).not.toContain('very-secret-value');
    expect(id).not.toContain(TOKEN);
  });
});

describe('redaction and safety', () => {
  it('never prints the token or values', async () => {
    const env = await create(fakeRuntime({ PASSWORD: 'hunter2' })).load();
    for (const text of [inspect(env), JSON.stringify(env), String(env)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('hunter2');
    }
    expect(inspect(env)).toContain("token: 'dbs_***'");
  });

  it('does nothing in the constructor that Workers forbid at module scope', () => {
    const forbidden = () => {
      throw new Error('Disallowed operation called within global scope');
    };
    vi.stubGlobal('AbortController', forbidden);
    vi.stubGlobal('setTimeout', forbidden);
    vi.stubGlobal('fetch', forbidden);
    expect(() => new DopbaseSDK({ host: HOST, token: TOKEN, refresh: 'ttl' })).not.toThrow();
  });

  it('refuses to run in a browser, but not in a jsdom test', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(() => create(fakeRuntime())).not.toThrow();
    vi.stubGlobal('process', undefined);
    expect(() => create(fakeRuntime())).toThrow(DopbaseConfigError);
  });

  it('warns when a background error has no listener', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const runtime = fakeRuntime({ A: '1' });
    const env = await create(runtime, { refresh: 'poll', interval: '15s' }).load();
    runtime.fail(503, 'INTERNAL_ERROR');
    await vi.advanceTimersByTimeAsync(18_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('returned 503'));
    env.close();
  });

  it('uses a waitUntil it finds on the platform', async () => {
    const waitUntil = vi.fn();
    vi.stubGlobal('EdgeRuntime', { waitUntil });
    const store = new MemoryStore();
    await create(fakeRuntime({ A: '1' }), { fallback: store }).load();
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
