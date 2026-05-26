import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/psql-conformance/**'],
  },
});
