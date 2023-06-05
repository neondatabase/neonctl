import { describe, beforeAll, afterAll } from '@jest/globals';
import { Server } from 'node:http';

import { runMockServer, testCliCommand } from '../test_utils.js';

let server: Server;

describe('branches', () => {
  beforeAll((done) => {
    server = runMockServer();
    server.on('listening', () => {
      done();
    });
  });

  afterAll(() => {
    server.close();
  });

  testCliCommand({
    name: 'list',
    args: ['branches', 'list', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create',
    args: [
      'branches',
      'create',
      '--project.id',
      'test',
      '--branch.name',
      'test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'delete',
    args: [
      'branches',
      'delete',
      '--project.id',
      'test',
      '--branch.id',
      'test_branch_id',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update',
    args: [
      'branches',
      'update',
      '--project.id',
      'test',
      '--branch.id',
      'test_branch_id',
      '--branch.name',
      'new_test_branch',
    ],
    expected: {
      snapshot: true,
    },
  });
});
