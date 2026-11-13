// Edge bundles must not import Node built-ins: Vercel Edge and Supabase would fail to load them.
import { readFileSync } from 'node:fs';

const edgeBundles = ['dist/index.js', 'dist/workerd.js', 'dist/testing.js'];
const pattern = /\bfrom\s*["'](node:[^"']+|fs|path|os|crypto)["']|\brequire\(\s*["']node:/;
let failed = false;
for (const file of edgeBundles) {
  const source = readFileSync(file, 'utf8');
  const chunks = [...source.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map(
    (m) => `dist/${m[1].slice(2)}`,
  );
  for (const path of [file, ...chunks]) {
    const text = path === file ? source : readFileSync(path, 'utf8');
    if (pattern.test(text)) {
      console.error(`${path} (used by ${file}) imports a Node built-in.`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('edge bundles: no Node built-ins');
