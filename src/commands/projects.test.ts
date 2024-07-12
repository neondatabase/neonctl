import { describe, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from '../test_utils/fixtures';

describe('projects', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'list']);
  });

  test('create', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'create', '--name', 'test_project']);
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

  test('update ip allow', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'update',
      'test',
      '--ip-allow',
      '127.0.0.1',
      '192.168.1.2/22',
      '--ip-primary-only',
    ]);
  });

  test('update ip allow primary only flag', async ({ testCliCommand }) => {
    await testCliCommand([
      'projects',
      'update',
      'test',
      '--ip-primary-only',
      'false',
    ]);
  });

  test('update ip allow remove', async ({ testCliCommand }) => {
    await testCliCommand(['projects', 'update', 'test', '--ip-allow']);
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
