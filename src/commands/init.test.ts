import { describe } from 'vitest';
import { test } from '../test_utils/fixtures';

describe('init', () => {
  test('init should run neon-init', async ({ testCliCommand }) => {
    await testCliCommand(['init']);
  });
});
