import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('ip-allow', () => {
  test('list IP allow', async ({ testCliCommand }) => {
    await testCliCommand(['ip-allow', 'list', '--project-id', 'test']);
  });

  test('list IP Allow with single-project', async ({ testCliCommand }) => {
    await testCliCommand(['ip-allow', 'list'], {
      mockDir: 'single_project',
    });
  });

  test('Add IP allow - Error', async ({ testCliCommand }) => {
    await testCliCommand(['ip-allow', 'add', '--projectId', 'test'], {
      code: 1,
      stderr: `ERROR: Enter individual IP addresses, define ranges with a dash, or use CIDR notation for more flexibility.
         Example: neonctl ip-allow add 192.168.1.1, 192.168.1.20-192.168.1.50, 192.168.1.0/24 --project-id <id>`,
    });
  });

  test('Add IP allow - Protected', async ({ testCliCommand }) => {
    await testCliCommand([
      'ip-allow',
      'add',
      '127.0.0.1',
      '192.168.10.1-192.168.10.15',
      '--protected-only',
      '--project-id',
      'test',
    ]);
  });

  test('Remove IP allow - Error', async ({ testCliCommand }) => {
    await testCliCommand(['ip-allow', 'remove', '--project-id', 'test'], {
      code: 1,
      stderr: `ERROR: Remove individual IP addresses and ranges. Example: neonctl ip-allow remove 192.168.1.1 --project-id <id>`,
    });
  });

  test('Remove IP allow', async ({ testCliCommand }) => {
    await testCliCommand([
      'ip-allow',
      'remove',
      '192.168.1.1',
      '--project-id',
      'test',
    ]);
  });

  test('Reset IP allow', async ({ testCliCommand }) => {
    await testCliCommand(['ip-allow', 'reset', '--project-id', 'test'], {
      stderr: `INFO: The IP allowlist has been reset. All databases on project "test_project" are now exposed to the internet`,
    });
  });

  test('Reset IP allow to new list', async ({ testCliCommand }) => {
    await testCliCommand([
      'ip-allow',
      'reset',
      '192.168.2.2',
      '--project-id',
      'test',
    ]);
  });
});
