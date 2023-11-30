import { describe, expect } from 'vitest';

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
