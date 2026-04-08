import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('neon-auth', () => {
  test('enable', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'enable',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
      ],
      {
        stderr:
          'INFO: \nSet these environment variables in your application:\nINFO:   NEON_AUTH_BASE_URL=https://auth.test.neon.tech',
      },
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

  test('disable', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'neon-auth',
        'disable',
        '--project-id',
        'test',
        '--branch',
        'test_branch',
      ],
      {
        stderr: 'INFO: Neon Auth has been disabled',
      },
    );
  });
});
