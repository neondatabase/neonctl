import { join } from 'node:path';
import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('dev', () => {
  test('exits 1 when no --source and no neon.ts is found', async ({
    testCliCommand,
  }) => {
    // Runs in the repo root, which has no neon.ts: nothing to serve.
    await testCliCommand(['dev'], {
      code: 1,
      stderr:
        'ERROR: No --source given and no neon.ts found. Pass --source <path> ' +
        'to run a single function, or add a neon.ts that declares functions ' +
        'under `preview.functions`.',
    });
  });

  test('exits 1 when --port is given without --source', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['dev', '--port', '3000'], {
      code: 1,
      stderr:
        'ERROR: --port can only be used with --source. To set ports for the ' +
        'functions in neon.ts, give each one a `dev.port` in its config.',
    });
  });

  test('exits 1 when --source points at a file that does not exist', async ({
    testCliCommand,
  }) => {
    const missing = join(process.cwd(), 'does-not-exist.ts');
    await testCliCommand(['dev', '--source', missing], { code: 1 });
  });
});
