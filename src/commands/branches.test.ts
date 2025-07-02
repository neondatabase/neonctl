import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('branches', () => {
  /* list */

  test('list', async ({ testCliCommand }) => {
    await testCliCommand(['branches', 'list', '--project-id', 'test']);
  });

  /* create */

  test('create by default with r/w endpoint', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
    ]);
  });

  test('create branch and connect with psql', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
      '--psql',
    ]);
  });

  test('create branch and connect with psql and psql args', async ({
    testCliCommand,
  }) => {
    await testCliCommand([
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
    ]);
  });

  test('create with readonly endpoint', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
      '--type',
      'read_only',
    ]);
  });

  test('create without endpoint', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
      '--no-compute',
    ]);
  });

  test('create with parent by name', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_parent_name',
      '--parent',
      'main',
    ]);
  });

  test('create with parent by lsn', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_parent_lsn',
      '--parent',
      '0/123ABC',
    ]);
  });

  test('create with parent by timestamp', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_parent_timestamp',
      '--parent',
      '2021-01-01T00:00:00.000Z',
    ]);
  });

  test('create with suspend timeout', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_suspend_timeout',
      '--suspend-timeout',
      '60',
    ]);
  });

  test('create with fixed size CU', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_fixed_cu',
      '--cu',
      '2',
    ]);
  });

  test('create with autoscaled CU', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch_with_autoscaling',
      '--cu',
      '0.5-2',
    ]);
  });

  test('create schema-only branch', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'create',
      '--project-id',
      'test',
      '--name',
      'test_branch',
      '--schema-only',
    ]);
  });

  test('create schema-only branch fails without compute', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'branches',
        'create',
        '--project-id',
        'test',
        '--name',
        'test_branch',
        '--schema-only',
        '--no-compute',
      ],
      {
        mockDir: 'main',
        code: 1,
        stderr: 'ERROR: Schema-only branches require a compute endpoint',
      },
    );
  });

  test('create schema-only branch fails with read-only compute', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'branches',
        'create',
        '--project-id',
        'test',
        '--name',
        'test_branch',
        '--schema-only',
        '--type',
        'read_only',
      ],
      {
        mockDir: 'main',
        code: 1,
        stderr:
          'ERROR: Schema-only branches require a read-write compute endpoint',
      },
    );
  });

  /* delete */

  test('delete by id', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'delete',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
    ]);
  });

  /* rename */

  test('rename', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'rename',
      'test_branch',
      'new_test_branch',
      '--project-id',
      'test',
    ]);
  });

  /* set default */

  test('set default by id', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'set-default',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
    ]);
  });

  /* get */

  test('get by id', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'get',
      'br-sunny-branch-123456',
      '--project-id',
      'test',
    ]);
  });

  test('get by id', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'get',
      'br-cloudy-branch-12345678',
      '--project-id',
      'test',
    ]);
  });

  test('get by name', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'get',
      'test_branch',
      '--project-id',
      'test',
    ]);
  });

  test('get by name with numeric name', async ({ testCliCommand }) => {
    await testCliCommand(['branches', 'get', '123', '--project-id', 'test']);
  });

  /* add compute */

  test('add compute', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'add-compute',
      'test_branch',
      '--project-id',
      'test',
    ]);
  });

  test('add compute with fixed size CU', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'add-compute',
      'test_branch_with_fixed_cu',
      '--project-id',
      'test',
      '--cu',
      '2',
    ]);
  });

  test('add compute with autoscaled CU', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'add-compute',
      'test_branch_with_autoscaling',
      '--project-id',
      'test',
      '--cu',
      '0.5-2',
    ]);
  });

  test('add compute with a name', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'add-compute',
      'test_branch_with_autoscaling',
      '--project-id',
      'test',
      '--cu',
      '0.5-2',
      '--name',
      'My fancy new compute',
    ]);
  });

  /* reset */

  test('reset branch to parent', async ({ testCliCommand }) => {
    await testCliCommand([
      'branches',
      'reset',
      'test_branch',
      '--project-id',
      'test',
      '--parent',
    ]);
  });

  /* restore */

  test('restore branch to lsn', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'branches',
        'restore',
        'br-self-tolsn-123456',
        '^self@0/123ABC',
        '--project-id',
        'test',
        '--preserve-under-name',
        'backup',
      ],
      {
        mockDir: 'restore',
      },
    );
  });

  test('restore to parent branch timestamp by name', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'branches',
        'restore',
        'parent-tots',
        '^parent@2021-01-01T00:00:00.000Z',
        '--project-id',
        'test',
      ],
      {
        mockDir: 'restore',
      },
    );
  });

  test('restore to another branch head', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'branches',
        'restore',
        'br-another-branch-123456',
        'br-any-branch-123456',
        '--project-id',
        'test',
      ],
      {
        mockDir: 'restore',
      },
    );
  });

  test('restore with unexisted branch outputs error', async ({
    testCliCommand,
  }) => {
    await testCliCommand(
      [
        'branches',
        'restore',
        'unexisting-branch',
        '^parent',
        '--project-id',
        'test',
      ],
      {
        mockDir: 'restore',
        code: 1,
        stderr: `ERROR: Branch unexisting-branch not found.
               Available branches: self-tolsn-123456, any-branch, parent-tots, another-branch`,
      },
    );
  });
});
