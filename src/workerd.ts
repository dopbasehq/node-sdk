// The `workerd` export condition (Cloudflare Workers and Pages): reads
// DOPBASE_HOST and DOPBASE_TOKEN from the Worker's bindings, so
// `new DopbaseSDK()` needs no arguments.
import * as workers from 'cloudflare:workers';
import { hooks } from './platform/hooks';

const cloudflare = workers as {
  env?: Record<string, unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
};

hooks.env = (name) => {
  const value = cloudflare.env?.[name];
  return typeof value === 'string' ? value : undefined;
};
// Newer runtimes export waitUntil; older ones need ctx.waitUntil passed to load().
if (typeof cloudflare.waitUntil === 'function') {
  hooks.waitUntil = (promise) => cloudflare.waitUntil!(promise);
}

export * from './index';
