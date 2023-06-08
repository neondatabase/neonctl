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
      '--branch.id',
      'test_branch_id',
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
      '--branch.id',
      'test_branch_id',
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
      '--project.id',
      'test',
      '--branch.id',
      'test_branch_id',
      '--database.name',
      'test_db',
    ],
    expected: {
      snapshot: true,
    },
  });
});
