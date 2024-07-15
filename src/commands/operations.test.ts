import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('operations', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand(['operations', 'list', '--project-id', 'test']);
  });
});
