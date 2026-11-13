import { DopbaseSDK } from '@dopbase/sdk';

globalThis.smoke = async () => {
  const env = await new DopbaseSDK({ fallback: false }).load({ waitUntil: () => {} });
  return env.get('SMOKE');
};
