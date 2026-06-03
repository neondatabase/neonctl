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
});
