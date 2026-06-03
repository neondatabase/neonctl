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
});
