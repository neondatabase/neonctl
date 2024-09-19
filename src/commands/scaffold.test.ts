import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('scaffold', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand(['scaffold', 'list']);
  });

  test('start validate template is set', async ({ testCliCommand }) => {
    await testCliCommand(['scaffold', 'start'], {
      code: 1,
    });
  });

  test('start with project id', async ({ testCliCommand }) => {
    await testCliCommand([
      'scaffold',
      'start',
      'test-template',
      '--project-id',
      'test',
    ]);
  });

  test('start without project id', async ({ testCliCommand }) => {
    await testCliCommand(['scaffold', 'start', 'test-template']);
  });
});
