import { describe } from '@jest/globals';
import { testCliCommand } from '../test_utils/test_cli_command';

describe('connection_string', () => {
  testCliCommand({
    name: 'connection_string',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string branch id',
    args: [
      'connection-string',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string branch id',
    args: [
      'connection-string',
      'br-cloudy-branch-12345678',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string pooled',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string pooled branch id',
    args: [
      'connection-string',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string pooled branch id',
    args: [
      'connection-string',
      'br-cloudy-branch-12345678',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string prisma',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--prisma',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string pooled branch id',
    args: [
      'connection-string',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string pooled branch id',
    args: [
      'connection-string',
      'br-cloudy-branch-12345678',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string prisma pooled',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--prisma',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string prisma pooled extended',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--prisma',
      '--pooled',
      '--extended',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string prisma pooled branch id',
    args: [
      'connection-string',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--prisma',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string prisma pooled branch id',
    args: [
      'connection-string',
      'br-cloudy-branch-12345678',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--prisma',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string without any args should pass',
    args: ['connection-string'],
    mockDir: 'single_project',
    expected: {
      snapshot: true,
    },
  });
});
