import { describe, expect } from '@jest/globals';

import { testCliCommand } from '../test_utils/test_cli_command.js';

describe('help', () => {
  testCliCommand({
    name: 'without args',
    args: [],
    expected: {
      stderr: expect.stringContaining(`neonctl <command> [options]`),
    },
  });
});
