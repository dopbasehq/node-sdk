import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform } from '../../src/platform/detect';
import { readEnv } from '../../src/platform/env';
import { hooks } from '../../src/platform/hooks';
import { discoverWaitUntil } from '../../src/platform/wait';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete hooks.env;
  delete hooks.waitUntil;
});

function clearServerlessEnv() {
  for (const name of [
    'VERCEL',
    'AWS_LAMBDA_FUNCTION_NAME',
    'NETLIFY',
    'K_SERVICE',
    'FUNCTION_TARGET',
    'FUNCTIONS_WORKER_RUNTIME',
  ]) {
    vi.stubEnv(name, '');
  }
}

describe('detectPlatform', () => {
  it('sees a long-running Node server by default', () => {
    clearServerlessEnv();
    expect(detectPlatform()).toMatchObject({ name: 'server', longRunning: true });
    expect(detectPlatform().runtime).toMatch(/^node\//);
  });

  it.each([
    ['cloudflare', { navigator: { userAgent: 'Cloudflare-Workers' } }],
    ['supabase', { EdgeRuntime: { waitUntil: () => {} } }],
    ['vercel-edge', { EdgeRuntime: 'edge-runtime' }],
    ['netlify', { Netlify: { env: { get: () => undefined } } }],
  ])('sees %s', (name, globals) => {
    for (const [key, value] of Object.entries(globals)) vi.stubGlobal(key, value);
    expect(detectPlatform()).toMatchObject({ name, longRunning: false });
  });

  it('sees a browser only when no server runtime is there, so jsdom tests still run', () => {
    expect(detectPlatform({ window: {}, document: {} } as never).name).toBe('browser');
    clearServerlessEnv();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(detectPlatform().name).toBe('server');
  });

  it.each(['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'K_SERVICE'])(
    'sees serverless from %s',
    (name) => {
      clearServerlessEnv();
      vi.stubEnv(name, '1');
      expect(detectPlatform()).toMatchObject({ name: 'serverless', longRunning: false });
    },
  );
});

describe('readEnv', () => {
  it('prefers the platform hook, then process.env, then Deno.env, then Netlify.env', () => {
    vi.stubEnv('SDK_TEST_VAR', '');
    vi.stubGlobal('Deno', {
      env: { get: (name: string) => (name === 'SDK_TEST_VAR' ? 'deno' : undefined) },
    });
    vi.stubGlobal('Netlify', { env: { get: () => 'netlify' } });
    expect(readEnv('SDK_TEST_VAR')).toBe('deno');
    vi.stubEnv('SDK_TEST_VAR', 'process');
    expect(readEnv('SDK_TEST_VAR')).toBe('process');
    hooks.env = () => 'hook';
    expect(readEnv('SDK_TEST_VAR')).toBe('hook');
  });

  it('skips a source that throws, as Deno.env does without --allow-env', () => {
    vi.stubEnv('SDK_TEST_VAR', '');
    vi.stubGlobal('Deno', {
      env: {
        get: () => {
          throw new Error('PermissionDenied');
        },
      },
    });
    expect(readEnv('SDK_TEST_VAR')).toBeUndefined();
  });
});

describe('discoverWaitUntil', () => {
  it('finds Supabase’s EdgeRuntime.waitUntil and prefers a platform hook', () => {
    expect(discoverWaitUntil()).toBeUndefined();
    const supabase = vi.fn();
    vi.stubGlobal('EdgeRuntime', { waitUntil: supabase });
    const promise = Promise.resolve();
    discoverWaitUntil()!(promise);
    expect(supabase).toHaveBeenCalledWith(promise);
    const cloudflare = vi.fn();
    hooks.waitUntil = cloudflare;
    expect(discoverWaitUntil()).toBe(cloudflare);
  });
});
