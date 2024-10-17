import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('scaffold', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand(['scaffold', 'list']);
  });

  test('start with project id', async ({ testCliCommand }) => {
    await testCliCommand([
      'scaffold',
      'start',
      '--template-id',
      'test-template',
      '--project-id',
      'test',
    ]);
  });
});
