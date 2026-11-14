import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __VERSION__: JSON.stringify('test') },
  test: {
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    // Only used by `npm run test:coverage`. Sonar reads coverage/lcov.info.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.cts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      // A floor a little under today's numbers, so the run fails if coverage slips.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
