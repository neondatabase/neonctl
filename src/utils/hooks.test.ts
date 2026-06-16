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

  test('a bare policy yields only postgres (+ branch) — no service namespaces', () => {
    const env = buildHookEnv({
      DATABASE_URL: 'postgres://pooled/neondb',
      DATABASE_URL_UNPOOLED: 'postgres://direct/neondb',
    });
    expect(env.auth).toBeUndefined();
    expect(env.dataApi).toBeUndefined();
    expect(env.storage).toBeUndefined();
    expect(env.aiGateway).toBeUndefined();
  });

  test('populates every namespace whose vars are present (sound NeonEnv at runtime)', () => {
    const env = buildHookEnv({
      DATABASE_URL: 'postgres://pooled/neondb',
      DATABASE_URL_UNPOOLED: 'postgres://direct/neondb',
      NEON_AUTH_BASE_URL: 'https://auth.neon',
      NEON_AUTH_JWKS_URL: 'https://auth.neon/jwks',
      NEON_DATA_API_URL: 'https://dataapi.neon',
      AWS_ACCESS_KEY_ID: 'nak_live_x',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_ENDPOINT_URL_S3: 'https://s3.neon',
      AWS_REGION: 'us-east-2',
      OPENAI_API_KEY: 'sk-neon',
      OPENAI_BASE_URL: 'https://ai.neon/openai/v1',
    });
    expect(env.auth).toEqual({
      baseUrl: 'https://auth.neon',
      jwksUrl: 'https://auth.neon/jwks',
    });
    expect(env.dataApi).toEqual({ url: 'https://dataapi.neon' });
    expect(env.storage).toEqual({
      accessKeyId: 'nak_live_x',
      secretAccessKey: 'secret',
      endpoint: 'https://s3.neon',
      region: 'us-east-2',
      forcePathStyle: true,
    });
    expect(env.aiGateway).toEqual({
      apiKey: 'sk-neon',
      baseUrl: 'https://ai.neon/openai/v1',
    });
  });
});
