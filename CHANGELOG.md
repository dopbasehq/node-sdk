# Changelog

All notable changes to the Dopbase Node SDK are documented in this file.

## 0.1.0 - 2026-11-13

First release, published on npm as `@dopbase/sdk`. It loads an environment's
secrets from a Dopbase server at runtime on Node, Bun, Deno, Cloudflare
Workers, Vercel Edge and Supabase, and picks up changes without a restart.

### Added

- `DopbaseSDK` loads secrets from `GET /api/v1/runtime/secrets` with
  `DOPBASE_HOST` (or `DOPBASE_URL`) and `DOPBASE_TOKEN`. Set `DOPBASE_ENV` to
  check that the token belongs to the environment you expect.
- Refresh modes `'once'`, `'poll'` and `'ttl'`. The default, `'auto'`, polls
  on servers and uses `ttl` on serverless and edge. An unchanged environment
  costs a 304. See [Refresh](README.md#refresh-and-secret-rotation).
- `get`, `getAll`, `has` and `require`, typed and validated by any Standard
  Schema (zod, valibot, arktype), with `defaults` for missing keys.
- `onChange`, `onError`, `snapshot()` and `refresh()`.
- An encrypted copy of the last good values (a file, the Cache API or your own
  `CacheStore`) for cold starts, network errors and 5xx responses. See
  [Offline fallback](README.md#error-handling-and-offline-fallback).
- `load({ inject: true })` and `node --import @dopbase/sdk/register` fill
  `process.env` as a dotenv replacement, block names such as `NODE_OPTIONS`,
  and remove `DOPBASE_TOKEN` afterwards.
- `@dopbase/sdk/testing` with `TestDopbaseSDK` for app tests without a server.
