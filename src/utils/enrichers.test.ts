import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('enrichers', () => {
  test('fillSingleProject shows helpful error when org_id is required', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['branches', 'list'], {
      mockDir: 'multi_org',
      code: 1,
      stderr:
        'ERROR: --project-id is required. You can find your project ID by running: neon projects list Or set a default project with: neon set-context --project-id <project_id>',
    });
  });

  test('fillSingleProject works with project-id provided', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['branches', 'list', '--project-id', 'test'], {
      mockDir: 'multi_org',
    });
  });
});
