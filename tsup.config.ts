import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  version: string;
};
const shared = {
  target: 'es2022',
  define: { __VERSION__: JSON.stringify(version) },
  external: ['cloudflare:workers', /^node:/],
  sourcemap: true,
  treeshake: true,
  removeNodeProtocol: false,
} as const;

export default defineConfig([
  {
    ...shared,
    // One build with shared chunks, so `@dopbase/sdk` and `@dopbase/sdk/testing` load the same
    // DopbaseSDK and error classes in every runtime. Splitting is off for CJS by default.
    entry: {
      index: 'src/index.ts',
      testing: 'src/testing.ts',
      node: 'src/node.ts',
      workerd: 'src/workerd.ts',
    },
    format: ['esm', 'cjs'],
    platform: 'neutral',
    splitting: true,
    dts: { entry: { index: 'src/index.ts', testing: 'src/testing.ts' } },
    // No `clean`: the configs build at the same time, and cleaning here deleted
    // register.d.ts from the next one. `npm run build` empties dist first.
  },
  {
    ...shared,
    entry: { register: 'src/register.ts' },
    format: ['esm'],
    platform: 'node',
    dts: true,
  },
  {
    ...shared,
    entry: { register: 'src/register.cts' },
    format: ['cjs'],
    platform: 'node',
  },
]);
