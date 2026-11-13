import { hooks } from './hooks';

type EnvGlobals = typeof globalThis & {
  Deno?: { env?: { get(name: string): string | undefined } };
  Netlify?: { env?: { get(name: string): string | undefined } };
};

// On globalThis, not in module scope: `@dopbase/sdk/register` bundles its own copy
// of this module, and the app's DopbaseSDK must still find what register took.
const TAKEN = Symbol.for('dopbase.takenEnv');

function taken(): Map<string, string> {
  const g = globalThis as { [TAKEN]?: Map<string, string> };
  g[TAKEN] ??= new Map();
  return g[TAKEN];
}

/**
 * Removes `name` from `env` but keeps it for `readEnv`, so a later DopbaseSDK
 * in the same process still finds DOPBASE_TOKEN while child processes and
 * libraries reading `process.env` don't.
 */
export function takeEnv(env: Record<string, string | undefined>, name: string): void {
  const value = env[name];
  if (value === undefined) return;
  taken().set(name, value);
  delete env[name];
}

/**
 * Reads an env var from wherever the platform keeps them: the platform hook
 * (Cloudflare bindings), `process.env` (Node, Bun, Vercel, Workers with
 * `nodejs_compat`), `Deno.env` (Deno, Supabase) or `Netlify.env`, then what
 * `takeEnv` removed. An empty value counts as unset.
 */
export function readEnv(name: string): string | undefined {
  const g = globalThis as EnvGlobals;
  const sources: Array<() => unknown> = [
    () => hooks.env?.(name),
    () => g.process?.env?.[name],
    () => g.Deno?.env?.get(name),
    () => g.Netlify?.env?.get(name),
  ];
  for (const source of sources) {
    let value: unknown;
    try {
      value = source();
    } catch {
      // Deno throws without --allow-env; treat that source as empty.
      continue;
    }
    if (typeof value === 'string' && value !== '') return value;
  }
  return taken().get(name) || undefined;
}
