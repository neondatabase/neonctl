import { join } from 'node:path';
import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('dev', () => {
  test('exits 1 when --source is missing', async ({ testCliCommand }) => {
    await testCliCommand(['dev'], { code: 1 });
  });

  test('exits 1 when --source points at a file that does not exist', async ({
    testCliCommand,
  }) => {
    const missing = join(process.cwd(), 'does-not-exist.ts');
    await testCliCommand(['dev', '--source', missing], { code: 1 });
  });
});
