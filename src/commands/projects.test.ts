import { describe, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from '../test_utils/fixtures';

describe('projects', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'list']);
  });

  test('list with org id', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'list', '--org-id', 'org-2']);
  });

  test('create', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'create', '--name', 'test_project']);
  });

  test('create with audit log level', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project',
      '--audit-log-level',
      'hipaa',
    ]);
  });

  test('create with invalid audit log level', async ({ testCliCommand }) => {
    await testCliCommand(
      [
        'projects',
        'create',
        '--name',
        'test_project',
        '--audit-log-level',
        'invalid',
      ],
      { code: 1 },
    );
  });

  test('create with org id', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project',
      '--org-id',
      'org-2',
    ]);
  });

  test('create with database and role', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project',
      '--database',
      'test_db',
      '--role',
      'test_role',
    ]);
  });

  test('create and connect with psql', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project',
      '--psql',
    ]);
  });

  test('create and connect with psql and psql args', async ({
    testCliCommand,
  }) => {
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project',
      '--psql',
      '--',
      '-c',
      'SELECT 1',
    ]);
  });

  test('create project with setting the context', async ({
    testCliCommand,
  }) => {
    const CONTEXT_FILE = join(
      tmpdir(),
      `neon_project_create_ctx_${Date.now()}`,
    );
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project',
      '--context-file',
      CONTEXT_FILE,
      '--set-context',
    ]);
    expect(readFileSync(CONTEXT_FILE, 'utf-8')).toContain('new-project-123456');
    rmSync(CONTEXT_FILE);
  });

  test('create project with default fixed size CU', async ({
    testCliCommand,
  }) => {
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project_with_fixed_cu',
      '--cu',
      '2',
    ]);
  });

  test('create project with default autoscaled CU', async ({
    testCliCommand,
  }) => {
    await testCliCommand([
      'projects',
      'create',
      '--name',
      'test_project_with_autoscaling',
      '--cu',
      '0.5-2',
    ]);
  });

  test('delete', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'delete', 'test']);
  });

  test('update name', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'update',
      'test',
      '--name',
      'test_project_new_name',
    ]);
  });

  test('update audit log level', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'update',
      'test',
      '--audit-log-level',
      'hipaa',
    ]);
  });

  test('update with invalid audit log level', async ({ testCliCommand }) => {
    await testCliCommand(
      ['projects', 'update', 'test', '--audit-log-level', 'invalid'],
      { code: 1 },
    );
  });

  test('update project with default fixed size CU', async ({
    testCliCommand,
  }) => {
    await testCliCommand([
      'projects',
      'update',
      'test_project_with_fixed_cu',
      '--cu',
      '2',
    ]);
  });

  test('update project with default autoscaled CU', async ({
    testCliCommand,
  }) => {
    await testCliCommand([
      'projects',
      'update',
      'test_project_with_autoscaling',
      '--cu',
      '0.5-2',
    ]);
  });

  test('get', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'get', 'test']);
  });
});
