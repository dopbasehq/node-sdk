// Behavior every runtime has to share, run by each smoke check (Node, Bun, Deno,
// workerd, Vercel Edge, Supabase). It talks to an in-memory server through the
// `fetch` option, so the result doesn't depend on the runtime's network.

const TOKEN = `dbs_${'f'.repeat(43)}`;
const HOST = 'https://acme.dopbase.dev';

function server(...steps) {
  return async () => {
    const step = steps.shift();
    if (step) return step();
    const data = {
      projectId: 'prj_1',
      project: 'smoke',
      environment: 'ci',
      environmentId: 'env_000001',
      revision: 'r1',
      entries: [
        { key: 'A', value: 'live' },
        { key: 'PORT', value: 'eighty' },
      ],
    };
    return Response.json({ success: true, message: 'RUNTIME_SECRETS_FETCHED', data });
  };
}

const failWith = (status, code) => () =>
  Response.json({ success: false, error: { [code]: 'no' } }, { status });
const throws = (error) => () => {
  throw error;
};

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export async function checkFlows({ DopbaseSDK, DopbaseAuthError, MemoryStore }) {
  const make = (fetch, options = {}) =>
    new DopbaseSDK({
      host: HOST,
      token: TOKEN,
      refresh: 'once',
      fallback: false,
      retries: 0,
      fetch,
      ...options,
    });
  const failure = (promise) =>
    promise.then(
      () => undefined,
      (error) => error,
    );

  // Network failures get a code from the runtime's own error shape.
  const shapes = [
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    }),
    Object.assign(new TypeError('Unable to connect'), { code: 'ConnectionRefused' }),
    new TypeError('client error (Connect): tcp connect error: Connection refused (os error 61)'),
  ];
  for (const shape of shapes) {
    const error = await failure(make(server(throws(shape))).load());
    expect(error?.code === 'CONNECTION_REFUSED', `refused gave ${error?.code}: ${error?.message}`);
    expect(error.message.startsWith(`Nothing is answering at ${HOST}.`), error.message);
    const keys = Object.keys(error);
    expect(!keys.includes('status') && !keys.includes('requestId'), `empty fields: ${keys}`);
  }

  // The server's own errors keep their class, status and request id.
  const auth = await failure(make(server(failWith(401, 'AUTHENTICATION_INVALID'))).load());
  expect(
    auth instanceof DopbaseAuthError && auth.status === 401,
    `401 gave ${auth?.name} ${auth?.status}`,
  );

  // A schema error lists the key on its own line, never the value.
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'smoke',
      validate: (input) =>
        Number.isInteger(Number(input.PORT))
          ? { value: input }
          : { issues: [{ message: 'Expected a number', path: ['PORT'] }] },
    },
  };
  const invalid = await failure(make(server(), { schema }).load());
  const lines = invalid?.message.split('\n') ?? [];
  expect(invalid?.code === 'SCHEMA_INVALID', `schema gave ${invalid?.code}`);
  expect(lines[1] === '  - PORT: Expected a number', `schema message: ${invalid?.message}`);
  expect(
    !invalid.message.includes('eighty') && invalid.issues.length === 1,
    'schema leaked a value',
  );

  // With the server down, a second instance serves the stored copy.
  const store = new MemoryStore();
  await make(server(), { fallback: store }).load();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const offline = make(server(failWith(503, 'INSTANCE_RESETTING')), {
    fallback: store,
    logger: { warn() {} },
  });
  await offline.load();
  expect(
    offline.get('A') === 'live' && offline.snapshot().source === 'store',
    'no offline fallback',
  );

  return 'ok';
}
