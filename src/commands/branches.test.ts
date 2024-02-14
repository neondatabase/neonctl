import { describe } from '@jest/globals';

import { testCliCommand } from '../test_utils/test_cli_command.js';

describe('branches', () => {
  /* list */

  testCliCommand({
    name: 'list',
    args: ['branches', 'list', '--project-id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  /* create */

  testCliCommand({
    name: 'create by default with r/w endpoint',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create branch and connect with psql',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
      '--psql',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create branch and connect with psql and psql args',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
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
    name: 'create with readonly endpoint',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
      '--type',
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
      '--project-id',
      'test',
      '--name',
      'test_branch',
      '--no-compute',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create with parent by name',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_parent_name',
      '--parent',
      'main',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create with parent by lsn',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_parent_lsn',
      '--parent',
      '0/123ABC',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create with parent by timestamp',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_parent_timestamp',
      '--parent',
      '2021-01-01T00:00:00.000Z',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create with suspend timeout',
    args: [
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_suspend_timeout',
      '--suspend-timeout',
      '60',
    ],
    expected: {
      snapshot: true,
    },
  });

  /* delete */

  testCliCommand({
    name: 'delete by id',
    args: [
      'branches',
      'delete',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
    ],
    expected: {
      snapshot: true,
    },
  });

  /* rename */

  testCliCommand({
    name: 'rename',
    args: [
      'branches',
      'rename',
      'test_branch',
      'new_test_branch',
      '--project-id',
      'test',
    ],
    expected: {
      snapshot: true,
    },
  });

  /* set primary */

  testCliCommand({
    name: 'set primary by id',
    args: [
      'branches',
      'set-primary',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
    ],
    expected: {
      snapshot: true,
    },
  });

  /* get */

  testCliCommand({
    name: 'get by id',
    args: ['branches', 'get', 'br-sunny-branch-123456', '--project-id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'get by id',
    args: [
      'branches',
      'get',
      'br-cloudy-branch-12345678',
      '--project-id',
      'test',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'get by name',
    args: ['branches', 'get', 'test_branch', '--project-id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'get by name with numeric name',
    args: ['branches', 'get', '123', '--project-id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  /* add compute */

  testCliCommand({
    name: 'add compute',
    args: ['branches', 'add-compute', 'test_branch', '--project-id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  /* reset */

  testCliCommand({
    name: 'reset branch to parent',
    args: [
      'branches',
      'reset',
      'test_branch',
      '--project-id',
      'test',
      '--parent',
    ],
    expected: {
      snapshot: true,
    },
  });

  /* restore */

  testCliCommand({
    name: 'restore branch to lsn',
    args: [
      'branches',
      'restore',
      'br-self-tolsn-123456',
      '^self@0/123ABC',
      '--project-id',
      'test',
      '--preserve-under-name',
      'backup',
    ],
    mockDir: 'restore',
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'restore to parent branch timestamp by name',
    args: [
      'branches',
      'restore',
      'parent-tots',
      '^parent@2021-01-01T00:00:00.000Z',
      '--project-id',
      'test',
    ],
    mockDir: 'restore',
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'restore to another branch head',
    args: [
      'branches',
      'restore',
      'br-another-branch-123456',
      'br-any-branch-123456',
      '--project-id',
      'test',
    ],
    mockDir: 'restore',
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'restore with unexisted branch outputs error',
    args: [
      'branches',
      'restore',
      'unexisting-branch',
      '^parent',
      '--project-id',
      'test',
    ],
    mockDir: 'restore',
    expected: {
      code: 1,
      stderr: `ERROR: Branch unexisting-branch not found.
               Available branches: self-tolsn-123456, any-branch, parent-tots, another-branch`,
    },
  });
});
