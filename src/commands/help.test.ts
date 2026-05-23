import { describe, expect } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('help', () => {
  test('without args', async ({ testCliCommand }) => {
    await testCliCommand([], {
      stderr: expect.stringContaining(`neonctl <command> [options]`),
    });
  });

  test('branches create --parent describes fork semantics', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['branches', 'create', '--help'], {
      stderr: expect.stringContaining('Branch to create from'),
    });
  });

  test('branches create --help shows examples', async ({ testCliCommand }) => {
    await testCliCommand(['branches', 'create', '--help'], {
      stderr: expect.stringContaining('Fork main at its current head'),
    });
  });

  test('branches restore --help shows describe', async ({ testCliCommand }) => {
    await testCliCommand(['branches', 'restore', '--help'], {
      stderr: expect.stringContaining('Restore a branch to a point in time'),
    });
  });

  test('init --help lists claude as valid agent', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['init', '--help'], {
      stderr: expect.stringContaining('claude'),
    });
  });

  test('operations list --help shows --limit', async ({ testCliCommand }) => {
    await testCliCommand(['operations', 'list', '--help'], {
      stderr: expect.stringContaining('--limit'),
    });
  });

  test('projects create --help shows hipaa description', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['projects', 'create', '--help'], {
      stderr: expect.stringContaining('HIPAA'),
    });
  });

  test('ip-allow reset --help explains clear vs replace', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['ip-allow', 'reset', '--help'], {
      stderr: expect.stringContaining('clear the entire allowlist'),
    });
  });
});
