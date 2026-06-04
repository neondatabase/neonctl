import { describe, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../test_utils/fixtures';

let fnDir: string;
beforeAll(() => {
  fnDir = mkdtempSync(join(tmpdir(), 'neonctl-fn-'));
  writeFileSync(join(fnDir, 'index.ts'), 'export default {};\n');
});
afterAll(() => {
  rmSync(fnDir, { recursive: true, force: true });
});

describe('functions', () => {
  test('deploy --no-wait', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'my-func',
        '--path',
        fnDir,
        '--no-wait',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Deployment 1 created for my-func (status: pending) ' +
          'INFO: Check status with: neonctl functions get my-func ' +
          '--project-id test-project-123456 --branch br-main-branch-123456',
      },
    );
  });

  test('list (yaml)', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'list',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('list (table)', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'list',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      { mockDir: 'single_org', outputTable: true },
    );
  });

  test('list with implicit project and branch', async ({ testCliCommand }) => {
    await testCliCommand(['functions', 'list'], { mockDir: 'single_org' });
  });

  test('get (yaml)', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'get',
        'my-func',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('get (table)', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'get',
        'my-func',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      { mockDir: 'single_org', outputTable: true },
    );
  });

  test('get with no active deployment', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'get',
        'other-func',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      { mockDir: 'single_org', outputTable: true },
    );
  });

  test('deploy --wait until completed', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'my-func',
        '--path',
        fnDir,
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        env: { NEON_FUNCTIONS_POLL_INTERVAL_MS: '1' },
        stderr:
          'INFO: Deployment 1 created for my-func (status: pending) ' +
          'INFO: Deployment 1 completed.',
      },
    );
  });

  test('deploy --wait exits 1 when the deployment fails', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'failing-func',
        '--path',
        fnDir,
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        env: { NEON_FUNCTIONS_POLL_INTERVAL_MS: '1' },
        stderr:
          'INFO: Deployment 1 created for failing-func (status: pending) ' +
          'ERROR: Deployment 1 failed.',
      },
    );
  });

  test('deploy rejects out-of-range --concurrency', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'my-func',
        '--path',
        fnDir,
        '--no-wait',
        '--concurrency',
        '5000',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: Invalid --concurrency 5000. It must be an integer between 1 and 1000.',
      },
    );
  });

  test('deploy --env encodes environment as JSON', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'my-func',
        '--path',
        fnDir,
        '--no-wait',
        '--env',
        'KEY=VALUE',
        '--env',
        'A=B',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Deployment 1 created for my-func (status: pending) ' +
          'INFO: Check status with: neonctl functions get my-func ' +
          '--project-id test-project-123456 --branch br-main-branch-123456',
      },
    );
  });

  test('deploy rejects malformed --env', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'my-func',
        '--path',
        fnDir,
        '--no-wait',
        '--env',
        'NOEQUALS',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr: 'ERROR: Invalid --env value "NOEQUALS". Expected KEY=VALUE.',
      },
    );
  });

  test('deploy rejects an invalid slug', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'Bad_Slug',
        '--path',
        fnDir,
        '--no-wait',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: Invalid function slug "Bad_Slug". Use 1-40 lowercase letters, digits, and hyphens; it must start and end with a letter or digit.',
      },
    );
  });

  test('delete', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'delete',
        'my-func',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        stderr:
          'INFO: Function my-func deleted from branch br-main-branch-123456',
      },
    );
  });

  test('delete reports a friendly error when the function is missing', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'delete',
        'ghost-func',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: Function "ghost-func" not found on branch br-main-branch-123456.',
      },
    );
  });

  test('deploy errors when index.ts is missing', async ({ testCliCommand }) => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'neonctl-empty-'));
    await testCliCommand(
      [
        'functions',
        'deploy',
        'my-func',
        '--path',
        emptyDir,
        '--no-wait',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr: `ERROR: No index.ts found in ${emptyDir}. A function must have an index.ts at the root of --path.`,
      },
    );
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
