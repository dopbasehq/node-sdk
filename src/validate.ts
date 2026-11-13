import { type DopbaseIssue, DopbaseValidationError } from './errors';

export interface SecretEntry {
  key: string;
  value: string;
}

/** `data` of a `RUNTIME_SECRETS_FETCHED` response. */
export interface RuntimeSnapshot {
  projectId: string;
  project: string;
  environment: string;
  environmentId: string;
  /** Changes when a secret or the `.env` layout changes. */
  revision: string;
  entries: SecretEntry[];
}

// The server's own limit; the CLI checks the same.
export const MAX_ENTRIES = 1000;

/** The checks `dopbase run` makes before it trusts a response. */
export function validateSnapshot(data: unknown, requestId?: string): RuntimeSnapshot {
  const fail = (message: string, issues: DopbaseIssue[] = [{ message }]): never => {
    throw new DopbaseValidationError(`The runtime response was invalid: ${message}`, issues, {
      code: 'RESPONSE_INVALID',
      ...(requestId ? { requestId } : {}),
    });
  };
  if (typeof data !== 'object' || data === null) fail('data is missing.');
  const record = data as Record<string, unknown>;
  for (const field of ['projectId', 'project', 'environment', 'environmentId', 'revision']) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      fail(`${field} is empty.`);
    }
  }
  if (!Array.isArray(record.entries)) fail('entries is not a list.');
  const entries = record.entries as unknown[];
  if (entries.length > MAX_ENTRIES) fail(`more than ${MAX_ENTRIES} entries.`);
  const seen = new Set<string>();
  const clean: SecretEntry[] = [];
  for (const entry of entries) {
    const { key, value } = (entry ?? {}) as Record<string, unknown>;
    if (typeof key !== 'string' || typeof value !== 'string') fail('an entry is malformed.');
    const name = key as string;
    if (name === '') fail('an entry has an empty key.');
    if (name.includes('=') || name.includes('\0')) {
      fail(`key ${JSON.stringify(name)} contains '=' or NUL.`, [
        { key: name, message: "contains '=' or NUL" },
      ]);
    }
    if ((value as string).includes('\0')) {
      fail(`the value of ${name} contains NUL.`, [{ key: name, message: 'value contains NUL' }]);
    }
    if (seen.has(name)) {
      fail(`key ${name} appears twice.`, [{ key: name, message: 'duplicate key' }]);
    }
    seen.add(name);
    clean.push({ key: name, value: value as string });
  }
  return {
    projectId: record.projectId as string,
    project: record.project as string,
    environment: record.environment as string,
    environmentId: record.environmentId as string,
    revision: record.revision as string,
    entries: clean,
  };
}
