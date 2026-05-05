import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('data-api', () => {
  test('delete', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'data-api',
        'delete',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--database',
        'db1',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Data API deleted for db1 on branch br-main-branch-123456',
      },
    );
  });

  test('get', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'data-api',
        'get',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--database',
        'db1',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('get with table output', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'data-api',
        'get',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--database',
        'db1',
      ],
      { mockDir: 'single_org', outputTable: true },
    );
  });

  test('create', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'data-api',
        'create',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--database',
        'db1',
        '--auth-provider',
        'neon_auth',
        '--add-default-grants',
        '--db-schemas',
        'public,analytics',
        '--db-max-rows',
        '500',
      ],
      { mockDir: 'single_org' },
    );
  });
});
