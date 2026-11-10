import { DopbaseConfigError } from './errors';

export interface InjectOptions {
  /** Replace variables that are already set. Default `false`. */
  override?: boolean;
  /** Only these keys. */
  only?: readonly string[];
  /** Never these keys. */
  exclude?: readonly string[];
  /** Only keys that start with this. */
  prefix?: string;
  /** Code-loading names (`NODE_OPTIONS`, `LD_PRELOAD`, …) to inject anyway. */
  allow?: readonly string[];
  /** Leave `DOPBASE_TOKEN` in `process.env` after loading. Default `false`. */
  keepToken?: boolean;
  /** Write later changes into `process.env` too. Default `false`. */
  sync?: boolean;
}

// The same names `dopbase run` refuses to inject from stored secrets.
const RESERVED = new Set(['PATH', 'HOME', 'PS1', 'PS2']);
const RESERVED_PREFIXES = ['DOPBASE_', 'XDG_', 'LC_'];
export const CODE_LOADING = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PERL5OPT',
  'PYTHONWARNINGS',
  'BASH_ENV',
  'PROMPT_COMMAND',
  'JAVA_TOOL_OPTIONS',
  'PHPRC',
]);

export interface InjectResult {
  set: string[];
  /** Code-loading names skipped because `allow` didn't list them. */
  blocked: string[];
}

export function processEnv(): Record<string, string | undefined> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (!env) {
    throw new DopbaseConfigError(
      'This platform has no process.env to inject into. Read values with get() instead.',
      'INJECT_UNSUPPORTED',
    );
  }
  return env;
}

/**
 * Copies `values` into `env`. Keys this SDK set earlier (`owned`) may be
 * replaced or removed on a later sync; anything else is left alone unless
 * `override` is on.
 */
export function inject(
  env: Record<string, string | undefined>,
  values: Readonly<Record<string, string>>,
  options: InjectOptions,
  owned: Set<string>,
): InjectResult {
  const result: InjectResult = { set: [], blocked: [] };
  const only = options.only ? new Set(options.only) : undefined;
  const exclude = new Set(options.exclude ?? []);
  const allow = new Set(options.allow ?? []);
  const wanted = (key: string) =>
    (!only || only.has(key)) &&
    !exclude.has(key) &&
    (!options.prefix || key.startsWith(options.prefix)) &&
    !RESERVED.has(key) &&
    !RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));

  for (const [key, value] of Object.entries(values)) {
    if (!wanted(key)) continue;
    if (CODE_LOADING.has(key) && !allow.has(key)) {
      result.blocked.push(key);
      continue;
    }
    if (env[key] !== undefined && !options.override && !owned.has(key)) continue;
    env[key] = value;
    owned.add(key);
    result.set.push(key);
  }
  for (const key of [...owned]) {
    if (!Object.hasOwn(values, key)) {
      delete env[key];
      owned.delete(key);
    }
  }
  return result;
}
