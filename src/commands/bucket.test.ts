import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect } from 'vitest';
import { test } from '../test_utils/fixtures';

// A temp dir for the `object get` download target so the test never writes into
// the repo. Removed after the suite runs.
const TEST_TMP = mkdtempSync(join(tmpdir(), 'neonctl-bucket-'));
afterAll(() => {
  rmSync(TEST_TMP, { recursive: true, force: true });
});

describe('bucket', () => {
  test('object list', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
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

  test('object list with table output', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
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

  test('object list with prefix and delimiter', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
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

  test('object list with fully implicit project/branch resolution', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      ['bucket', 'object', 'list', '--bucket', 'my-bucket'],
      {
        mockDir: 'single_org',
      },
    );
  });

  test('object get downloads to the given file', async ({ testCliCommand }) => {
    const dest = join(TEST_TMP, 'downloaded.txt');
    await testCliCommand(
      [
        'bucket',
        'object',
        'get',
        'hello.txt',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
        '--bucket',
        'my-bucket',
        '--file',
        dest,
      ],
      {
        mockDir: 'single_org',
        stderr: `INFO: Object "hello.txt" downloaded from bucket "my-bucket" on branch br-main-branch-123456 to ${dest}`,
      },
    );
    expect(readFileSync(dest, 'utf8')).toEqual('hello world\n');
  });

  test('object delete', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
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

  test('object delete reports a helpful error when the object is missing', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
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

  test('object delete-folder removes every object under the prefix', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
        'delete-folder',
        'logs/',
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
          'INFO: Deleted 3 object(s) under prefix "logs/" from bucket "my-bucket" on branch br-main-branch-123456',
      },
    );
  });
});
