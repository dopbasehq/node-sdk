import * as sdk from '@dopbase/sdk';
import { checkFlows } from './flows.mjs';

const { DopbaseSDK } = sdk;

globalThis.smoke = async () => {
  const env = await new DopbaseSDK({ fallback: false }).load({ waitUntil: () => {} });
  const flows = await checkFlows(sdk).catch((error) => error.message);
  return flows === 'ok' ? env.get('SMOKE') : flows;
};
