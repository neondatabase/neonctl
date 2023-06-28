import { describe } from '@jest/globals';

import { testCliCommand } from '../test_utils.js';

describe('branches', () => {
  testCliCommand({
    name: 'list',
    args: ['branches', 'list', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create with endpoint',
    args: [
      'branches',
      'create',
      '--project.id',
      'test',
      '--branch.name',
      'test_branch',
      '--endpoint.type',
      'read_only',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create without endpoint',
    args: [
      'branches',
      'create',
      '--project.id',
      'test',
      '--branch.name',
      'test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'delete',
    args: ['branches', 'delete', 'test_branch_id', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update',
    args: [
      'branches',
      'update',
      'test_branch_id',
      '--project.id',
      'test',
      '--branch.name',
      'new_test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'get',
    args: ['branches', 'get', 'test_branch_id', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });
});
