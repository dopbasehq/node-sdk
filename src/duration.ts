import { DopbaseConfigError } from './errors';

/** Milliseconds, or a string such as `'500ms'`, `'30s'`, `'5m'`, `'1h'` or `'7d'`. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

/** The longest delay setTimeout takes. Longer ones fire after 1 ms instead. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: Duration, option: string): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return value;
  } else if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
    if (match) return Number(match[1]) * UNITS[match[2]!]!;
  }
  throw new DopbaseConfigError(
    `${option} must be a number of milliseconds or a duration like '30s', '5m' or '1h'.`,
  );
}
