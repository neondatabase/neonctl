import { describe, expect } from '@jest/globals';

import { testCliCommand } from '../test_utils.js';

describe('help', () => {
  testCliCommand({
    name: 'without args',
    args: [],
    expected: {
      stderr: expect.stringContaining('usage: neonctl <command> [options]'),
    },
  });
});
