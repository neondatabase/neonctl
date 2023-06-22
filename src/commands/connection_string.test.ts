import { describe } from '@jest/globals';
import { testCliCommand } from '../test_utils';

describe('connection_string', () => {
  testCliCommand({
    name: 'connection_string',
    args: [
      'connection-string',
      '--project.id',
      'test',
      '--endpoint.id',
      'test_endpoint_id',
      '--database.name',
      'test_db',
      '--role.name',
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
      '--project.id',
      'test',
      '--endpoint.id',
      'test_endpoint_id',
      '--database.name',
      'test_db',
      '--role.name',
      'test_role',
      '--pooled',
    ],
    expected: {
      snapshot: true,
    },
  });
});
