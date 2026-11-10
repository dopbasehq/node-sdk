import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TestDopbaseSDK } from '../src/testing';

describe('TestDopbaseSDK', () => {
  it('serves the given values and fires change events on set', async () => {
    const env = await new TestDopbaseSDK({ values: { FLAG: 'off' } }).load();
    const listener = vi.fn();
    env.onChange(listener);
    await env.set({ FLAG: 'on' });
    expect(env.get('FLAG')).toBe('on');
    expect(listener).toHaveBeenCalledWith(
      { FLAG: 'on' },
      { added: [], changed: ['FLAG'], removed: [] },
    );
  });

  it('runs the schema like the real SDK', async () => {
    const env = await new TestDopbaseSDK({
      values: { PORT: '8080' },
      schema: z.object({ PORT: z.coerce.number() }),
    }).load();
    expect(env.get('PORT')).toBe(8080);
    await expect(env.set({ PORT: 'eighty' })).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(env.get('PORT')).toBe(8080);
  });
});
