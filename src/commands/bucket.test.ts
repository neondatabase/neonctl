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

const SCOPE = [
  '--project-id',
  'test-project-123456',
  '--branch',
  'main',
] as const;

describe('bucket', () => {
  test('create with default access level', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'create', 'my-bucket', ...SCOPE], {
      mockDir: 'single_org',
      stderr:
        'INFO: Bucket "my-bucket" (private) created on branch br-main-branch-123456',
    });
  });

  test('create with public_read access level', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'bucket',
        'create',
        'my-bucket',
        '--access-level',
        'public_read',
        ...SCOPE,
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Bucket "my-bucket" (public_read) created on branch br-main-branch-123456',
      },
    );
  });

  test('list (yaml)', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'list', ...SCOPE], {
      mockDir: 'single_org',
    });
  });

  test('list with table output', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'list', ...SCOPE], {
      mockDir: 'single_org',
      outputTable: true,
    });
  });

  test('ls alias lists buckets', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'ls', ...SCOPE], {
      mockDir: 'single_org',
    });
  });

  test('delete', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'delete', 'my-bucket', ...SCOPE], {
      mockDir: 'single_org',
      stderr:
        'INFO: Bucket "my-bucket" deleted from branch br-main-branch-123456',
    });
  });

  test('rm alias deletes a bucket', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'rm', 'my-bucket', ...SCOPE], {
      mockDir: 'single_org',
      stderr:
        'INFO: Bucket "my-bucket" deleted from branch br-main-branch-123456',
    });
  });

  test('delete reports a helpful error when the bucket is missing', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['bucket', 'delete', 'no-such-bucket', ...SCOPE], {
      mockDir: 'single_org',
      code: 1,
      stderr:
        'ERROR: Bucket "no-such-bucket" not found on branch br-main-branch-123456.',
    });
  });

  test('object list', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'object', 'list', 'my-bucket', ...SCOPE], {
      mockDir: 'single_org',
    });
  });

  test('object list with table output', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'object', 'list', 'my-bucket', ...SCOPE], {
      mockDir: 'single_org',
      outputTable: true,
    });
  });

  test('object ls alias', async ({ testCliCommand }) => {
    await testCliCommand(['bucket', 'object', 'ls', 'my-bucket', ...SCOPE], {
      mockDir: 'single_org',
    });
  });

  // The objects mock echoes the received query back into the response, so the
  // snapshot proves prefix/delimiter/limit were actually forwarded (it would
  // differ if a param were dropped).
  test('object list forwards prefix, delimiter and limit', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
        'list',
        'my-bucket/logs/',
        '--delimiter',
        '/',
        '--limit',
        '100',
        ...SCOPE,
      ],
      { mockDir: 'single_org' },
    );
  });

  test('object list with fully implicit project/branch resolution', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['bucket', 'object', 'list', 'my-bucket'], {
      mockDir: 'single_org',
    });
  });

  test('object get downloads to the given file', async ({ testCliCommand }) => {
    const dest = join(TEST_TMP, 'downloaded.txt');
    await testCliCommand(
      [
        'bucket',
        'object',
        'get',
        'my-bucket/hello.txt',
        '--file',
        dest,
        ...SCOPE,
      ],
      {
        mockDir: 'single_org',
        stderr: `INFO: Object "hello.txt" downloaded from bucket "my-bucket" on branch br-main-branch-123456 to ${dest}`,
      },
    );
    expect(readFileSync(dest, 'utf8')).toEqual('hello world\n');
  });

  test('object get downloads a nested key', async ({ testCliCommand }) => {
    const dest = join(TEST_TMP, 'nested.txt');
    await testCliCommand(
      [
        'bucket',
        'object',
        'get',
        'my-bucket/dir/file.txt',
        '--file',
        dest,
        ...SCOPE,
      ],
      {
        mockDir: 'single_org',
        stderr: `INFO: Object "dir/file.txt" downloaded from bucket "my-bucket" on branch br-main-branch-123456 to ${dest}`,
      },
    );
    expect(readFileSync(dest, 'utf8')).toEqual('nested file contents\n');
  });

  test('object get without a key is rejected client-side', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['bucket', 'object', 'get', 'my-bucket', ...SCOPE], {
      mockDir: 'single_org',
      code: 1,
      stderr: 'ERROR: Object target must be in the form <bucket>/<key>.',
    });
  });

  test('object get surfaces the server message when the object is missing', async ({
    testCliCommand,
  }) => {
    const dest = join(TEST_TMP, 'missing.txt');
    await testCliCommand(
      [
        'bucket',
        'object',
        'get',
        'my-bucket/missing.txt',
        '--file',
        dest,
        ...SCOPE,
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr: 'ERROR: Not Found',
      },
    );
  });

  test('object delete', async ({ testCliCommand }) => {
    await testCliCommand(
      ['bucket', 'object', 'delete', 'my-bucket/hello.txt', ...SCOPE],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Object "hello.txt" deleted from bucket "my-bucket" on branch br-main-branch-123456',
      },
    );
  });

  test('object delete a nested key', async ({ testCliCommand }) => {
    await testCliCommand(
      ['bucket', 'object', 'delete', 'my-bucket/dir/file.txt', ...SCOPE],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Object "dir/file.txt" deleted from bucket "my-bucket" on branch br-main-branch-123456',
      },
    );
  });

  test('object rm alias', async ({ testCliCommand }) => {
    await testCliCommand(
      ['bucket', 'object', 'rm', 'my-bucket/hello.txt', ...SCOPE],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Object "hello.txt" deleted from bucket "my-bucket" on branch br-main-branch-123456',
      },
    );
  });

  test('object delete surfaces the server message when missing', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      ['bucket', 'object', 'delete', 'my-bucket/missing.txt', ...SCOPE],
      {
        mockDir: 'single_org',
        code: 1,
        stderr: 'ERROR: Not Found',
      },
    );
  });

  test('object delete --recursive removes every object under the prefix', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'bucket',
        'object',
        'delete',
        'my-bucket/logs/',
        '--recursive',
        ...SCOPE,
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Deleted 3 object(s) under prefix "logs/" from bucket "my-bucket" on branch br-main-branch-123456',
      },
    );
  });

  test('object delete --recursive rejects a prefix without a trailing slash', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      ['bucket', 'object', 'delete', 'my-bucket/logs', '--recursive', ...SCOPE],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: Recursive delete requires a prefix ending in "/" (got "logs").',
      },
    );
  });

  test('object delete --recursive rejects an empty prefix', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      ['bucket', 'object', 'delete', 'my-bucket/', '--recursive', ...SCOPE],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: Recursive delete requires a non-empty prefix ending in "/".',
      },
    );
  });
});
