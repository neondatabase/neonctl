import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('neon-auth', () => {
  test('enable', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'enable',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('enable already enabled', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'enable',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
      ],
      { mockDir: 'neon-auth-already-enabled' },
    );
  });

  test('status', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'status',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('status not configured', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'status',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
      ],
      { mockDir: 'neon-auth-not-configured' },
    );
  });

  test('disable', async ({ testCliCommand }) => {
    await testCliCommand([
      'neon-auth',
      'disable',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('disable with delete data', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'disable',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
        '--delete-data',
      ],
      { mockDir: 'neon-auth-delete-data' },
    );
  });
});
