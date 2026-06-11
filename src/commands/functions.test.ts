import { describe, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../test_utils/fixtures';

const esbuildBin = join(process.cwd(), 'node_modules', '.bin', 'esbuild');

let fnDir: string;
beforeAll(() => {
  fnDir = mkdtempSync(join(tmpdir(), 'neonctl-fn-'));
  writeFileSync(join(fnDir, 'index.ts'), 'export default {};\n');
  writeFileSync(join(fnDir, 'custom.ts'), 'export default { custom: true };\n');
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
        'nowaitfunc',
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
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function nowaitfunc. ' +
          'INFO: Check status with: neonctl functions get nowaitfunc ' +
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

  test('get (table) shows the build failure reason', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'get',
        'brokenfunc',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      { mockDir: 'single_org', outputTable: true },
    );
  });

  test('get (yaml) includes the build failure reason', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'get',
        'brokenfunc',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      { mockDir: 'single_org' },
    );
  });

  test('get (table) shows plain failed status when there is no error', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'get',
        'failednoerr',
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
        'redeploy',
        '--path',
        fnDir,
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function redeploy. ' +
          'INFO: Function deployment redeploy/2 completed.',
      },
    );
  });

  test('deploy --wait on first deploy (no prior active version)', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'newfunc',
        '--path',
        fnDir,
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function newfunc. ' +
          'INFO: Function deployment newfunc/1 completed.',
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
        'failfunc',
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
        outputTable: true,
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function failfunc. ' +
          'ERROR: Function deployment failfunc/1 failed.',
      },
    );
  });

  test('deploy --wait times out when the deployment never becomes active', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'stuckstart',
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
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_FUNCTIONS_POLL_TIMEOUT_MS: '10',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function stuckstart. ' +
          'INFO: Check status with: neonctl functions get stuckstart ' +
          '--project-id test-project-123456 --branch br-main-branch-123456 ' +
          'ERROR: Timed out waiting for the deployment of stuckstart to start. ' +
          'It may still be in progress.',
      },
    );
  });

  test('deploy --wait times out while the new version is still building', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'stuckbuild',
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
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_FUNCTIONS_POLL_TIMEOUT_MS: '10',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function stuckbuild. ' +
          'INFO: Check status with: neonctl functions get stuckbuild ' +
          '--project-id test-project-123456 --branch br-main-branch-123456 ' +
          'ERROR: Timed out waiting for function deployment stuckbuild/1 to finish. ' +
          'It may still be building.',
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
        'envfunc',
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
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function envfunc. ' +
          'INFO: Check status with: neonctl functions get envfunc ' +
          '--project-id test-project-123456 --branch br-main-branch-123456',
      },
    );
  });

  test('deploy rejects malformed --env', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'myfunc',
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
          'ERROR: Invalid function slug "Bad_Slug". Use 1-20 lowercase letters and digits (no hyphens or other characters).',
      },
    );
  });

  test('deploy rejects a hyphenated slug', async ({ testCliCommand }) => {
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
        code: 1,
        stderr:
          'ERROR: Invalid function slug "my-func". Use 1-20 lowercase letters and digits (no hyphens or other characters).',
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

  test('deploy errors when the entry file is missing', async ({
    testCliCommand,
  }) => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'neonctl-empty-'));
    await testCliCommand(
      [
        'functions',
        'deploy',
        'myfunc',
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
        stderr: `ERROR: Entry file not found: ${join(
          emptyDir,
          'index.ts',
        )}. Pass --entry to point at your function's entry file (defaults to index.ts).`,
      },
    );
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test('deploy requires at least one option', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'myfunc',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        stderr:
          'ERROR: Provide at least one option to deploy, e.g. --path, --entry, ' +
          'or --env. See: neonctl functions deploy --help.',
      },
    );
  });

  test('deploy --entry selects a custom entry file', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'entryfunc',
        '--path',
        fnDir,
        '--entry',
        'custom.ts',
        '--no-wait',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function entryfunc. ' +
          'INFO: Check status with: neonctl functions get entryfunc ' +
          '--project-id test-project-123456 --branch br-main-branch-123456',
      },
    );
  });

  test('deploy --wait retries through a transient poll error', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'flaky',
        '--path',
        fnDir,
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function flaky. ' +
          'INFO: Function deployment flaky/1 completed.',
      },
    );
  });

  test('deploy --wait surfaces a non-transient poll error', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'functions',
        'deploy',
        'denied',
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
        env: {
          NEON_FUNCTIONS_POLL_INTERVAL_MS: '1',
          NEON_ESBUILD_PATH: esbuildBin,
        },
        stderr:
          'INFO: Function deployment triggered for function denied. ' +
          'ERROR: Forbidden',
      },
    );
  });

  // esbuild's diagnostic text is environment-specific, so assert the exit code
  // and the empty stdout snapshot only - not the stderr string.
  test('deploy fails cleanly when bundling fails', async ({
    testCliCommand,
  }) => {
    const badDir = mkdtempSync(join(tmpdir(), 'neonctl-bad-'));
    writeFileSync(join(badDir, 'index.ts'), 'export default {\n');
    await testCliCommand(
      [
        'functions',
        'deploy',
        'myfunc',
        '--path',
        badDir,
        '--no-wait',
        '--project-id',
        'test-project-123456',
        '--branch',
        'main',
      ],
      {
        mockDir: 'single_org',
        code: 1,
        env: { NEON_ESBUILD_PATH: esbuildBin },
      },
    );
    rmSync(badDir, { recursive: true, force: true });
  });
});
