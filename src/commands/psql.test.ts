import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('psql', () => {
  test('psql connects to a branch', async ({ testCliCommand }) => {
    await testCliCommand([
      'psql',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
    ]);
  });

  test('psql forwards args after --', async ({ testCliCommand }) => {
    await testCliCommand([
      'psql',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--',
      '-c',
      'SELECT 1',
    ]);
  });

  test('psql pooled', async ({ testCliCommand }) => {
    await testCliCommand([
      'psql',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--pooled',
    ]);
  });

  test('psql without any args should pass', async ({ testCliCommand }) => {
    await testCliCommand(['psql'], {
      mockDir: 'single_project',
    });
  });
});
