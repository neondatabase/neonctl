import { describe, expect } from '@jest/globals';

import { testCliCommand } from '../test_utils.js';

describe('endpoints', () => {
  testCliCommand({
    name: 'list',
    args: ['endpoints', 'list', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'list with branch filter',
    args: [
      'endpoints',
      'list',
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
    name: 'create',
    args: [
      'endpoints',
      'create',
      '--project.id',
      'test',
      '--endpoint.branch_id',
      'test_branch_id',
      '--endpoint.type',
      'read_only',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'create with retry',
    args: [
      'endpoints',
      'create',
      '--project.id',
      'test',
      '--endpoint.branch_id',
      'test_branch_with_retry',
      '--endpoint.type',
      'read_only',
    ],
    expected: {
      stderr: expect.stringContaining('Resource is locked'),
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'delete',
    args: [
      'endpoints',
      'delete',
      '--project.id',
      'test',
      '--endpoint.id',
      'test_endpoint_id',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'update',
    args: [
      'endpoints',
      'update',
      '--project.id',
      'test',
      '--endpoint.id',
      'test_endpoint_id',
      '--endpoint.branch_id',
      'test_branch_id',
    ],
    expected: {
      snapshot: true,
    },
  });

  testCliCommand({
    name: 'get',
    args: [
      'endpoints',
      'get',
      '--project.id',
      'test',
      '--endpoint.id',
      'test_endpoint_id',
    ],
    expected: {
      snapshot: true,
    },
  });
});
