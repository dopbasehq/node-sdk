import { afterEach, describe, expect, it, vi } from 'vitest';
import { inject } from '../src/inject';
import { DopbaseSDK } from '../src/sdk';
import { fakeRuntime, HOST, TOKEN } from './helpers/runtime';

describe('inject', () => {
  it('skips reserved names and code-loading names unless allowed', () => {
    const env: Record<string, string | undefined> = {};
    const result = inject(
      env,
      {
        APP: '1',
        PATH: '/evil',
        HOME: '/evil',
        DOPBASE_TOKEN: 'x',
        XDG_CONFIG_HOME: 'x',
        LC_ALL: 'x',
        NODE_OPTIONS: '--require ./evil.js',
        LD_PRELOAD: 'evil.so',
      },
      { allow: ['LD_PRELOAD'] },
      new Set(),
    );
    expect(env).toEqual({ APP: '1', LD_PRELOAD: 'evil.so' });
    expect(result.blocked).toEqual(['NODE_OPTIONS']);
  });

  it('leaves existing variables alone unless override is on', () => {
    const env: Record<string, string | undefined> = { A: 'mine' };
    inject(env, { A: 'theirs', B: '1' }, {}, new Set());
    expect(env).toEqual({ A: 'mine', B: '1' });
    inject(env, { A: 'theirs' }, { override: true }, new Set());
    expect(env.A).toBe('theirs');
  });

  it('filters with only, exclude and prefix', () => {
    const values = { APP_A: '1', APP_B: '2', OTHER: '3' };
    const only: Record<string, string | undefined> = {};
    inject(only, values, { only: ['APP_A', 'OTHER'], exclude: ['OTHER'] }, new Set());
    expect(only).toEqual({ APP_A: '1' });
    const prefixed: Record<string, string | undefined> = {};
    inject(prefixed, values, { prefix: 'APP_' }, new Set());
    expect(prefixed).toEqual({ APP_A: '1', APP_B: '2' });
  });

  it('updates and removes only the keys it set', () => {
    const env: Record<string, string | undefined> = { MINE: 'keep' };
    const owned = new Set<string>();
    inject(env, { A: '1', B: '1', toString: '1' }, {}, owned);
    inject(env, { A: '2' }, {}, owned);
    expect(env).toEqual({ MINE: 'keep', A: '2' });
    expect(Object.hasOwn(env, 'toString')).toBe(false);
  });
});

describe('load({ inject })', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of ['SDK_INJECT_A', 'SDK_INJECT_B']) delete process.env[key];
  });

  it('fills process.env and removes DOPBASE_TOKEN', async () => {
    vi.stubEnv('DOPBASE_TOKEN', TOKEN);
    await new DopbaseSDK({
      host: HOST,
      refresh: 'once',
      fallback: false,
      fetch: fakeRuntime({ SDK_INJECT_A: '1' }).fetch,
    }).load({ inject: true });
    expect(process.env.SDK_INJECT_A).toBe('1');
    expect(process.env.DOPBASE_TOKEN).toBeUndefined();
    // Another SDK in the same process, as with `--import dopbase/register` plus one in the app.
    const later = await new DopbaseSDK({
      host: HOST,
      refresh: 'once',
      fallback: false,
      fetch: fakeRuntime({ SDK_INJECT_A: '1' }).fetch,
    }).load();
    expect(later.get('SDK_INJECT_A')).toBe('1');
  });

  it('keeps the token and syncs later changes when asked', async () => {
    vi.stubEnv('DOPBASE_TOKEN', TOKEN);
    const runtime = fakeRuntime({ SDK_INJECT_A: '1' });
    const env = await new DopbaseSDK({
      host: HOST,
      refresh: 'once',
      fallback: false,
      fetch: runtime.fetch,
    }).load({ inject: { keepToken: true, sync: true } });
    expect(process.env.DOPBASE_TOKEN).toBe(TOKEN);

    runtime.set({ SDK_INJECT_B: '2' });
    await env.refresh();
    expect(process.env.SDK_INJECT_A).toBeUndefined();
    expect(process.env.SDK_INJECT_B).toBe('2');
  });
});
