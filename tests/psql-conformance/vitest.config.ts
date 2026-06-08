// Separate vitest config for the psql-conformance suite.
//
// Differences from the project root config (../../vitest.config.ts):
//   * longer per-test timeout — container boot + a multi-thousand line
//     psql script need more headroom than the unit tests
//   * custom reporter that prints the conformance headline metric
//   * globalSetup that boots postgres once for the whole run

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const here = resolve(__dirname);

export default defineConfig({
  test: {
    root: here,
    include: ['**/*.spec.ts', 'harness/**/*.test.ts'],
    exclude: ['vendor/**', 'node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    globalSetup: [resolve(here, 'harness', 'global-setup.ts')],
    reporters: ['default', resolve(here, 'harness', 'reporter.ts')],
    // Each spec gets its own worker so the container connection
    // remains valid across the whole file's tests.
    fileParallelism: false,
  },
});
