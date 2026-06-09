import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the CLI's package.json for version metadata. In the built CLI it sits right next to
 * this module (the build copies it into `dist`); when running from source (tests, `tsx`) it
 * does not, so we walk up to the nearest `package.json`. Both layouts resolve to the same
 * file, keeping `pkg.version` correct everywhere without a test-only shim.
 */
const loadPkg = (): { name: string; version: string } => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
        name: string;
        version: string;
      };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error('Could not locate package.json for version detection.');
      }
      dir = parent;
    }
  }
};

export default loadPkg();
