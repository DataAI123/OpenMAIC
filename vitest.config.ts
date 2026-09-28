import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Some import and PPTX suites are memory-heavy. Keep broad runs stable on
    // developer machines instead of starting one worker per reported CPU.
    maxWorkers: 2,
  },
});
