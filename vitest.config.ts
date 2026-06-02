import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Wire the shared fast-check global config (numRuns: 100) into every test run.
    setupFiles: ['./vitest.setup.ts'],
    // Per-package environments are selected via in-file `// @vitest-environment`
    // comments; node is a safe monorepo-wide default for pure-logic tests.
    environment: 'node',
    include: [
      'core/**/*.{test,spec}.ts',
      'client/**/*.{test,spec}.{ts,tsx}',
      'server/**/*.{test,spec}.ts',
    ],
  },
});
