import { describe } from 'vitest';

import { testCliCommand } from '../test_utils/test_cli_command.js';

describe('databases', () => {
  testCliCommand({
    name: 'list',
    args: [
      'databases',
      'list',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create',
    args: [
      'databases',
      'create',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
      '--name',
      'test_db',
      '--owner-name',
      'test_owner',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'delete',
    args: [
      'databases',
      'delete',
      'test_db',
      '--project-id',
      'test',
      '--branch',
      'test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });
});
