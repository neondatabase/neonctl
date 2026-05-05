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

  test('update --replace', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'data-api',
        'update',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--database',
        'db1',
        '--replace',
        '--db-max-rows',
        '250',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Data API settings updated for db1 on branch br-main-branch-123456',
      },
    );
  });

  test('update merges with existing settings', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'data-api',
        'update',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--database',
        'db1',
        '--db-max-rows',
        '9999',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Data API settings updated for db1 on branch br-main-branch-123456',
      },
    );
  });

  test('update --replace with no flags refreshes schema cache', async ({
    testCliCommand,
  }) => {
    // Server treats an empty body as a no-op settings update + schema cache
    // refresh, so passing --replace alone is a valid (and useful) operation.
    await testCliCommand(
      [
        'data-api',
        'update',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--database',
        'db1',
        '--replace',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Data API settings updated for db1 on branch br-main-branch-123456',
      },
    );
  });

  test('delete with implicit database', async ({ testCliCommand }) => {
    // The single_org fixture has exactly one database (db1) on the main branch,
    // so omitting --database should resolve it automatically.
    await testCliCommand(
      [
        'data-api',
        'delete',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Data API deleted for db1 on branch br-main-branch-123456',
      },
    );
  });

  test('delete fails with helpful error when multiple databases', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'data-api',
        'delete',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org_multidb',
        code: 1,
        stderr:
          'ERROR: Multiple databases found for the branch, please provide one with the --database option: db1, db2',
      },
    );
  });
});
