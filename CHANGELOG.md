# Changelog

All notable changes to the Dopbase Node SDK are documented in this file.

## Unreleased

### Added

- The SDK is published on npm as `@dopbase/sdk`, which leaves the plain
  `dopbase` name for the Dopbase binary.
- `DopbaseSDK` loads the secrets of a runner token's environment from
  `GET /api/v1/runtime/secrets`. It reads `DOPBASE_HOST` (or the CLI's
  `DOPBASE_URL`) and `DOPBASE_TOKEN`, and `DOPBASE_ENV` checks that the token
  belongs to the environment you expect.
- `refresh: 'once' | 'poll' | 'ttl'`, with `'auto'` picking `poll` on
  servers and `ttl` on serverless and edge. `poll` checks every `'5m'` by
  default and refuses an `interval` under `'15s'`, to keep load on the server
  low. While the server is down it doubles the wait after each failed check,
  up to 30 minutes. Checks send the last ETag, so an
  unchanged environment costs a 304 with no audit event. After a failed
  check, `ttl` serves the held values for one ttl before `load()` waits again.
  `maxStale` defaults to `'10m'`, or to `ttl` when that's longer.
- `get`, `getAll`, `has` and `require`, typed and checked by any Standard
  Schema (zod, valibot, arktype), with `defaults` for keys the server lacks.
  A revision the schema refuses keeps the old values, marks them stale and
  makes `refresh()` reject.
- `onChange` with the added, changed and removed keys, `onError` for
  background failures, `snapshot()` and `refresh()`.
- An encrypted copy of the last good values: a file on Node and Bun (in a
  per-user temp folder on serverless), the Cache API on Cloudflare, Deno and
  Netlify, or your own `CacheStore`. Cold starts send its ETag, `ttl` serves
  it without a request, and network errors and 5xx fall back to it. Auth errors never do, and a copy that fails the
  schema or doesn't match `DOPBASE_ENV` is skipped.
- `load({ inject: true })` and `node --import @dopbase/sdk/register` fill
  `process.env`, skip reserved names, block code-loading names such as
  `NODE_OPTIONS` unless allowed, and remove `DOPBASE_TOKEN` afterwards. A
  `DopbaseSDK` created later in the same process still finds the token.
- Builds for Node, Cloudflare Workers (bindings read through
  `cloudflare:workers`), Vercel Edge, Deno and Supabase, with `waitUntil`
  passed to `load()` or found on Supabase.
- `@dopbase/sdk/testing` with `TestDopbaseSDK` for app tests without a server,
  including jsdom and happy-dom test environments.
- A README section on replacing dotenv with `@dopbase/sdk/register` or
  `load({ inject: true })`.
- README: install commands for pnpm, yarn, bun and deno, an FAQ, and links to
  the Dopbase docs and the server repository. The package description and
  keywords now mention TypeScript and self-hosting.
