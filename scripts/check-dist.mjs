// Checks the published build: minified, no source maps, error classes keep their names.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const failures = [];
const files = readdirSync('dist');

for (const file of files) {
  if (file.endsWith('.map')) failures.push(`dist/${file} is a source map; the package ships none.`);
  if (!/\.(c?js)$/.test(file)) continue;
  const source = readFileSync(`dist/${file}`, 'utf8');
  if (source.includes('sourceMappingURL')) failures.push(`dist/${file} links a source map.`);
  // Readable output has many short, indented lines; minified output has few long ones.
  const lines = source.split('\n').filter((line) => line.trim() !== '');
  if (
    lines.length > 40 &&
    lines.filter((line) => /^ {2,}\S/.test(line)).length > lines.length / 4
  ) {
    failures.push(`dist/${file} doesn't look minified.`);
  }
}

const expected = [
  'DopbaseError',
  'DopbaseConfigError',
  'DopbaseAuthError',
  'DopbaseScopeError',
  'DopbaseNetworkError',
  'DopbaseServerError',
  'DopbaseValidationError',
  'DopbaseUnsupportedServerError',
];
const builds = {
  esm: await import(pathToFileURL(resolve('dist/index.js')).href),
  cjs: createRequire(pathToFileURL(resolve('package.json')))('./dist/index.cjs'),
};
for (const [format, sdk] of Object.entries(builds)) {
  for (const name of expected) {
    const ErrorClass = sdk[name];
    if (typeof ErrorClass !== 'function') {
      failures.push(`${format}: ${name} isn't exported.`);
      continue;
    }
    const error = new ErrorClass('check', name === 'DopbaseValidationError' ? [] : { code: 'X' });
    if (ErrorClass.name !== name || error.name !== name) {
      failures.push(
        `${format}: ${name} is named ${ErrorClass.name} / ${error.name} after the build.`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(
  `dist: minified, no source maps, ${expected.length} error classes named in ESM and CJS`,
);
