import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('databases', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand([
      'databases',
      'list',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });

  test('create', async ({ testCliCommand }) => {
    await testCliCommand([
      'databases',
      'create',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--name',
      'test_db',
      '--owner-name',
      'test_owner',
    ]);
  });

  test('delete', async ({ testCliCommand }) => {
    await testCliCommand([
      'databases',
      'delete',
      'test_db',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ]);
  });
});
