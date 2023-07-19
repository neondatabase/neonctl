import { describe } from '@jest/globals';

import { testCliCommand } from '../test_utils/test_cli_command.js';

describe('operations', () => {
  testCliCommand({
    name: 'list',
    args: ['operations', 'list', '--project-id', 'test'],
    expected: {
      snapshot: true,
    },
  });
});
