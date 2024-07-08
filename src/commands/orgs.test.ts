import { describe } from 'vitest';
import { testCliCommand } from '../test_utils/test_cli_command.js';

describe('orgs', () => {
  testCliCommand({
    name: 'list',
    args: ['orgs', 'list'],
    expected: {
      snapshot: true,
    },
  });
});
