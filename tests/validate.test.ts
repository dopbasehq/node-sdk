import { describe, expect, it } from 'vitest';
import { DopbaseValidationError } from '../src/errors';
import { MAX_ENTRIES, validateSnapshot } from '../src/validate';

const base = {
  projectId: 'prj_1',
  project: 'payment-service',
  environment: 'production',
  environmentId: 'env_000123',
  revision: 'abc',
  entries: [{ key: 'A', value: '1' }],
};

describe('validateSnapshot', () => {
  it('keeps only the known fields', () => {
    expect(validateSnapshot({ ...base, extra: true })).toEqual(base);
  });

  it.each([
    ['missing data', null],
    ['an empty project', { ...base, project: '' }],
    ['a missing revision', { ...base, revision: undefined }],
    ['entries that are not a list', { ...base, entries: {} }],
    ['a malformed entry', { ...base, entries: [{ key: 'A' }] }],
    ['an empty key', { ...base, entries: [{ key: '', value: 'x' }] }],
    ['a key with =', { ...base, entries: [{ key: 'A=B', value: 'x' }] }],
    ['a key with NUL', { ...base, entries: [{ key: 'A\0', value: 'x' }] }],
    ['a value with NUL', { ...base, entries: [{ key: 'A', value: 'x\0' }] }],
    [
      'a duplicate key',
      {
        ...base,
        entries: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      },
    ],
    [
      'too many entries',
      {
        ...base,
        entries: Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ key: `K${i}`, value: '' })),
      },
    ],
  ])('refuses %s', (_name, data) => {
    expect(() => validateSnapshot(data, 'req-9')).toThrow(DopbaseValidationError);
  });

  it('names the key but never the value', () => {
    try {
      validateSnapshot({ ...base, entries: [{ key: 'SECRET', value: 'hunter2\0' }] });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('SECRET');
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});
