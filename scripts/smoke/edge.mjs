import { DopbaseSDK } from 'dopbase';

globalThis.smoke = async () => {
  const env = await new DopbaseSDK({ fallback: false }).load({ waitUntil: () => {} });
  return env.get('SMOKE');
};
