import { describe } from 'vitest';

import { test } from '../test_utils/fixtures';

describe('orgs', () => {
  test('list', async ({ testCliCommand }) => {
    await testCliCommand(['orgs', 'list']);
  });
});
