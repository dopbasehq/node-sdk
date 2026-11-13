const { DopbaseSDK } = require('@dopbase/sdk');

new DopbaseSDK({ refresh: 'once', fallback: false }).load().then((env) => {
  if (env.get('SMOKE') !== 'ok') throw new Error('unexpected value');
  console.log('OK node-cjs');
});
