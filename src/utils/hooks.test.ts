import { describe, expect, test } from 'vitest';

import { buildHookEnv } from './hooks.js';

describe('buildHookEnv', () => {
  test('maps the flat Neon vars into the structured postgres shape', () => {
    const env = buildHookEnv({
      DATABASE_URL: 'postgres://pooled/neondb',
      DATABASE_URL_UNPOOLED: 'postgres://direct/neondb',
      NEON_BRANCH: 'preview/feature-billing',
    });
    expect(env.postgres.databaseUrl).toBe('postgres://pooled/neondb');
    expect(env.postgres.databaseUrlUnpooled).toBe('postgres://direct/neondb');
    expect(env.branch).toEqual({ name: 'preview/feature-billing' });
  });

  test('omits branch when NEON_BRANCH is absent and defaults missing URLs to empty', () => {
    const env = buildHookEnv({});
    expect(env.postgres.databaseUrl).toBe('');
    expect(env.postgres.databaseUrlUnpooled).toBe('');
    expect(env.branch).toBeUndefined();
  });
});
