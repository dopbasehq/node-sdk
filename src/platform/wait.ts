import { hooks } from './hooks';

export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * A platform's own `waitUntil`, so background refreshes survive after the
 * response: the `cloudflare:workers` export, or Supabase's
 * `EdgeRuntime.waitUntil`. Vercel and Netlify pass theirs to `load()`.
 */
export function discoverWaitUntil(): WaitUntil | undefined {
  if (hooks.waitUntil) return hooks.waitUntil;
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: WaitUntil } }).EdgeRuntime;
  if (typeof edgeRuntime === 'object' && typeof edgeRuntime?.waitUntil === 'function') {
    return (promise) => edgeRuntime.waitUntil!(promise);
  }
  return undefined;
}
