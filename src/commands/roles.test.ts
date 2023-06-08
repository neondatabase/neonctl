import { describe } from '@jest/globals';

import { testCliCommand } from '../test_utils.js';

describe('roles', () => {
  testCliCommand({
    name: 'list',
    args: [
      'roles',
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
      'roles',
      'create',
      '--project.id',
      'test',
      '--branch.id',
      'test_branch_id',
      '--role.name',
      'test_role',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'delete',
    args: [
      'roles',
      'delete',
      '--project.id',
      'test',
      '--branch.id',
      'test_branch_id',
      '--role.name',
      'test_role',
    ],
    expected: {
      snapshot: true,
    },
  });
});
