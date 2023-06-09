import { describe } from '@jest/globals';

import { testCliCommand } from '../test_utils.js';

describe('operations', () => {
  testCliCommand({
    name: 'list',
    args: ['operations', 'list', '--project.id', 'test'],
    expected: {
      snapshot: true,
    },
  });
});
