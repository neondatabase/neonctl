import { describe } from '@jest/globals';
import { testCliCommand } from '../test_utils/test_cli_command.js';

describe('ip-allow', () => {
  testCliCommand({
    name: 'list IP allow',
    args: ['ip-allow', 'list', '--projectId', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'Add IP allow - Error',
    args: ['ip-allow', 'add', '--projectId', 'test'],
    expected: {
      stderr: `ERROR: Enter individual IP addresses, define ranges with a dash, or use CIDR notation for more flexibility.
       Example: neonctl ip-allow add 192.168.1.1, 192.168.1.20-192.168.1.50, 192.168.1.0/24 --projectId <projectId>
`,
    },
  });

  testCliCommand({
    name: 'Add IP allow',
    args: [
      'ip-allow',
      'add',
      '127.0.0.1',
      '192.168.10.1-192.168.10.15',
      '--primary-only',
      '--projectId',
      'test',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'Remove IP allow - Error',
    args: ['ip-allow', 'remove', '--projectId', 'test'],
    expected: {
      stderr: `ERROR: Remove individual IP addresses and ranges. Example: neonctl ip-allow remove 192.168.1.1 --projectId <projectId>
`,
    },
  });

  testCliCommand({
    name: 'Remove IP allow',
    args: ['ip-allow', 'remove', '192.168.1.1', '--projectId', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'Reset IP allow',
    args: ['ip-allow', 'reset', '--projectId', 'test'],
    expected: {
      snapshot: true,
      stdout: `id: test
name: test_project
IP_addresses: ""
primary_branch_only: false
`,
      stderr: `INFO: The IP allow list has been reset. All databases on project "test_project" are now exposed to the internet
`,
    },
  });

  testCliCommand({
    name: 'Reset IP allow to new list',
    args: ['ip-allow', 'reset', '192.168.2.2', '--projectId', 'test'],
    expected: {
      snapshot: true,
    },
  });
});
