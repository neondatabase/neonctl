import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'vitest';

import { test as originalTest } from '../test_utils/fixtures';

// All tests in this file share a single temporary directory whose path is
// normalized in snapshots to `<TMP>` so absolute paths in command output stay
// stable across runs and machines.
const TEST_TMP = mkdtempSync(join(tmpdir(), 'neonctl-checkout-'));

const test = originalTest.extend<{
  readFile: (name: string) => string;
  removeFile: (name: string) => void;
  // Each test gets its OWN sub-directory under TEST_TMP so the `.gitignore`
  // scaffolded next to the `.neon` written by one test doesn't affect another.
  tmpContext: (label: string, seed?: Record<string, unknown>) => string;
}>({
  // eslint-disable-next-line no-empty-pattern
  readFile: async ({}, use) => {
    await use((name) => readFileSync(name, 'utf-8'));
  },
  // eslint-disable-next-line no-empty-pattern
  removeFile: async ({}, use) => {
    await use((name) => {
      try {
        rmSync(name);
      } catch {
        // ignore
      }
    });
  },
  // eslint-disable-next-line no-empty-pattern
  tmpContext: async ({}, use) => {
    await use((label, seed) => {
      const dir = join(TEST_TMP, label);
      mkdirSync(dir, { recursive: true });
      const ctx = join(dir, '.neon');
      if (seed) {
        writeFileSync(ctx, JSON.stringify(seed, null, 2));
      }
      return ctx;
    });
  },
});

const parseContext = (raw: string) =>
  JSON.parse(raw) as Record<string, unknown>;

describe('checkout', () => {
  test('resolves a branch by name and writes branchId to a fresh .neon', async ({
    testCliCommand,
    readFile,
    tmpContext,
  }) => {
    const ctx = tmpContext('by_name_fresh');
    await testCliCommand([
      'checkout',
      'main',
      '--project-id',
      'test',
      '--context-file',
      ctx,
    ]);
    expect(parseContext(readFile(ctx))).toEqual({
      projectId: 'test',
      branchId: 'br-main-branch-123456',
    });
  });

  test('resolves a branch by id and writes branchId to a fresh .neon', async ({
    testCliCommand,
    readFile,
    tmpContext,
  }) => {
    const ctx = tmpContext('by_id_fresh');
    await testCliCommand([
      'checkout',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
      '--context-file',
      ctx,
    ]);
    expect(parseContext(readFile(ctx))).toEqual({
      projectId: 'test',
      branchId: 'br-sunny-branch-123456',
    });
  });

  test('preserves orgId/projectId already present in the .neon file', async ({
    testCliCommand,
    readFile,
    tmpContext,
  }) => {
    const ctx = tmpContext('preserve_org', {
      orgId: 'org-keep',
      projectId: 'test',
    });
    await testCliCommand(['checkout', 'test_branch', '--context-file', ctx]);
    expect(parseContext(readFile(ctx))).toEqual({
      orgId: 'org-keep',
      projectId: 'test',
      branchId: 'br-sunny-branch-123456',
    });
  });

  test('resolves projectId from the .neon file when no flag is passed', async ({
    testCliCommand,
    readFile,
    tmpContext,
  }) => {
    const ctx = tmpContext('project_from_file', { projectId: 'test' });
    await testCliCommand(['checkout', 'main', '--context-file', ctx]);
    expect(parseContext(readFile(ctx))).toEqual({
      projectId: 'test',
      branchId: 'br-main-branch-123456',
    });
  });

  test('auto-detects the project when the API key maps to a single project', async ({
    testCliCommand,
    readFile,
    tmpContext,
  }) => {
    // No --project-id and a fresh .neon: checkout should fall
    // back to single-project auto-detection (same behaviour as branches / cs).
    const ctx = tmpContext('autodetect_single');
    await testCliCommand(['checkout', 'main', '--context-file', ctx], {
      mockDir: 'single_project',
    });
    expect(parseContext(readFile(ctx))).toEqual({
      projectId: 'test-project-123456',
      branchId: 'br-main-branch-123456',
    });
  });

  test('fails with a telling error when no project can be resolved (non-interactive)', async ({
    testCliCommand,
    removeFile,
    tmpContext,
  }) => {
    // Fresh .neon, no --project-id, and the mock account has no projects so
    // single-project auto-detection can't pick one. The forked CLI has no TTY,
    // so we expect the telling error instead of a prompt.
    const ctx = tmpContext('no_project');
    await testCliCommand(['checkout', 'main', '--context-file', ctx], {
      mockDir: 'checkout_no_project',
      code: 1,
      stderr:
        'ERROR: Could not determine which Neon project to check out a branch from. Provide one via the --project-id flag or a .neon file (created by `neonctl link` / `neonctl set-context`).',
    });
    removeFile(ctx);
  });

  test('fails with a helpful error when the branch is not found', async ({
    testCliCommand,
    removeFile,
    tmpContext,
  }) => {
    const ctx = tmpContext('not_found');
    await testCliCommand(
      [
        'checkout',
        'does-not-exist',
        '--project-id',
        'test',
        '--context-file',
        ctx,
      ],
      {
        code: 1,
        stderr:
          'ERROR: Branch does-not-exist not found. Available branches: main, test_branch, 123, test_branch_with_fixed_cu, test_branch_with_autoscaling, protected_branch',
      },
    );
    removeFile(ctx);
  });
});
