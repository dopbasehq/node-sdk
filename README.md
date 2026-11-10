# Dopbase Node SDK

The official Node.js SDK for [Dopbase](https://dopbase.com), the open-source self-hosted secrets manager that ships as a single binary. It loads the secrets of a Dopbase environment into a Node, serverless or edge app at runtime with a runner token, so no `.env` file travels with your code.

The SDK keeps the values in memory, checks for changes with a conditional request, and keeps an encrypted copy so a cold start or a Dopbase outage doesn't take the app down. See [how Dopbase works](https://dopbase.com/how-it-works) for the server side.

It runs on Node 22+, Bun, Deno, Cloudflare Workers and Pages, Vercel Functions and Edge, Supabase Edge Functions, Netlify, and AWS Lambda. It has no runtime dependencies.

```bash
npm install dopbase
```

## Quick start

Create a runner token for the environment in the Dopbase Admin UI or with
`dopbase token create`, then set two env vars:

```bash
DOPBASE_HOST=acme.dopbase.dev
DOPBASE_TOKEN=dbs_...
```

```ts
import { DopbaseSDK } from "dopbase";

const env = new DopbaseSDK();
await env.load();

env.get("DATABASE_URL");
```

The token decides which environment you get, so the SDK needs nothing else.
Create the SDK once at module scope. `load()` does the network work, and calling
it again is cheap.

### Typed values

Pass any Standard Schema (zod, valibot, arktype) to check and type the values:

```ts
import { DopbaseSDK } from "dopbase";
import { z } from "zod";

const env = new DopbaseSDK({
  schema: z.object({
    DATABASE_URL: z.url(),
    PORT: z.coerce.number().default(3000),
  }),
});

await env.load();
env.get("PORT"); // number
```

If the values don't match, the first `load()` rejects with a
`DopbaseValidationError` that names the keys. It never includes the values.

### Reacting to changes

```ts
env.onChange(["DATABASE_URL"], (values, changes) => {
  pool.reconnect(values.DATABASE_URL);
});

env.onChange((values, { added, changed, removed }) => {
  console.log("secrets changed:", [...added, ...changed, ...removed]);
});
```

Both calls return an unsubscribe function. The diff holds key names only.

### Filling process.env

For code that reads `process.env` directly, inject the values at the top of the
entry file:

```ts
await new DopbaseSDK().load({ inject: true });
```

Or do it without touching the code. `--import` runs a module before the app's
entry file, like `node -r dotenv/config`:

```bash
node --import dopbase/register server.js
```

If the secrets can't be loaded, the app doesn't start.

Injection leaves variables that are already set alone unless you pass
`override: true`. It never sets `PATH`, `HOME`, `PS1`, `PS2`, or names starting
with `DOPBASE_`, `XDG_` or `LC_`. Names that make a program load extra code
(`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` and a few others) are
skipped with a warning unless you list them in `allow`. After loading,
`DOPBASE_TOKEN` is removed from `process.env`, so child processes and libraries
can't read it. Another `DopbaseSDK` in the same process still finds it, so an
app started with `dopbase/register` can create its own.

| Inject option     | Effect                                     |
| ----------------- | ------------------------------------------ |
| `override`        | Replace variables that are already set     |
| `only`, `exclude` | Inject only these keys, or never these     |
| `prefix`          | Inject only keys that start with this      |
| `allow`           | Code-loading names to inject anyway        |
| `keepToken`       | Leave `DOPBASE_TOKEN` in `process.env`     |
| `sync`            | Write later changes into `process.env` too |

### Replacing dotenv

dotenv reads a `.env` file from disk. This SDK reads the same values from your
Dopbase server, so they stay out of the repo and the build. Moving over takes
one line:

| dotenv                            | dopbase                                         |
| --------------------------------- | ----------------------------------------------- |
| `node -r dotenv/config server.js` | `node --import dopbase/register server.js`      |
| `import 'dotenv/config'`          | `await new DopbaseSDK().load({ inject: true })` |
| A `.env` file next to the app     | `DOPBASE_HOST` and `DOPBASE_TOKEN`              |

Code that reads `process.env` keeps working. For the background on `.env` files
and their limits, see
[dotenv explained](https://dopbase.com/blog/dotenv-explained).

## Configuration

| Env var             | Option  | Meaning                                                                                                                                                                                                                                                        |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOPBASE_HOST`      | `host`  | The server. `acme.dopbase.dev` means `https://acme.dopbase.dev`. A base path such as `https://example.com/dopbase` works. Plain `http://` is allowed only for `localhost`, `127.0.0.1` and `[::1]`. Falls back to `DOPBASE_URL`, the name the Dopbase CLI uses |
| `DOPBASE_TOKEN`     | `token` | A runner token: `dbs_` followed by 43 characters                                                                                                                                                                                                               |
| `DOPBASE_ENV`       | `env`   | Optional. The environment you expect (`env_…` or `project/env`). If the token belongs to another one, the server refuses before reading any value                                                                                                              |
| `DOPBASE_CACHE_DIR` |         | Where Node keeps the encrypted copy                                                                                                                                                                                                                            |

Options passed in code win over env vars. An unknown option is an error, so a
typo doesn't fail silently.

| Option     | Default                        | Notes                                                                      |
| ---------- | ------------------------------ | -------------------------------------------------------------------------- |
| `refresh`  | `'auto'`                       | `'once'`, `'poll'` or `'ttl'`. See below                                   |
| `interval` | `'5m'`                         | How often `'poll'` checks. Minimum `'15s'`                                 |
| `ttl`      | `'60s'`                        | How long `'ttl'` trusts values before checking again                       |
| `maxStale` | `'10m'`, or `ttl` if longer    | How stale `'ttl'` lets values get before `load()` waits for fresh ones     |
| `timeout`  | `'5s'`                         | Per request                                                                |
| `retries`  | `2`                            | After a network error, 5xx, 408 or 429                                     |
| `schema`   |                                | Any Standard Schema                                                        |
| `defaults` |                                | Values for keys the server doesn't return                                  |
| `fallback` | Platform store, `maxAge: '7d'` | `false` turns the stored copy off. You can also pass your own `CacheStore` |
| `fetch`    | Global `fetch`                 |                                                                            |
| `logger`   | `console.warn` for warnings    | `{ debug, warn }`. `DEBUG=dopbase` turns on debug logs                     |

Durations are milliseconds or strings such as `'500ms'`, `'30s'`, `'5m'`, `'1h'`
or `'7d'`.

## How values stay fresh

Every check sends the last ETag as `If-None-Match`. While nothing has changed,
Dopbase answers `304 Not Modified` without decrypting anything or writing an
audit event, so frequent checks are cheap. Each real change costs one full
response.

| `refresh` | What happens                                                                                                                                                                                                                                                                                        | Picked by `'auto'` on                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `'once'`  | One fetch at the first `load()`                                                                                                                                                                                                                                                                     |                                        |
| `'poll'`  | A check every `interval` in the background. Timers don't keep the process alive                                                                                                                                                                                                                     | Long-running servers (Node, Bun, Deno) |
| `'ttl'`   | Within `ttl`, `load()` returns at once. Between `ttl` and `maxStale`, it returns the old values and checks in the background through `waitUntil`. Past `maxStale`, or with no `waitUntil`, it waits for the check. After a failed check it keeps the old values for one `ttl` before checking again | Serverless and edge                    |

`refresh()` checks right away, whatever the mode. It rejects if the check fails,
and also while the server's current values fail the schema.

## Platforms

`new DopbaseSDK()` finds `DOPBASE_HOST` and `DOPBASE_TOKEN` on every platform
below. The package picks the right build through export conditions.

| Platform                                                   | Default refresh | Copy kept between cold starts                                                                                   | Background refresh                          |
| ---------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Node, Bun (servers, Docker)                                | `poll`          | Encrypted file                                                                                                  | Timers                                      |
| Deno (long-running)                                        | `poll`          | Cache API                                                                                                       | Timers                                      |
| Vercel Functions, AWS Lambda, Netlify Functions, Cloud Run | `ttl`           | Encrypted file in a per-user folder in the temp dir                                                             | Pass `waitUntil` where the platform has one |
| Vercel Edge                                                | `ttl`           | Memory only                                                                                                     | Pass `waitUntil` from `@vercel/functions`   |
| Cloudflare Workers and Pages                               | `ttl`           | Cache API, shared by the isolates in a data center                                                              | Pass `ctx.waitUntil`                        |
| Supabase Edge Functions                                    | `ttl`           | Memory only in practice: the runtime has a Cache API, but in local tests it didn't carry values to a new worker | Found on its own (`EdgeRuntime.waitUntil`)  |
| Netlify Edge Functions                                     | `ttl`           | Cache API if present                                                                                            | Pass `context.waitUntil`                    |

The SDK refuses to run in a browser, because a runner token must never reach
one. The Dopbase server must be reachable over HTTPS from wherever the code
runs.

### Cloudflare Workers

Put `DOPBASE_HOST` in `[vars]` and the token in a secret
(`wrangler secret put DOPBASE_TOKEN`). The SDK reads them through
`cloudflare:workers`, so `nodejs_compat` isn't needed.

```ts
import { DopbaseSDK } from "dopbase";

const env = new DopbaseSDK();

export default {
  async fetch(request, _env, ctx) {
    await env.load({ waitUntil: (promise) => ctx.waitUntil(promise) });
    return new Response(env.get("GREETING"));
  },
};
```

Workers don't allow network calls outside a request, so the constructor only
reads config. A cold isolate inside `ttl` reads the copy in the Cache API and
doesn't call Dopbase at all. The Cache API does nothing on `workers.dev`
subdomains, so there each cold isolate fetches once.

### Next.js and Vercel

```ts
// app/api/flags/route.ts, proxy.ts, or a Vercel Function
import { DopbaseSDK } from "dopbase";
import { waitUntil } from "@vercel/functions";

const env = new DopbaseSDK();

export async function GET() {
  await env.load({ waitUntil });
  return Response.json({ checkout: env.get("CHECKOUT_FLAG") });
}
```

To fill `process.env` for the whole Next.js server, load in
`instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { DopbaseSDK } = await import("dopbase");
    await new DopbaseSDK({ refresh: "once" }).load({ inject: true });
  }
}
```

The walkthrough
[Next.js environment variables with Dopbase](https://dopbase.com/blog/nextjs-environment-variables-dopbase)
covers the full setup.

### Supabase Edge Functions

```bash
supabase secrets set DOPBASE_HOST=acme.dopbase.dev DOPBASE_TOKEN=dbs_...
```

```ts
import { DopbaseSDK } from "npm:dopbase@0.1";

const env = new DopbaseSDK();

Deno.serve(async () => {
  await env.load();
  return Response.json({ ok: env.has("DATABASE_URL") });
});
```

Supabase doesn't promise to reuse an instance, so a new instance fetches once.
Background checks run through `EdgeRuntime.waitUntil`. When you serve locally,
set `policy = "per_worker"` under `[edge_runtime]` in `supabase/config.toml` so
instances aren't stopped after each request.

### AWS Lambda

```ts
import { DopbaseSDK } from "dopbase";

const env = new DopbaseSDK();

export const handler = async () => {
  await env.load();
  return { statusCode: 200, body: env.get("GREETING") };
};
```

Warm invocations read from memory. Lambda has no `waitUntil`, so once `ttl` has
passed the next `load()` waits for the check, which is usually a 304.

### Express, Fastify, NestJS

```ts
import { DopbaseSDK } from "dopbase";

const env = await new DopbaseSDK().load();
const app = express();
app.listen(Number(env.get("PORT") ?? 3000));
```

With NestJS, pass `() => env.getAll()` to
`ConfigModule.forRoot({ load: [...] })` after `await env.load()`.

## When things go wrong

| Situation                                                            | What the SDK does                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network error, timeout, 5xx, 408 or 429                              | Retries with backoff. If it still fails, keeps serving the values it has. On a cold start it uses the encrypted copy if it's younger than `fallback.maxAge`, and `snapshot().stale` is `true` |
| Token missing, revoked or expired (401), or not a runner token (403) | Never falls back. The first `load()` rejects with `DopbaseAuthError`. A running SDK keeps its values, reports the error and stops checking                                                    |
| `env` names another environment                                      | `DopbaseScopeError`                                                                                                                                                                           |
| Server too old to have `/api/v1/runtime/secrets`                     | `DopbaseUnsupportedServerError`                                                                                                                                                               |
| New values fail the schema                                           | The first `load()` rejects. Later, the old values stay, the error is reported once, `snapshot().stale` is `true`, and `refresh()` rejects until the server has values that pass               |
| No network and no stored copy                                        | `load()` rejects, so the app fails at startup instead of running without secrets                                                                                                              |

Background failures go to `onError` listeners, or to the logger if there are
none. They never crash the process.

```ts
env.onError((error) => {
  console.error(error.code, error.requestId, error.message);
});

env.snapshot();
// { project, environment, environmentId, revision, fetchedAt, source: 'live' | 'store', stale }
```

Every error extends `DopbaseError` and has a `code`, and, when it came from a
response, a `status` and the server's `requestId`.

## Security

- Error messages, logs, `JSON.stringify`, `String()` and `console.log` never
  show a secret value or the token. The token appears as `dbs_***`.
- The stored copy is encrypted with AES-256-GCM. The key is derived from the
  token and the host with HKDF, so another token can't read it. Files are
  readable by their owner only (mode 0600).
- Redirects are refused, and HTTPS is required except on localhost.
- Responses are checked the way `dopbase run` checks them: at most 1000 entries
  and 4 MiB, no empty or duplicate keys, no `=` or NUL in keys.

## Testing your app

`dopbase/testing` serves values from memory through the real response handling,
schema and change events:

```ts
import { TestDopbaseSDK } from "dopbase/testing";

const env = await new TestDopbaseSDK({ values: { FLAG: "off" } }).load();
await env.set({ FLAG: "on" }); // onChange listeners run before this resolves
```

## Other API

- `getAll()` returns every value, frozen.
- `require(key)` throws if the key isn't set.
- `has(key)` tells you whether a key is set.
- `close()` stops background checks. `await using env = new DopbaseSDK()` closes
  it for you.

## Requirements

A Dopbase server with the runtime gate (`GET /api/v1/runtime/secrets`) and a
runner token. Node 22 or later when running on Node.

## Learn more

- **Website**: [https://dopbase.com](https://dopbase.com)
- **Documentation**: [https://docs.dopbase.com](https://docs.dopbase.com/)
- **Blog**: [https://dopbase.com/blog](https://dopbase.com/blog)
- **Issues and feature requests**: [GitHub Issues](https://github.com/dopbasehq/node-sdk/issues)

## License

Apache-2.0
