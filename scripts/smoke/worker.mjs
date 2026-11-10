import { DopbaseSDK } from '@dopbase/sdk';

const env = new DopbaseSDK({ fallback: false });

export default {
  async fetch(_request, _bindings, ctx) {
    await env.load({ waitUntil: (promise) => ctx.waitUntil(promise) });
    return new Response(env.get('SMOKE'));
  },
};
