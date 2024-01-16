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
    name: 'Add IP allow - Error',
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
});
