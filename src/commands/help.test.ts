import { describe, expect } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('help', () => {
  test('without args', async ({ testCliCommand }) => {
    await testCliCommand([], {
      stderr: expect.stringContaining(`neonctl <command> [options]`),
    });
  });
});
