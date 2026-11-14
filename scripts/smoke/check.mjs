// Loads through the package's own exports, so each runtime picks its export condition.
import * as sdk from '@dopbase/sdk';
import { checkFlows } from './flows.mjs';

const { DopbaseSDK } = sdk;

const env = await new DopbaseSDK({ refresh: 'once', fallback: false }).load();
if (env.get('SMOKE') !== 'ok') throw new Error(`unexpected value ${env.get('SMOKE')}`);

await checkFlows(sdk);

// Unbundled, the SDK's files are under dist/. No error the app sees may start
// there, or Node and Bun would print minified SDK source above the message.
const refused = await new DopbaseSDK({
  refresh: 'once',
  fallback: false,
  retries: 0,
  fetch: async () => {
    throw Object.assign(new TypeError('Unable to connect'), { code: 'ECONNREFUSED' });
  },
})
  .load()
  .catch((error) => error);
const inSdk = (stack) => /[\\/]dist[\\/]/.test(stack ?? '');
if (inSdk(refused.stack) || inSdk(refused.cause?.stack)) {
  throw new Error(`error stack points into the SDK:\n${refused.stack}\n${refused.cause?.stack}`);
}

console.log(`OK ${process.argv[2] ?? globalThis.Deno?.args?.[0]}`);
