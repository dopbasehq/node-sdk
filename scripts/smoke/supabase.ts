// The user worker for the Supabase check. Bundled with the `deno` condition.
import * as sdk from '@dopbase/sdk';
import { checkFlows } from './flows.mjs';

const { DopbaseSDK } = sdk;

const env = new DopbaseSDK({ fallback: false });

Deno.serve(async () => {
  await env.load();
  const flows = await checkFlows(sdk).catch((error: Error) => error.message);
  if (flows !== 'ok') return new Response(flows);
  const waitUntil = typeof (globalThis as { EdgeRuntime?: { waitUntil?: unknown } }).EdgeRuntime
    ?.waitUntil;
  return new Response(`${env.get('SMOKE')} ${waitUntil}`);
});
