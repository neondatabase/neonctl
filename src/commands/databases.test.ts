import { describe } from '@jest/globals';

import { testCliCommand } from '../test_utils.js';

describe('databases', () => {
  testCliCommand({
    name: 'list',
    args: [
      'databases',
      'list',
      '--project.id',
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
      '--project.id',
      'test',
      '--branch',
      'test_branch',
      '--database.name',
      'test_db',
      '--database.owner_name',
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
      '--project.id',
      'test',
      '--branch',
      'test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });
});
