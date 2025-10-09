import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('init', () => {
  test('init should run neon-init', async ({ testCliCommand }) => {
    await testCliCommand(['init']);
  });

  test('init with single argument', async ({ testCliCommand }) => {
    await testCliCommand(['init', '--', '--debug']);
  });

  test('init with multiple arguments', async ({ testCliCommand }) => {
    await testCliCommand([
      'init',
      '--',
      '--template',
      'nextjs',
      '--typescript',
    ]);
  });
});
