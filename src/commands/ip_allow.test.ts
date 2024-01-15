import { describe } from '@jest/globals';
import { testCliCommand } from '../test_utils/test_cli_command.js';

describe.only('ip-allow', () => {
  testCliCommand({
    name: 'list IP allow',
    args: ['ip-allow', 'list', 'test'],
    expected: {
      snapshot: true,
    },
  });
});
