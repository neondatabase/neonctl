/**
 * Vercel-deployment provisioner — tests for the small but load-bearing
 * pure functions (`wrapTeam`) and the body shape `upsertEnvVars` posts
 * to the Vercel API. These pin two contracts that prior reviewers
 * flagged as falsifiable without tests:
 *   - `wrapTeam` appends `?teamId=…` for bare paths and `&teamId=…`
 *     for paths with a pre-existing query string.
 *   - `upsertEnvVars` body shape: production:true → target:['production']
 *     (no gitBranch); production:false → target:['preview'] with gitBranch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { upsertEnvVars, wrapTeam } from './vercel-deployment.js';

describe('wrapTeam', () => {
  it('no teamId → path unchanged', () => {
    expect(wrapTeam('/v9/projects/foo', { token: 't' })).toBe(
      '/v9/projects/foo',
    );
  });

  it('teamId on a bare path → ?teamId=…', () => {
    expect(
      wrapTeam('/v9/projects/foo', { token: 't', teamId: 'team_abc' }),
    ).toBe('/v9/projects/foo?teamId=team_abc');
  });

  it('teamId on a path with ? → &teamId=…', () => {
    expect(
      wrapTeam('/v10/projects/foo/env?upsert=true', {
        token: 't',
        teamId: 'team_abc',
      }),
    ).toBe('/v10/projects/foo/env?upsert=true&teamId=team_abc');
  });

  it('special characters in teamId are URI-encoded', () => {
    expect(
      wrapTeam('/v9/projects/foo', { token: 't', teamId: 'team a&b' }),
    ).toBe('/v9/projects/foo?teamId=team%20a%26b');
  });
});

describe('upsertEnvVars body shape', () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown;
  let capturedUrl: string | undefined;
  let capturedMethod: string | undefined;

  beforeEach(() => {
    capturedBody = undefined;
    capturedUrl = undefined;
    capturedMethod = undefined;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : String(input);
      capturedMethod = init?.method;
      if (typeof init?.body === 'string') capturedBody = JSON.parse(init.body);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('production:true → target:[production], no gitBranch', async () => {
    await upsertEnvVars({
      projectId: 'prj_abc',
      envs: { DATABASE_URL: 'postgres://...' },
      production: true,
      gitBranch: 'main',
      ctx: { token: 't' },
    });
    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toContain('/v10/projects/prj_abc/env?upsert=true');
    expect(capturedBody).toEqual([
      {
        key: 'DATABASE_URL',
        value: 'postgres://...',
        type: 'encrypted',
        target: ['production'],
      },
    ]);
  });

  it('production:false → target:[preview] with gitBranch', async () => {
    await upsertEnvVars({
      projectId: 'prj_abc',
      envs: { DATABASE_URL: 'postgres://...' },
      production: false,
      gitBranch: 'feature-foo',
      ctx: { token: 't' },
    });
    expect(capturedBody).toEqual([
      {
        key: 'DATABASE_URL',
        value: 'postgres://...',
        type: 'encrypted',
        target: ['preview'],
        gitBranch: 'feature-foo',
      },
    ]);
  });

  it('teamId is appended to the request URL', async () => {
    await upsertEnvVars({
      projectId: 'prj_abc',
      envs: { DATABASE_URL: 'postgres://...' },
      production: true,
      gitBranch: 'main',
      ctx: { token: 't', teamId: 'team_xyz' },
    });
    expect(capturedUrl).toContain('teamId=team_xyz');
  });
});
