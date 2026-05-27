/**
 * Postgres provisioner tests — pin behaviors that are easy to regress
 * and that prior reviewers explicitly flagged:
 *   - archived branches throw a CONFIG_ERROR with restore/rename guidance,
 *     never silently polling until the per-branch budget expires;
 *   - 409 / 422 on createProjectBranch fall back to list+attach (concurrent
 *     race) while other 4xx codes rethrow unchanged;
 *   - quota-exhausted responses are converted to LaunchError(AUTH_MISSING);
 *   - pollOpsTerminal preserves the last-seen op.error / failures_count in
 *     its timeout message so the user sees the real Neon failure, not just
 *     an opaque op id.
 */
import type { AxiosError } from 'axios';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ExitCode } from '../errors.js';

import { pollOpsTerminal, provisionPostgres } from './postgres.js';

// src/pkg.ts reads package.json relative to itself; in vitest the file
// doesn't sit next to the .ts source, so stub it.
vi.mock('../../pkg.ts', () => ({ default: { version: '0.0.0' } }));

type Branch = {
  id: string;
  name: string;
  current_state: string;
  default: boolean;
};

type ApiOpts = {
  listings: Branch[][];
  createReject?: unknown;
  createResp?: {
    data: { branch: { id: string }; operations: { id: string }[] };
  };
  endpoints?: unknown[];
  roles?: unknown[];
  databases?: unknown[];
  opSequence?: Record<string, unknown[]>;
};

function makeApi(opts: ApiOpts) {
  let listCall = 0;
  const opCursors: Record<string, number> = {};
  return {
    listProjectBranches: vi.fn(() => {
      const branches =
        opts.listings[Math.min(listCall, opts.listings.length - 1)] ?? [];
      listCall += 1;
      return Promise.resolve({ data: { branches, pagination: undefined } });
    }),
    createProjectBranch: vi.fn(() => {
      if (opts.createReject) return Promise.reject(opts.createReject as Error);
      return Promise.resolve(
        opts.createResp ?? { data: { branch: {}, operations: [] } },
      );
    }),
    getProjectOperation: vi.fn((_projectId: string, opId: string) => {
      const seq = opts.opSequence?.[opId] ?? [];
      const i = opCursors[opId] ?? 0;
      opCursors[opId] = Math.min(i + 1, seq.length - 1);
      return Promise.resolve({ data: { operation: seq[i] } });
    }),
    getProjectBranch: vi.fn(() =>
      Promise.resolve({
        data: { branch: { id: 'br_1', current_state: 'ready', name: 'main' } },
      }),
    ),
    listProjectBranchEndpoints: vi.fn(() =>
      Promise.resolve({ data: { endpoints: opts.endpoints ?? [] } }),
    ),
    updateProjectEndpoint: vi.fn(() =>
      Promise.resolve({ data: { endpoint: (opts.endpoints ?? [])[0] } }),
    ),
    listProjectBranchRoles: vi.fn(() =>
      Promise.resolve({ data: { roles: opts.roles ?? [] } }),
    ),
    listProjectBranchDatabases: vi.fn(() =>
      Promise.resolve({ data: { databases: opts.databases ?? [] } }),
    ),
  };
}

const PARENT_BRANCH: Branch = {
  id: 'br_parent',
  name: 'parent',
  current_state: 'ready',
  default: true,
};

const NEW_BRANCH_EXISTS: Branch = {
  id: 'br_now_exists',
  name: 'main',
  current_state: 'ready',
  default: false,
};

const DEFAULT_ENDPOINTS = [
  {
    id: 'ep_1',
    type: 'read_write',
    autoscaling_limit_min_cu: 0.25,
    autoscaling_limit_max_cu: 1,
  },
];
const DEFAULT_ROLES = [{ name: 'app_user', protected: false }];
const DEFAULT_DBS = [{ name: 'neondb' }];

function axiosErr(status: number, message?: string): AxiosError {
  const err = new Error(message ?? `HTTP ${status}`) as AxiosError;
  err.isAxiosError = true;
  err.response = {
    status,
    statusText: '',
    headers: {},
    config: {} as never,
    data: message ? { message } : undefined,
  };
  return err;
}

describe('provisionPostgres — archived branch', () => {
  it('throws CONFIG_ERROR with restore/rename guidance instead of polling', async () => {
    const api = makeApi({
      listings: [
        [
          {
            id: 'br_archived',
            name: 'main',
            current_state: 'archived',
            default: true,
          },
        ],
      ],
    });
    await expect(
      provisionPostgres({
        api: api as any,
        projectId: 'prj_1',
        spec: { name: 'main' },
        resourceFqn: 'db',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/archived/i),
        exitCode: ExitCode.CONFIG_ERROR,
      }),
    );
    expect(api.getProjectBranch).not.toHaveBeenCalled();
    expect(api.createProjectBranch).not.toHaveBeenCalled();
  });
});

describe('provisionPostgres — concurrent-create race', () => {
  it('409 with branch present after → falls back to attach', async () => {
    const api = makeApi({
      // 1: findBranchByName 'main' → only parent. 2: resolveBranchFromId
      // default → parent. 3: post-409 findBranchByName 'main' → it now exists.
      listings: [[PARENT_BRANCH], [PARENT_BRANCH], [NEW_BRANCH_EXISTS]],
      createReject: axiosErr(409, 'branch with name already exists'),
      endpoints: DEFAULT_ENDPOINTS,
      roles: DEFAULT_ROLES,
      databases: DEFAULT_DBS,
    });
    const result = await provisionPostgres({
      api: api as any,
      projectId: 'prj_1',
      spec: { name: 'main' },
      resourceFqn: 'db',
    });
    expect(result.branch.id).toBe('br_now_exists');
    expect(api.createProjectBranch).toHaveBeenCalledTimes(1);
    // 3 list calls confirm the fallback path: find-by-name, resolve-default,
    // post-409 retry. A skipped retry would still pass the branch.id check
    // by accident if the parent listing happened to contain the name.
    expect(api.listProjectBranches).toHaveBeenCalledTimes(3);
  });

  it('422 with branch present after → falls back to attach', async () => {
    const api = makeApi({
      listings: [[PARENT_BRANCH], [PARENT_BRANCH], [NEW_BRANCH_EXISTS]],
      createReject: axiosErr(422, 'validation: branch exists'),
      endpoints: DEFAULT_ENDPOINTS,
      roles: DEFAULT_ROLES,
      databases: DEFAULT_DBS,
    });
    const result = await provisionPostgres({
      api: api as any,
      projectId: 'prj_1',
      spec: { name: 'main' },
      resourceFqn: 'db',
    });
    expect(result.branch.id).toBe('br_now_exists');
    expect(api.listProjectBranches).toHaveBeenCalledTimes(3);
  });

  it('409 with branch still absent → rethrows original error', async () => {
    const err = axiosErr(409, 'branch with name already exists');
    const api = makeApi({
      // No "main" ever appears.
      listings: [[PARENT_BRANCH]],
      createReject: err,
    });
    await expect(
      provisionPostgres({
        api: api as any,
        projectId: 'prj_1',
        spec: { name: 'main' },
        resourceFqn: 'db',
      }),
    ).rejects.toBe(err);
  });

  it('quota-exhausted body in 4xx → LaunchError(CONFIG_ERROR)', async () => {
    const api = makeApi({
      listings: [[PARENT_BRANCH]],
      createReject: axiosErr(403, 'branch limit reached for free plan'),
    });
    await expect(
      provisionPostgres({
        api: api as any,
        projectId: 'prj_1',
        spec: { name: 'main' },
        resourceFqn: 'db',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        exitCode: ExitCode.CONFIG_ERROR,
        message: expect.stringMatching(/branch.*limit|quota/i),
      }),
    );
  });

  it('401 on createProjectBranch → rethrows (not rerouted through findBranchByName)', async () => {
    const err = axiosErr(401, 'unauthorized');
    const api = makeApi({
      listings: [[PARENT_BRANCH]],
      createReject: err,
    });
    await expect(
      provisionPostgres({
        api: api as any,
        projectId: 'prj_1',
        spec: { name: 'main' },
        resourceFqn: 'db',
      }),
    ).rejects.toBe(err);
    // Two list calls — findBranchByName + resolveBranchFromId. The 401 must
    // NOT trigger a third list call (which would silently succeed for a
    // read-only token).
    expect(api.listProjectBranches).toHaveBeenCalledTimes(2);
  });
});

describe('provisionPostgres — role selection', () => {
  it('rejects branches where every role is `protected: true` (no user role)', async () => {
    // Security-adjacent: a regression that picks roles[0] regardless of
    // `protected` would silently put a Neon system/superuser role into
    // the user's DATABASE_URL. The CONFIG_ERROR path must fire.
    const api = makeApi({
      listings: [
        [
          {
            id: 'br_1',
            name: 'main',
            current_state: 'ready',
            default: true,
          },
        ],
      ],
      endpoints: DEFAULT_ENDPOINTS,
      // Every role is protected — no user-owned role exists.
      roles: [
        { name: 'cloud_admin', protected: true },
        { name: 'neon_superuser', protected: true },
      ],
      databases: DEFAULT_DBS,
    });
    await expect(
      provisionPostgres({
        api: api as any,
        projectId: 'prj_1',
        spec: { name: 'main' },
        resourceFqn: 'db',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        exitCode: ExitCode.CONFIG_ERROR,
        message: expect.stringMatching(/no user-owned role/i),
      }),
    );
  });

  it('picks the first non-protected role and ignores protected ones', async () => {
    const api = makeApi({
      listings: [
        [
          {
            id: 'br_1',
            name: 'main',
            current_state: 'ready',
            default: true,
          },
        ],
      ],
      endpoints: DEFAULT_ENDPOINTS,
      // Protected role listed FIRST to catch a regression to `roles[0]`.
      roles: [
        { name: 'cloud_admin', protected: true },
        { name: 'app_user', protected: false },
      ],
      databases: DEFAULT_DBS,
    });
    const result = await provisionPostgres({
      api: api as any,
      projectId: 'prj_1',
      spec: { name: 'main' },
      resourceFqn: 'db',
    });
    expect(result.role).toBe('app_user');
  });
});

describe('pollOpsTerminal — diagnostic preservation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout message includes the LATEST seen op.error and failures_count', async () => {
    // Two iterations of the poll loop: the first one observes
    // failures_count=2 and error="early"; the second observes
    // failures_count=5 and error="latest". The timeout message must
    // carry the LATEST snapshot, not the first — proves that lastSeen
    // accumulates across iterations rather than getting reset.
    let iteration = 0;
    const api = makeApi({
      listings: [],
      opSequence: {
        op_1: [
          {
            id: 'op_1',
            status: 'running',
            error: 'early: pool exhausted',
            failures_count: 2,
          },
          {
            id: 'op_1',
            status: 'running',
            error: 'latest: still pool exhausted',
            failures_count: 5,
          },
        ],
      },
    });
    // Override getProjectOperation to walk the opSequence positionally
    // (the default mock clamps to the last entry after the first poll).
    api.getProjectOperation.mockImplementation(() => {
      const i = Math.min(iteration, 1);
      iteration += 1;
      return Promise.resolve({
        data: { operation: { ...api } } as never,
      } as never).then(() => ({
        data: {
          operation: [
            {
              id: 'op_1',
              status: 'running',
              error: 'early: pool exhausted',
              failures_count: 2,
            },
            {
              id: 'op_1',
              status: 'running',
              error: 'latest: still pool exhausted',
              failures_count: 5,
            },
          ][i],
        },
      }));
    });
    const promise = pollOpsTerminal(
      api as any,
      'prj_1',
      ['op_1'],
      // 5s budget: one poll → sleep 2s → second poll → sleep 2s → deadline.
      5,
    );
    const assertion = expect(promise).rejects.toThrow(
      /Timed out.*op_1.*failures=5.*latest: still pool exhausted/s,
    );
    // Drain the two poll-and-sleep cycles + the deadline slip.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });
});
