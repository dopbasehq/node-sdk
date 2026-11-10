import type { DopbaseOptions } from './config';
import { DopbaseSDK } from './sdk';

export interface TestDopbaseOptions<T> extends Pick<DopbaseOptions<T>, 'schema' | 'defaults'> {
  /** The secrets the fake server returns. */
  values?: Record<string, string>;
  project?: string;
  environment?: string;
}

const TEST_TOKEN = `dbs_${'t'.repeat(43)}`;

/**
 * A `DopbaseSDK` backed by an in-memory fake server, for app tests. It goes
 * through the real response handling, schema checks and change events.
 *
 * ```ts
 * const env = await new TestDopbaseSDK({ values: { DATABASE_URL: 'postgres://test' } }).load();
 * await env.set({ DATABASE_URL: 'postgres://other' }); // fires onChange
 * ```
 */
export class TestDopbaseSDK<
  T extends Record<string, unknown> = Record<string, string | undefined>,
> extends DopbaseSDK<T> {
  readonly #server: FakeServer;

  constructor(options: TestDopbaseOptions<T> = {}) {
    const server = new FakeServer(options);
    super({
      host: 'http://localhost',
      token: TEST_TOKEN,
      env: server.environmentId,
      refresh: 'once',
      fallback: false,
      fetch: server.fetch,
      ...(options.schema ? { schema: options.schema } : {}),
      ...(options.defaults ? { defaults: options.defaults } : {}),
    });
    this.#server = server;
  }

  /** Replaces every value. If loaded, refreshes so change listeners run before this resolves. */
  async set(values: Record<string, string>): Promise<void> {
    this.#server.values = { ...values };
    this.#server.revision++;
    if (this.snapshot()) await this.refresh();
  }
}

class FakeServer {
  values: Record<string, string>;
  revision = 1;
  readonly environmentId = 'env_000000';
  readonly #project: string;
  readonly #environment: string;

  constructor(options: TestDopbaseOptions<unknown>) {
    this.values = { ...options.values };
    this.#project = options.project ?? 'test-project';
    this.#environment = options.environment ?? 'test';
  }

  fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const etag = `"test-${this.revision}"`;
    const sent = new Headers(init?.headers).get('if-none-match');
    if (sent === etag) return new Response(null, { status: 304, headers: { etag } });
    const body = {
      success: true,
      message: 'RUNTIME_SECRETS_FETCHED',
      data: {
        projectId: 'prj_test',
        project: this.#project,
        environment: this.#environment,
        environmentId: this.environmentId,
        revision: `test-${this.revision}`,
        entries: Object.entries(this.values).map(([key, value]) => ({ key, value })),
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', etag },
    });
  };
}
