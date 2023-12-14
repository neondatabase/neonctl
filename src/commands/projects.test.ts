import { afterAll, describe, expect, test } from '@jest/globals';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCliCommand } from '../test_utils/test_cli_command.js';

const CONTEXT_FILE = join(tmpdir(), `neon_project_create_ctx_${Date.now()}`);

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
    args: [
      'projects',
      'create',
      '--name',
      'test_project',
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
    name: 'create project with setting the context',
    args: [
      'projects',
      'create',
      '--name',
      'test_project',
      '--context-file',
      CONTEXT_FILE,
      '--set-context',
    ],
    expected: {
      snapshot: true,
    },
  });

  afterAll(() => {
    rmSync(CONTEXT_FILE);
  });

  test('context file should exist and contain the project id', () => {
    expect(readFileSync(CONTEXT_FILE, 'utf-8')).toContain('new-project-123456');
  });

  testCliCommand({
    name: 'delete',
    args: ['projects', 'delete', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update name',
    args: ['projects', 'update', 'test', '--name', 'test_project_new_name'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update ip allow',
    args: [
      'projects',
      'update',
      'test',
      '--ip-allow',
      '127.0.0.1',
      '192.168.1.2/22',
      '--primary-only',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update ip allow primary only flag',
    args: ['projects', 'update', 'test', '--primary-only', 'false'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update ip allow remove',
    args: ['projects', 'update', 'test', '--ip-allow'],
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
