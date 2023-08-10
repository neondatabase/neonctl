import { describe } from '@jest/globals';
import { testCliCommand } from '../test_utils/test_cli_command.js';

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
    args: ['projects', 'create', '--name', 'test_project'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create and connect with psql',
    args: ['projects', 'create', '--name', 'test_project', '--psql'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create and connect with psql and psql args',
    args: ['projects', 'create', '--name', 'test_project', '--psql', '--', '-c', 'SELECT 1'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'delete',
    args: ['projects', 'delete', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update',
    args: ['projects', 'update', 'test', '--name', 'test_project'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'get',
    args: ['projects', 'get', 'test'],
    expected: {
      snapshot: true,
    },
  });
});
