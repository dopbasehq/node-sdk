// Loads through the package's own exports, so each runtime picks its export condition.
import { DopbaseSDK } from '@dopbase/sdk';

const env = await new DopbaseSDK({ refresh: 'once', fallback: false }).load();
if (env.get('SMOKE') !== 'ok') throw new Error(`unexpected value ${env.get('SMOKE')}`);
console.log(`OK ${process.argv[2] ?? globalThis.Deno?.args?.[0]}`);
