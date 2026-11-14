import * as sdk from '@dopbase/sdk';
import { checkFlows } from './flows.mjs';

const { DopbaseSDK } = sdk;

const env = new DopbaseSDK({ fallback: false });

export default {
  async fetch(_request, _bindings, ctx) {
    await env.load({ waitUntil: (promise) => ctx.waitUntil(promise) });
    const flows = await checkFlows(sdk).catch((error) => error.message);
    return new Response(flows === 'ok' ? env.get('SMOKE') : flows);
  },
};
