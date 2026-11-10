// A programmable stand-in for GET /api/v1/runtime/secrets, used through the `fetch` option.

export const TOKEN = `dbs_${'a'.repeat(43)}`;
export const HOST = 'https://acme.dopbase.dev';

export interface Call {
  url: string;
  headers: Headers;
}

type Step = (call: Call) => Response | Error | Promise<Response | Error>;

export function fakeRuntime(initial: Record<string, string> = {}) {
  let values = { ...initial };
  let revision = 1;
  const calls: Call[] = [];
  const steps: Step[] = [];

  const etag = () => `"etag-${revision}"`;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), headers: new Headers(init?.headers) };
    calls.push(call);
    const step = steps.shift();
    if (step) {
      const result = await step(call);
      if (result instanceof Error) throw result;
      return result;
    }
    if (call.headers.get('if-none-match') === etag()) {
      return new Response(null, { status: 304, headers: { etag: etag() } });
    }
    return ok(values, revision, etag());
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    /** Changes the values the server returns, with a new ETag. */
    set(next: Record<string, string>) {
      values = { ...next };
      revision++;
    },
    /** Answers the next request with `status` and a Dopbase error body. */
    fail(status: number, code = 'INTERNAL_ERROR', headers: Record<string, string> = {}) {
      steps.push(() => errorResponse(status, code, headers));
    },
    /** Makes the next request fail like an unreachable server. */
    unreachable() {
      steps.push(() => new TypeError('fetch failed'));
    },
    get etag() {
      return etag();
    },
  };
}

export function ok(values: Record<string, string>, revision = 1, etag = `"etag-${revision}"`) {
  return new Response(
    JSON.stringify({
      success: true,
      message: 'RUNTIME_SECRETS_FETCHED',
      data: {
        projectId: 'prj_1',
        project: 'payment-service',
        environment: 'production',
        environmentId: 'env_000123',
        revision: `rev-${revision}`,
        entries: Object.entries(values).map(([key, value]) => ({ key, value })),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json', etag, 'x-request-id': 'req-1' } },
  );
}

export function errorResponse(status: number, code: string, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({ success: false, error: { [code]: `server said ${code}` } }),
    {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-err', ...headers },
    },
  );
}
