// Loads the built package on every runtime available here, against a stand-in Dopbase server.
// Needs `npm run build` first. Bun and Deno are skipped when they aren't installed.
// SMOKE_SUPABASE=1 also runs Supabase's edge runtime in Docker (host networking).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeVM } from '@edge-runtime/vm';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const TOKEN = `dbs_${'s'.repeat(43)}`;
const server = createServer((req, res) => {
  if (req.url !== '/api/v1/runtime/secrets' || req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { AUTHENTICATION_INVALID: 'no' } }));
    return;
  }
  const data = {
    projectId: 'prj_smoke',
    project: 'smoke',
    environment: 'ci',
    environmentId: 'env_000001',
    revision: 'r1',
    entries: [{ key: 'SMOKE', value: 'ok' }],
  };
  res.writeHead(200, { 'content-type': 'application/json', etag: '"r1"' });
  res.end(JSON.stringify({ success: true, message: 'RUNTIME_SECRETS_FETCHED', data }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const host = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, DOPBASE_HOST: host, DOPBASE_TOKEN: TOKEN };
const failures = [];

// Async, so this process keeps serving the stand-in server while the child runs.
function run(name, command, args) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { env });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => {
      if (error.code === 'ENOENT') console.log(`skip ${name} (${command} not installed)`);
      else failures.push(name);
      resolve();
    });
    child.on('close', (status) => {
      if (status === 0 && output.includes('OK')) console.log(`ok   ${name}`);
      else if (status !== null) {
        failures.push(name);
        console.log(`FAIL ${name}\n${output}`);
      }
      resolve();
    });
  });
}

await run('node-esm', 'node', ['scripts/smoke/check.mjs', 'node-esm']);
await run('node-cjs', 'node', ['scripts/smoke/check.cjs']);
await run('node --import dopbase/register', 'node', [
  '--import',
  'dopbase/register',
  '-e',
  "if (process.env.SMOKE !== 'ok' || process.env.DOPBASE_TOKEN) process.exit(1); console.log('OK')",
]);
await run('bun', 'bun', ['scripts/smoke/check.mjs', 'bun']);
await run('deno', 'deno', [
  'run',
  '--allow-env',
  '--allow-net',
  '--allow-read',
  'scripts/smoke/check.mjs',
  'deno',
]);

async function bundle(entry, conditions, format) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format,
    platform: 'neutral',
    conditions,
    mainFields: ['module', 'main'],
    external: ['cloudflare:workers'],
    logLevel: 'error',
  });
  const code = result.outputFiles[0].text;
  if (/from\s*["']node:/.test(code)) throw new Error(`${entry} pulled in a Node built-in`);
  return code;
}

try {
  const script = await bundle('scripts/smoke/worker.mjs', ['workerd', 'worker'], 'esm');
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2025-06-01',
    bindings: { DOPBASE_HOST: host, DOPBASE_TOKEN: TOKEN },
  });
  const text = await (await mf.dispatchFetch('http://worker/')).text();
  await mf.dispose();
  if (text !== 'ok') throw new Error(text);
  console.log('ok   cloudflare workerd');
} catch (error) {
  failures.push('cloudflare workerd');
  console.log(`FAIL cloudflare workerd\n${error.stack ?? error}`);
}

try {
  const code = await bundle('scripts/smoke/edge.mjs', ['edge-light', 'worker'], 'iife');
  const vm = new EdgeVM({
    extend: (context) => {
      context.EdgeRuntime = 'edge-runtime';
      context.process = { env: { DOPBASE_HOST: host, DOPBASE_TOKEN: TOKEN } };
      return context;
    },
  });
  vm.evaluate(code);
  const value = await vm.evaluate('smoke()');
  if (value !== 'ok') throw new Error(value);
  console.log('ok   vercel edge-runtime');
} catch (error) {
  failures.push('vercel edge-runtime');
  console.log(`FAIL vercel edge-runtime\n${error.stack ?? error}`);
}

if (process.env.SMOKE_SUPABASE === '1') {
  const dir = mkdtempSync(join(tmpdir(), 'dopbase-supabase-'));
  const name = `dopbase-smoke-${process.pid}`;
  try {
    mkdirSync(join(dir, 'main'));
    mkdirSync(join(dir, 'check'));
    cpSync('scripts/smoke/supabase-main.ts', join(dir, 'main', 'index.ts'));
    writeFileSync(
      join(dir, 'check', 'index.js'),
      await bundle('scripts/smoke/supabase.ts', ['deno', 'worker'], 'esm'),
    );
    writeFileSync(join(dir, 'check', 'index.ts'), "import './index.js';\n");
    const image = process.env.SUPABASE_EDGE_RUNTIME_IMAGE ?? 'supabase/edge-runtime:v1.77.9';
    const start = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        name,
        '--network',
        'host',
        '-v',
        `${dir}:/home/deno/functions`,
        '-e',
        `DOPBASE_HOST=${host}`,
        '-e',
        `DOPBASE_TOKEN=${TOKEN}`,
        image,
        'start',
        '--main-service',
        '/home/deno/functions/main',
        '--port',
        '9123',
      ],
      { encoding: 'utf8' },
    );
    if (start.status !== 0) throw new Error(start.stderr);
    let text = '';
    for (let attempt = 0; attempt < 30 && !text; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      text = await fetch('http://127.0.0.1:9123/').then(
        (r) => r.text(),
        () => '',
      );
    }
    if (text !== 'ok function') throw new Error(text || 'no answer');
    console.log('ok   supabase edge-runtime');
  } catch (error) {
    failures.push('supabase edge-runtime');
    console.log(`FAIL supabase edge-runtime\n${error.stack ?? error}`);
  } finally {
    spawnSync('docker', ['rm', '-f', name]);
    rmSync(dir, { recursive: true, force: true });
  }
}

server.close();
if (failures.length > 0) {
  console.error(`\n${failures.length} runtime check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
