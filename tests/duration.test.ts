import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/duration';
import { DopbaseConfigError } from '../src/errors';

describe('parseDuration', () => {
  it.each([
    [1500, 1500],
    ['250ms', 250],
    ['30s', 30_000],
    ['1.5s', 1500],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
  ] as const)('reads %s', (input, expected) => {
    expect(parseDuration(input, 'ttl')).toBe(expected);
  });

  it.each([-1, Number.NaN, '30', '5 minutes', 's', ''])('refuses %s', (input) => {
    expect(() => parseDuration(input as never, 'ttl')).toThrow(DopbaseConfigError);
  });
});
