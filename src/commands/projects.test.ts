import { describe } from '@jest/globals';
import { testCliCommand } from '../test_utils.js';

describe('projects', () => {
  testCliCommand({
    name: 'list',
    args: ['projects', 'list'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create',
    args: ['projects', 'create', '--project.name', 'test_project'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'delete',
    args: ['projects', 'delete', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update',
    args: [
      'projects',
      'update',
      '--project.id',
      'test',
      '--project.name',
      'test_project',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'get',
    args: ['projects', 'get', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });
});
