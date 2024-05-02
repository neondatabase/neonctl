import { describe, expect } from '@jest/globals';
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
    name: 'connection_string branch id 8 digits',
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
    name: 'connection_string without any args should pass',
    args: ['connection-string'],
    mockDir: 'single_project',
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string with psql',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--psql',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string with psql and psql args',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--psql',
      '--',
      '-c',
      'SELECT 1',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string without ssl',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--ssl',
      'omit',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string with ssl verify full',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'test_db',
      '--role-name',
      'test_role',
      '--ssl',
      'verify-full',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'connection_string with lsn',
    args: [
      'connection-string',
      'test_branch@0/123456',
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
    name: 'connection_string with timestamp',
    args: [
      'connection-string',
      'test_branch@2021-01-01T00:00:00Z',
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
    name: 'connection_string fails for non-existing database',
    args: [
      'connection-string',
      'test_branch',
      '--project-id',
      'test',
      '--database-name',
      'non_existing_db',
      '--role-name',
      'test_role',
    ],
    expected: {
      code: 1,
      stderr: expect.stringMatching(/Database not found/),
    },
  });
});
