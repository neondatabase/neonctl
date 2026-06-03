import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('buckets', () => {
  test('objects list', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'buckets',
        'objects',
        'list',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--bucket',
        'my-bucket',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('objects list with table output', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'buckets',
        'objects',
        'list',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--bucket',
        'my-bucket',
      ],
      { mockDir: 'single_org', outputTable: true },
    );
  });

  test('objects list with prefix and delimiter', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'buckets',
        'objects',
        'list',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--bucket',
        'my-bucket',
        '--prefix',
        'logs/',
        '--delimiter',
        '/',
        '--limit',
        '100',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('objects list with fully implicit project/branch resolution', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      ['buckets', 'objects', 'list', '--bucket', 'my-bucket'],
      { mockDir: 'single_org' },
    );
  });

  test('objects delete', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'buckets',
        'objects',
        'delete',
        'hello.txt',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--bucket',
        'my-bucket',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Object "hello.txt" deleted from bucket "my-bucket" on branch br-main-branch-123456',
      },
    );
  });

  test('objects delete reports a helpful error when the object is missing', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'buckets',
        'objects',
        'delete',
        'missing.txt',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--bucket',
        'my-bucket',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: Object "missing.txt" not found in bucket "my-bucket" on branch br-main-branch-123456.',
      },
    );
  });
});
