import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect } from 'vitest';
import { test } from '../test_utils/fixtures';

// A temp dir for the `object get` download target so the test never writes into
// the repo. Removed after the suite runs.
const TEST_TMP = mkdtempSync(join(tmpdir(), 'neonctl-bucket-'));
afterAll(() => {
  rmSync(TEST_TMP, { recursive: true, force: true });
});

// The presigned-PUT capture sink (mocks/single_org/_upload_sink/PUT.js) writes
// the received body + headers to the file named by this env var, which it reads
// in the (parent) mock-server process. Cleared after each test.
afterEach(() => {
  delete process.env.NEONCTL_TEST_UPLOAD_SINK;
  delete process.env.NEONCTL_TEST_PRESIGN_SINK;
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

  test('object put streams the file to the presigned URL with the returned headers', async ({
    testCliCommand,
  }) => {
    const src = join(TEST_TMP, 'to-upload.txt');
    writeFileSync(src, 'upload me\n');
    const sink = join(TEST_TMP, 'put-sink.json');
    process.env.NEONCTL_TEST_UPLOAD_SINK = sink;
    const presignSink = join(TEST_TMP, 'presign-sink.json');
    process.env.NEONCTL_TEST_PRESIGN_SINK = presignSink;

    await testCliCommand(
      [
        'bucket',
        'object',
        'put',
        'my-bucket/upload.txt',
        '--file',
        src,
        '--content-type',
        'text/plain',
        ...SCOPE,
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: File "' +
          src +
          '" uploaded to "upload.txt" in bucket "my-bucket" on branch br-main-branch-123456',
      },
    );

    // The presign request hit the unified `/presign` endpoint with the
    // upload discriminator in the body.
    const presigned = JSON.parse(readFileSync(presignSink, 'utf8'));
    expect(presigned.operation).toEqual('upload');

    const captured = JSON.parse(readFileSync(sink, 'utf8'));
    // The exact file bytes reached the presigned URL...
    expect(captured.body).toEqual('upload me\n');
    // ...the presigned headers were forwarded verbatim...
    expect(captured.signed).toEqual('yes');
    expect(captured.contentType).toEqual('text/plain');
    // ...and the size was sent as Content-Length (streamed, not chunked).
    expect(captured.contentLength).toEqual('10');
  });

  test('object put rejects a file over the 100 MB limit before any HTTP', async ({
    testCliCommand,
  }) => {
    // 100 MB + 1 byte. Sparse-allocated via truncate so the test stays fast and
    // cheap on disk. No presign/PUT mock is hit because the cap is enforced
    // client-side before any network round-trip.
    const tooBig = join(TEST_TMP, 'too-big.bin');
    const size = 100 * 1024 * 1024 + 1;
    const fd = openSync(tooBig, 'w');
    ftruncateSync(fd, size);
    closeSync(fd);

    await testCliCommand(
      [
        'bucket',
        'object',
        'put',
        'my-bucket/upload.txt',
        '--file',
        tooBig,
        ...SCOPE,
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: File "' +
          tooBig +
          '" is ' +
          String(size) +
          ' bytes, which exceeds the 104857600-byte (100 MB) single-upload limit. Larger objects are not supported yet.',
      },
    );
  });

  test('object put without a key is rejected client-side', async ({
    testCliCommand,
  }) => {
    const src = join(TEST_TMP, 'no-key.txt');
    writeFileSync(src, 'x');
    await testCliCommand(
      ['bucket', 'object', 'put', 'my-bucket', '--file', src, ...SCOPE],
      {
        mockDir: 'single_org',
        code: 1,
        stderr: 'ERROR: Object target must be in the form <bucket>/<key>.',
      },
    );
  });

  test('object put requires --file', async ({ testCliCommand }) => {
    await testCliCommand(
      ['bucket', 'object', 'put', 'my-bucket/upload.txt', ...SCOPE],
      {
        mockDir: 'single_org',
        code: 1,
      },
    );
  });

  test('object put surfaces the server message when presign fails', async ({
    testCliCommand,
  }) => {
    const src = join(TEST_TMP, 'orphan.txt');
    writeFileSync(src, 'x');
    await testCliCommand(
      [
        'bucket',
        'object',
        'put',
        'my-bucket/missing-bucket-key.txt',
        '--file',
        src,
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
