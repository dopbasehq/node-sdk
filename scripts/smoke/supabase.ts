// The user worker for the Supabase check. Bundled with the `deno` condition.
import { DopbaseSDK } from 'dopbase';

const env = new DopbaseSDK({ fallback: false });

Deno.serve(async () => {
  await env.load();
  const waitUntil = typeof (globalThis as { EdgeRuntime?: { waitUntil?: unknown } }).EdgeRuntime
    ?.waitUntil;
  return new Response(`${env.get('SMOKE')} ${waitUntil}`);
});
