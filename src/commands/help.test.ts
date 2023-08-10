import { describe, expect } from '@jest/globals';
import chalk from 'chalk';

import { testCliCommand } from '../test_utils/test_cli_command.js';

describe('help', () => {
  testCliCommand({
    name: 'without args',
    args: [],
    expected: {
      stderr: expect.stringContaining(
        `neonctl <command> ${chalk.green('[options]')}`
      ),
    },
  });
});
