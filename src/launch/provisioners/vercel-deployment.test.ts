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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `@vercel/client` is lazy-imported inside createDeployment; mock the
// surface that contributes to the iterator. Each test supplies its own
// event sequence via the per-test mockReturnValue below.
let mockEvents: { type: string; payload: unknown }[] = [];
vi.mock('@vercel/client', () => ({
  createDeployment: () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* gen() {
      for (const e of mockEvents) yield e;
    }
    return gen();
  },
}));

import {
  createDeployment,
  parseRetryAfter,
  upsertEnvVars,
  wrapTeam,
} from './vercel-deployment.js';

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

  it('failed[] in response is surfaced as a launch error, not silently swallowed', async () => {
    // Replace the default 200/{} fetch with one that returns a partial
    // failure envelope. Vercel returns HTTP 200 + `{failed: [...]}` for
    // per-key collisions / validation errors; silently swallowing this
    // boots the next deploy without the intended env var.
    const stash = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            created: [],
            failed: [
              {
                key: 'DATABASE_URL',
                error: {
                  code: 'ENV_ALREADY_EXISTS',
                  message: 'Variable already exists with conflicting target',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )) as typeof fetch;
    try {
      await expect(
        upsertEnvVars({
          projectId: 'prj_abc',
          envs: { DATABASE_URL: 'postgres://...' },
          production: true,
          gitBranch: 'main',
          ctx: { token: 't' },
        }),
      ).rejects.toThrow(
        /Vercel env-var upsert partially failed.*DATABASE_URL.*ENV_ALREADY_EXISTS.*Variable already exists/,
      );
    } finally {
      globalThis.fetch = stash;
    }
  });

  it('teamId is appended to the upsert URL with the right separator', async () => {
    await upsertEnvVars({
      projectId: 'prj_abc',
      envs: { DATABASE_URL: 'postgres://...' },
      production: true,
      gitBranch: 'main',
      ctx: { token: 't', teamId: 'team_xyz' },
    });
    // Anchor the separator: the endpoint already has `?upsert=true`, so
    // the team id MUST join with `&`. A regression in wrapTeam that
    // always emits `?` would produce `?upsert=true?teamId=…` (invalid)
    // and slip past a loose `toContain('teamId=team_xyz')`.
    expect(capturedUrl).toContain('?upsert=true&teamId=team_xyz');
  });
});

describe('createDeployment — terminal event routing', () => {
  const baseOpts = {
    projectName: 'demo',
    cwd: '/tmp',
    gitBranch: 'main',
    ctx: { token: 't' },
  };

  it('preview success resolves at `ready` with the per-deploy URL', async () => {
    mockEvents = [
      { type: 'building', payload: { readyState: 'BUILDING' } },
      {
        type: 'ready',
        payload: { url: 'abc.vercel.app', readyState: 'READY' },
      },
    ];
    const result = await createDeployment({ ...baseOpts, production: false });
    expect(result.url).toBe('https://abc.vercel.app');
    expect(result.status).toBe('READY');
  });

  it('production success resolves at `alias-assigned` with the canonical alias', async () => {
    mockEvents = [
      { type: 'ready', payload: { url: 'abc.vercel.app' } },
      // `ready` for production must NOT resolve — the iterator must wait
      // for alias-assigned to surface the production domain.
      {
        type: 'alias-assigned',
        payload: { url: 'abc.vercel.app', alias: ['demo.vercel.app'] },
      },
    ];
    const result = await createDeployment({ ...baseOpts, production: true });
    expect(result.url).toBe('https://demo.vercel.app');
  });

  it('production falls back to per-deploy URL when alias-assigned carries no alias', async () => {
    mockEvents = [
      { type: 'ready', payload: { url: 'abc.vercel.app' } },
      { type: 'alias-assigned', payload: { url: 'abc.vercel.app', alias: [] } },
    ];
    const result = await createDeployment({ ...baseOpts, production: true });
    expect(result.url).toBe('https://abc.vercel.app');
  });

  it('error event with object payload uses payload.message', async () => {
    mockEvents = [
      {
        type: 'error',
        payload: { message: 'BUILD_FAILED: missing tsconfig.json' },
      },
    ];
    await expect(
      createDeployment({ ...baseOpts, production: false }),
    ).rejects.toThrow(
      /Vercel deployment error: BUILD_FAILED: missing tsconfig\.json/,
    );
  });

  it('error event with bare-string payload (aliasError shape) uses the string directly', async () => {
    // The @vercel/client emits `{ type: 'error', payload: deploymentUpdate.aliasError }`
    // when the alias step fails — aliasError is typed `string | null`,
    // NOT an object. The honest-message extractor must handle bare strings.
    mockEvents = [
      { type: 'error', payload: 'Domain not configured for this team' },
    ];
    await expect(
      createDeployment({ ...baseOpts, production: true }),
    ).rejects.toThrow(
      /Vercel deployment error: Domain not configured for this team/,
    );
  });

  it('canceled event with full deployment payload yields a fixed message (not a JSON blob)', async () => {
    // The 'canceled' event carries the entire deployment object as payload
    // (~30 fields including env values). The extractor must NOT JSON-
    // stringify the payload — that would leak DATABASE_URL et al. to the
    // user terminal and the analytics sink.
    mockEvents = [
      {
        type: 'canceled',
        payload: {
          // shape echoes what @vercel/client emits — readyState + env etc.
          readyState: 'CANCELED',
          id: 'dpl_xyz',
          env: { DATABASE_URL: 'postgres://secret:secret@host/db' },
        },
      },
    ];
    // Two assertions: the message matches the fixed string AND it does
    // NOT contain the secret env-var value. A regression that fell back
    // to JSON.stringify(payload) would surface "postgres://secret:..."
    // in the user terminal AND the sendError analytics payload.
    await expect(
      createDeployment({ ...baseOpts, production: false }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /Vercel deployment canceled: deployment was canceled/,
        ),
      }),
    );
    await expect(
      createDeployment({ ...baseOpts, production: false }),
    ).rejects.toThrow(
      expect.not.objectContaining({
        message: expect.stringContaining('secret'),
      }),
    );
  });

  it('checks-v2-failed extracts the deployment-alias check errorMessage', async () => {
    mockEvents = [
      {
        type: 'checks-v2-failed',
        payload: {
          checks: {
            'deployment-alias': {
              state: 'failed',
              errorMessage: 'dns-01 challenge failed',
            },
          },
        },
      },
    ];
    await expect(
      createDeployment({ ...baseOpts, production: true }),
    ).rejects.toThrow(
      /Vercel deployment checks-v2-failed: dns-01 challenge failed/,
    );
  });

  it('checks-conclusion-failed is logged but NOT terminal — deploy can still succeed (non-blocking checks)', async () => {
    // @vercel/client yields checks-conclusion-failed without `return`,
    // i.e. continues polling. Non-blocking checks may fail but the
    // deploy can still proceed to ready + alias-assigned. The launcher
    // must NOT abort here, or it fails what Vercel itself promotes.
    mockEvents = [
      { type: 'checks-conclusion-failed', payload: { id: 'dpl_xyz' } },
      {
        type: 'alias-assigned',
        payload: { url: 'abc.vercel.app', alias: ['demo.vercel.app'] },
      },
    ];
    const result = await createDeployment({ ...baseOpts, production: true });
    expect(result.url).toBe('https://demo.vercel.app');
  });

  it('checks-conclusion-canceled is logged but NOT terminal', async () => {
    mockEvents = [
      { type: 'checks-conclusion-canceled', payload: {} },
      { type: 'ready', payload: { url: 'abc.vercel.app' } },
    ];
    const result = await createDeployment({ ...baseOpts, production: false });
    expect(result.url).toBe('https://abc.vercel.app');
  });

  it('iterator ending without a terminal event surfaces the last-seen status', async () => {
    mockEvents = [
      { type: 'building', payload: { readyState: 'BUILDING' } },
      // No terminal event.
    ];
    await expect(
      createDeployment({ ...baseOpts, production: false }),
    ).rejects.toThrow(
      /stream ended without a terminal event \(last status: BUILDING\)/,
    );
  });
});

describe('parseRetryAfter — RFC 9110 §10.2.3 dual form', () => {
  it('parses delta-seconds to milliseconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('returns undefined for null / missing header', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
  });

  it('parses HTTP-date form (RFC 9110)', () => {
    // Future date, ~10 seconds out. Use a value far enough in the
    // future that test scheduling jitter won't flip the sign.
    const tenSecondsFromNow = new Date(Date.now() + 10_000).toUTCString();
    const result = parseRetryAfter(tenSecondsFromNow);
    expect(result).toBeGreaterThan(8_000);
    expect(result).toBeLessThan(11_000);
  });

  it('past HTTP-date returns undefined (negative delta → exponential backoff fallback)', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toUTCString();
    expect(parseRetryAfter(yesterday)).toBeUndefined();
  });

  it('garbage header returns undefined', () => {
    expect(parseRetryAfter('not-a-date-not-a-number')).toBeUndefined();
  });

  it('negative seconds returns undefined', () => {
    expect(parseRetryAfter('-30')).toBeUndefined();
  });
});
