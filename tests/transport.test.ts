import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DopbaseAuthError,
  DopbaseError,
  DopbaseNetworkError,
  DopbaseScopeError,
  DopbaseServerError,
  DopbaseUnsupportedServerError,
  DopbaseValidationError,
} from '../src/errors';
import { MAX_BODY_BYTES, RuntimeApi } from '../src/transport';
import { type Handler, sendJson, startServer } from './helpers/http';
import { TOKEN } from './helpers/runtime';

const snapshot = {
  projectId: 'prj_1',
  project: 'payment-service',
  environment: 'production',
  environmentId: 'env_000123',
  revision: 'rev-1',
  entries: [{ key: 'DATABASE_URL', value: 'postgres://db' }],
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function api(handler: Handler, options: { retries?: number; timeoutMs?: number } = {}) {
  const server = await startServer(handler);
  close = server.close;
  const runtime = new RuntimeApi({
    endpoint: `${server.url}/api/v1/runtime/secrets`,
    baseUrl: server.url,
    token: TOKEN,
    timeoutMs: options.timeoutMs ?? 2_000,
    retries: options.retries ?? 0,
    userAgent: 'dopbase-node/test node/test',
  });
  return { runtime, requests: server.requests };
}

describe('RuntimeApi', () => {
  it('sends the token and parses a 200 with its ETag', async () => {
    const { runtime, requests } = await api((_req, res) =>
      sendJson(
        res,
        200,
        { success: true, message: 'RUNTIME_SECRETS_FETCHED', data: snapshot },
        { etag: '"tag-1"', 'x-request-id': 'req-1' },
      ),
    );
    const result = await runtime.fetch(null);
    expect(result).toEqual({ status: 'fetched', etag: '"tag-1"', snapshot, requestId: 'req-1' });
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]!.headers['user-agent']).toBe('dopbase-node/test node/test');
    expect(requests[0]!.headers['if-none-match']).toBeUndefined();
  });

  it('sends If-None-Match and reads a 304', async () => {
    const { runtime, requests } = await api((_req, res) => {
      res.writeHead(304, { etag: '"tag-1"' });
      res.end();
    });
    expect(await runtime.fetch('"tag-1"')).toEqual({ status: 'unchanged', etag: '"tag-1"' });
    expect(requests[0]!.headers['if-none-match']).toBe('"tag-1"');
  });

  it.each([
    [401, 'AUTHENTICATION_INVALID', DopbaseAuthError],
    [403, 'RUNNER_TOKEN_REQUIRED', DopbaseAuthError],
    [403, 'TOKEN_SCOPE_INVALID', DopbaseScopeError],
    [403, 'AUTHORIZATION_DENIED', DopbaseAuthError],
    [404, 'REQUEST_INVALID', DopbaseUnsupportedServerError],
    [503, 'INSTANCE_RESETTING', DopbaseServerError],
    [429, 'RATE_LIMITED', DopbaseServerError],
    [400, 'REQUEST_INVALID', DopbaseError],
  ])('maps %i %s', async (status, code, type) => {
    const { runtime } = await api((_req, res) =>
      sendJson(res, status, { success: false, error: { [code]: 'nope' } }, { 'x-request-id': 'r' }),
    );
    const error = await runtime.fetch(null).catch((e) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ code, status, requestId: 'r' });
    expect(error.message).not.toContain(TOKEN);
  });

  it('says the token must be a runner token only when the server says so', async () => {
    const message = async (code: string) => {
      const { runtime } = await api((_req, res) =>
        sendJson(res, 403, { success: false, error: { [code]: 'nope' } }),
      );
      const error = await runtime.fetch(null).catch((e) => e);
      await close?.();
      return error.message as string;
    };
    expect(await message('RUNNER_TOKEN_REQUIRED')).toContain('needs a runner token');
    expect(await message('AUTHORIZATION_DENIED')).not.toContain('needs a runner token');
  });

  it('retries a 5xx, then succeeds', async () => {
    let calls = 0;
    const { runtime } = await api(
      (_req, res) =>
        ++calls < 3
          ? sendJson(res, 502, { success: false, error: { INTERNAL_ERROR: 'x' } })
          : sendJson(res, 200, { success: true, data: snapshot }, { etag: '"t"' }),
      { retries: 2 },
    );
    expect((await runtime.fetch(null)).status).toBe('fetched');
    expect(calls).toBe(3);
  });

  it('never retries an auth error', async () => {
    let calls = 0;
    const { runtime } = await api(
      (_req, res) => {
        calls++;
        sendJson(res, 401, { success: false, error: { AUTHENTICATION_INVALID: 'x' } });
      },
      { retries: 2 },
    );
    await expect(runtime.fetch(null)).rejects.toBeInstanceOf(DopbaseAuthError);
    expect(calls).toBe(1);
  });

  it('gives up at once when Retry-After is long', async () => {
    let calls = 0;
    const { runtime } = await api(
      (_req, res) => {
        calls++;
        sendJson(
          res,
          429,
          { success: false, error: { RATE_LIMITED: 'x' } },
          { 'retry-after': '60' },
        );
      },
      { retries: 2 },
    );
    await expect(runtime.fetch(null)).rejects.toBeInstanceOf(DopbaseServerError);
    expect(calls).toBe(1);
  });

  it('refuses redirects', async () => {
    const { runtime } = await api((_req, res) => {
      res.writeHead(302, { location: 'https://evil.example/collect' });
      res.end();
    });
    await expect(runtime.fetch(null)).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
  });

  it('refuses a body over 4 MiB', async () => {
    const { runtime } = await api((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(MAX_BODY_BYTES + 1));
    });
    await expect(runtime.fetch(null)).rejects.toBeInstanceOf(DopbaseValidationError);
  });

  it('refuses a body that is not the envelope', async () => {
    const { runtime } = await api((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login</html>');
    });
    const error = await runtime.fetch(null).catch((e) => e);
    expect(error).toMatchObject({ code: 'RESPONSE_INVALID' });
    expect(error.message).toContain('DOPBASE_HOST');
  });

  it('times out', async () => {
    const { runtime } = await api(() => {}, { timeoutMs: 100 });
    await expect(runtime.fetch(null)).rejects.toMatchObject({
      name: 'DopbaseNetworkError',
      code: 'TIMEOUT',
    });
  });

  it('treats a timeout longer than a timer can wait as the longest one', async () => {
    const { runtime } = await api(
      (_req, res) => sendJson(res, 200, { success: true, data: snapshot }),
      {
        timeoutMs: 30 * 86_400_000,
      },
    );
    expect((await runtime.fetch(null)).status).toBe('fetched');
  });

  it('unhooks its abort listeners where AbortSignal.any is missing', async () => {
    const statics = AbortSignal as { any?: unknown };
    const any = statics.any;
    statics.any = undefined;
    try {
      const { runtime } = await api(
        (_req, res) => sendJson(res, 200, { success: true, data: snapshot }),
        { timeoutMs: 100 },
      );
      const controller = new AbortController();
      for (let i = 0; i < 3; i++) await runtime.fetch(null, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      statics.any = any;
    }
  });

  it('reports an unreachable server', async () => {
    const runtime = new RuntimeApi({
      endpoint: 'http://127.0.0.1:9/api/v1/runtime/secrets',
      baseUrl: 'http://127.0.0.1:9',
      token: TOKEN,
      timeoutMs: 2_000,
      retries: 0,
      userAgent: 'test',
    });
    const error = await runtime.fetch(null).catch((e) => e);
    expect(error).toBeInstanceOf(DopbaseNetworkError);
    expect(error.code).toBe('NETWORK_ERROR');
  });
});
