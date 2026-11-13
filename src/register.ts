// `node --import @dopbase/sdk/register app.js`: loads the secrets into process.env
// before the app's entry file runs. The app doesn't start without them.
import { DopbaseSDK } from './node';

try {
  await new DopbaseSDK({ refresh: 'once' }).load({ inject: true });
} catch (error) {
  console.error(`[dopbase] ${(error as Error)?.message ?? error}`);
  process.exit(1);
}
