import { join, relative, sep } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test-setup.ts'],
    resolveSnapshotPath(testPath, snapshotExtension) {
      const p = relative(__dirname, testPath);
      const parts = p.split(sep);
      parts[0] = 'snapshots';
      parts[parts.length - 1] = parts[parts.length - 1].replace(
        '.ts',
        snapshotExtension,
      );
      return join(__dirname, ...parts);
    },
  },
});
