import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeHost, resolveConfig } from '../src/config';
import { DopbaseConfigError } from '../src/errors';
import type { PlatformInfo } from '../src/platform/detect';
import { TOKEN } from './helpers/runtime';

const server: PlatformInfo = { name: 'server', longRunning: true, runtime: 'node/test' };
const edge: PlatformInfo = { name: 'cloudflare', longRunning: false, runtime: 'workerd' };

function clearDopbaseEnv() {
  for (const name of ['DOPBASE_HOST', 'DOPBASE_URL', 'DOPBASE_TOKEN', 'DOPBASE_ENV']) {
    vi.stubEnv(name, '');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeHost', () => {
  it.each([
    ['acme.dopbase.dev', 'https://acme.dopbase.dev'],
    ['https://acme.dopbase.dev/', 'https://acme.dopbase.dev'],
    ['https://example.com/dopbase/', 'https://example.com/dopbase'],
    ['https://acme.dopbase.dev:8443', 'https://acme.dopbase.dev:8443'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    ['  acme.dopbase.dev  ', 'https://acme.dopbase.dev'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each([
    ['http://acme.dopbase.dev', 'HOST_INSECURE'],
    ['dop://dbs_x@acme.dopbase.dev', 'HOST_INVALID'],
    ['ftp://acme.dopbase.dev', 'HOST_INVALID'],
    ['https://user:pass@acme.dopbase.dev', 'HOST_INVALID'],
    ['https://acme.dopbase.dev?x=1', 'HOST_INVALID'],
    ['https://', 'HOST_INVALID'],
    ['', 'HOST_MISSING'],
    [undefined, 'HOST_MISSING'],
  ])('refuses %s with %s', (input, code) => {
    expect(() => normalizeHost(input)).toThrow(expect.objectContaining({ code }));
  });
});

describe('resolveConfig', () => {
  it('reads DOPBASE_HOST, DOPBASE_TOKEN and DOPBASE_ENV', () => {
    clearDopbaseEnv();
    vi.stubEnv('DOPBASE_HOST', 'acme.dopbase.dev');
    vi.stubEnv('DOPBASE_TOKEN', TOKEN);
    vi.stubEnv('DOPBASE_ENV', 'payment-service/production');
    const config = resolveConfig({}, server);
    expect(config.baseUrl).toBe('https://acme.dopbase.dev');
    expect(config.token).toBe(TOKEN);
    expect(config.endpoint).toBe(
      'https://acme.dopbase.dev/api/v1/runtime/secrets?reference=payment-service%2Fproduction',
    );
  });

  it('falls back to the CLI’s DOPBASE_URL', () => {
    clearDopbaseEnv();
    vi.stubEnv('DOPBASE_URL', 'https://cli.dopbase.dev');
    expect(resolveConfig({ token: TOKEN }, server).baseUrl).toBe('https://cli.dopbase.dev');
  });

  it('lets options win over env vars', () => {
    clearDopbaseEnv();
    vi.stubEnv('DOPBASE_HOST', 'env.dopbase.dev');
    vi.stubEnv('DOPBASE_ENV', 'from-env');
    const config = resolveConfig(
      { host: 'option.dopbase.dev', token: TOKEN, env: 'env_1' },
      server,
    );
    expect(config.baseUrl).toBe('https://option.dopbase.dev');
    expect(config.reference).toBe('env_1');
  });

  it('applies the defaults', () => {
    clearDopbaseEnv();
    const config = resolveConfig({ host: 'acme.dopbase.dev', token: TOKEN }, server);
    expect(config).toMatchObject({
      endpoint: 'https://acme.dopbase.dev/api/v1/runtime/secrets',
      reference: undefined,
      intervalMs: 300_000,
      ttlMs: 60_000,
      maxStaleMs: 600_000,
      timeoutMs: 5_000,
      retries: 2,
      fallbackMaxAgeMs: 7 * 86_400_000,
    });
    // An unset maxStale grows with a longer ttl instead of refusing it.
    expect(
      resolveConfig({ host: 'acme.dopbase.dev', token: TOKEN, ttl: '1h' }, server).maxStaleMs,
    ).toBe(3_600_000);
  });

  it('picks poll on servers and ttl on edge for auto', () => {
    const base = { host: 'acme.dopbase.dev', token: TOKEN };
    expect(resolveConfig(base, server).refresh).toBe('poll');
    expect(resolveConfig(base, edge).refresh).toBe('ttl');
    expect(resolveConfig({ ...base, refresh: 'once' }, edge).refresh).toBe('once');
  });

  it('names a missing or malformed token without printing it', () => {
    clearDopbaseEnv();
    const host = 'acme.dopbase.dev';
    expect(() => resolveConfig({ host }, server)).toThrow(
      expect.objectContaining({ code: 'TOKEN_MISSING' }),
    );
    const bad = 'dbs_tooshort-secret-value';
    try {
      resolveConfig({ host, token: bad }, server);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'TOKEN_INVALID' });
      expect(String((error as Error).message)).not.toContain(bad);
    }
  });

  it.each([
    [{ refresh: 'stream' }, /change events/],
    [{ refresh: 'sometimes' }, /refresh must be/],
    [{ interval: '1s' }, /at least '15s'/],
    [{ interval: '14s' }, /at least '15s'/],
    [{ ttl: '5m', maxStale: '1m' }, /maxStale/],
    [{ timeout: 0 }, /timeout/],
    [{ retries: 9 }, /retries/],
    [{ refesh: 'poll' }, /Unknown option: refesh/],
  ])('refuses %o', (extra, message) => {
    expect(() =>
      resolveConfig({ host: 'acme.dopbase.dev', token: TOKEN, ...(extra as object) }, server),
    ).toThrow(DopbaseConfigError);
    expect(() =>
      resolveConfig({ host: 'acme.dopbase.dev', token: TOKEN, ...(extra as object) }, server),
    ).toThrow(message);
  });

  it('reads fallback.maxAge', () => {
    const config = resolveConfig(
      { host: 'acme.dopbase.dev', token: TOKEN, fallback: { maxAge: '1d' } },
      server,
    );
    expect(config.fallbackMaxAgeMs).toBe(86_400_000);
  });
});
