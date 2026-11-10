import { readEnv } from './env';

export type PlatformName =
  | 'cloudflare'
  | 'supabase'
  | 'vercel-edge'
  | 'netlify'
  | 'deno-deploy'
  | 'serverless'
  | 'server'
  | 'browser';

export interface PlatformInfo {
  name: PlatformName;
  /** Timers keep running between requests, so polling works. */
  longRunning: boolean;
  /** `runtime/version` for the User-Agent header. */
  runtime: string;
}

const SERVERLESS_ENV = [
  'VERCEL',
  'AWS_LAMBDA_FUNCTION_NAME',
  'NETLIFY',
  'K_SERVICE',
  'FUNCTION_TARGET',
  'FUNCTIONS_WORKER_RUNTIME',
];

type Globals = typeof globalThis & {
  EdgeRuntime?: unknown;
  Netlify?: unknown;
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
  window?: unknown;
  document?: unknown;
};

export function detectPlatform(g: Globals = globalThis as Globals): PlatformInfo {
  const runtime = runtimeName(g);
  const edgeRuntime = g.EdgeRuntime as { waitUntil?: unknown } | string | undefined;
  if (g.navigator?.userAgent === 'Cloudflare-Workers') {
    return { name: 'cloudflare', longRunning: false, runtime: 'workerd' };
  }
  if (typeof edgeRuntime === 'object' && typeof edgeRuntime?.waitUntil === 'function') {
    return { name: 'supabase', longRunning: false, runtime };
  }
  if (typeof edgeRuntime === 'string') {
    return { name: 'vercel-edge', longRunning: false, runtime: 'edge-runtime' };
  }
  if (typeof g.Netlify === 'object' && g.Netlify !== null) {
    return { name: 'netlify', longRunning: false, runtime };
  }
  if (g.Deno && readEnv('DENO_DEPLOYMENT_ID')) {
    return { name: 'deno-deploy', longRunning: false, runtime };
  }
  if (SERVERLESS_ENV.some((name) => readEnv(name) !== undefined)) {
    return { name: 'serverless', longRunning: false, runtime };
  }
  // jsdom and happy-dom test environments add window and document to Node, Bun or Deno.
  if (runtime === 'unknown' && typeof g.window === 'object' && typeof g.document === 'object') {
    return { name: 'browser', longRunning: true, runtime };
  }
  return { name: 'server', longRunning: true, runtime };
}

function runtimeName(g: Globals): string {
  if (g.Bun?.version) return `bun/${g.Bun.version}`;
  if (g.Deno?.version?.deno) return `deno/${g.Deno.version.deno}`;
  const node = g.process?.versions?.node;
  return node ? `node/${node}` : 'unknown';
}
