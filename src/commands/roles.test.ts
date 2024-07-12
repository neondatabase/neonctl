import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('roles', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand([
      'roles',
      'list',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('create', async ({ testCliCommand }) => {
    await testCliCommand([
      'roles',
      'create',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--name',
      'test_role',
    ]);
  });

  test('delete', async ({ testCliCommand }) => {
    await testCliCommand([
      'roles',
      'delete',
      'test_role',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });
});
