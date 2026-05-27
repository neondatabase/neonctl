/**
 * Vercel-deployment provisioner.
 *
 * - `@vercel/client` is **lazy-imported** here only; never top-level —
 *   Node-18 callers of other neonctl commands must not pay its load cost.
 * - Project lookup, team-slug resolution, and env-var upsert hit the Vercel
 *   REST API directly (Node 22 global `fetch`). The endpoint version per
 *   surface is locked in `VERCEL_API` below.
 * - `?teamId=<id>` is appended to every request when set, via `wrapTeam`.
 */
import { execSync } from 'node:child_process';

import { log } from '../../log.js';
import type { VercelDeploymentSpec } from '../config.js';
import { writeNeonLaunchEnv } from '../context.js';
import { ExitCode, LaunchError, vercelTokenMissingMessage } from '../errors.js';

// =============================================================================
// Endpoint versions (verified 2026-05-27 against vercel.com/docs/rest-api)
// =============================================================================

const VERCEL_API = {
  base: 'https://api.vercel.com',
  /** Find a project by id or name. */
  projectGet: (idOrName: string) => `/v9/projects/${idOrName}`,
  /** Create or upsert env vars for a project (array body). */
  envUpsert: (id: string) => `/v10/projects/${id}/env?upsert=true`,
  /** Resolve a team by slug. Vercel's `/v2/teams/{teamId}` accepts `slug=`
   *  as an alternate addressing mode when the path id is omitted. */
  teamBySlug: (slug: string) => `/v2/teams?slug=${encodeURIComponent(slug)}`,
} as const;

// =============================================================================
// Types
// =============================================================================

export type VercelClientCtx = {
  token: string;
  teamId?: string;
};

type VercelProject = {
  id: string;
  name: string;
};

type VercelEnvVar = {
  key: string;
  value: string;
  type: 'plain' | 'encrypted';
  target: ('production' | 'preview' | 'development')[];
  gitBranch?: string;
};

type VercelDeploymentResult = {
  url: string;
  status: string;
};

// =============================================================================
// HTTP helpers
// =============================================================================

/**
 * Append `?teamId=` to `path` if `ctx.teamId` is set. Returns the path with
 * the merged query string. Handles both pre-existing query strings and bare
 * paths.
 */
export function wrapTeam(path: string, ctx: VercelClientCtx): string {
  if (!ctx.teamId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}teamId=${encodeURIComponent(ctx.teamId)}`;
}

const VERCEL_RETRY_ATTEMPTS = 3;
const VERCEL_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function vercelFetch<T>(
  path: string,
  ctx: VercelClientCtx,
  init?: RequestInit,
): Promise<T> {
  const url = `${VERCEL_API.base}${wrapTeam(path, ctx)}`;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${ctx.token}`);
  headers.set('Content-Type', 'application/json');
  let attempt = 0;
  while (true) {
    const res = await fetch(url, { ...init, headers });
    if (res.ok) return (await res.json()) as T;
    // Retry on 429 (honor Retry-After if present) and 5xx. Non-idempotent
    // POSTs are retried too: env-upsert is idempotent server-side (the
    // `upsert=true` query param), project/team lookups are GET.
    const transient =
      res.status === 429 || (res.status >= 500 && res.status < 600);
    attempt += 1;
    if (!transient || attempt >= VERCEL_RETRY_ATTEMPTS) {
      const body = await res.text();
      throw new Error(
        `[neon launch] Vercel ${init?.method ?? 'GET'} ${path} returned ${res.status}: ${body}`,
      );
    }
    const retryAfter = Number(res.headers.get('Retry-After'));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : VERCEL_BASE_DELAY_MS * 2 ** (attempt - 1);
    log.info(
      `[vercel] retrying ${init?.method ?? 'GET'} ${path} after ${res.status} (attempt ${attempt}/${VERCEL_RETRY_ATTEMPTS - 1}, ${delay}ms)`,
    );
    await sleep(delay);
  }
}

// =============================================================================
// Project + team resolution
// =============================================================================

/**
 * Resolve a project identifier to a concrete `projectId`. Accepts either an
 * id (`prj_xxx`) or a name; the Vercel API's `GET /v9/projects/{idOrName}`
 * accepts both.
 */
export async function resolveProject(
  projectIdOrName: string,
  ctx: VercelClientCtx,
): Promise<{ id: string; name: string }> {
  const project = await vercelFetch<VercelProject>(
    VERCEL_API.projectGet(projectIdOrName),
    ctx,
  );
  return { id: project.id, name: project.name };
}

/**
 * Resolve a team slug to a `team_xxx` id. Call once, persist result.
 */
export async function resolveTeamSlug(
  slug: string,
  token: string,
): Promise<string> {
  type Resp = { id: string };
  const resp = await vercelFetch<Resp>(VERCEL_API.teamBySlug(slug), { token });
  return resp.id;
}

// =============================================================================
// Env upsert
// =============================================================================

/**
 * Upsert env vars on the Vercel project.
 *
 * Target rule:
 *   production: true  → target: ['production'] (no gitBranch)
 *   production: false → target: ['preview'], gitBranch: ctx.gitBranch
 */
export async function upsertEnvVars(opts: {
  projectId: string;
  envs: Record<string, string>;
  production: boolean;
  gitBranch: string;
  ctx: VercelClientCtx;
}): Promise<void> {
  const body: VercelEnvVar[] = Object.entries(opts.envs).map(([key, value]) => {
    if (opts.production) {
      return {
        key,
        value,
        type: 'encrypted',
        target: ['production'],
      };
    }
    return {
      key,
      value,
      type: 'encrypted',
      target: ['preview'],
      gitBranch: opts.gitBranch,
    };
  });
  await vercelFetch(VERCEL_API.envUpsert(opts.projectId), opts.ctx, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// =============================================================================
// Deployment trigger
// =============================================================================

function gitHeadSha(cwd: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Timeout so a hung git (LFS waiting on creds, FS issue) doesn't
      // block the provisioner indefinitely. Missing the commit SHA
      // just drops the `gitMetadata` annotation on the Vercel deploy.
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Trigger a Vercel deployment via `@vercel/client.createDeployment`. The
 * client streams `created`/`building`/`ready` events; we resolve when we see
 * `ready` and reject on `error`/`canceled`.
 *
 * - `skipAutoDetectionConfirmation: 1` — passed via the client's options
 *   bag, which forwards it as a query param.
 * - `gitMetadata: { commitRef, commitSha }` — wires the commit annotation
 *   so the Vercel dashboard links the deployment to the right git SHA.
 */
export async function createDeployment(opts: {
  projectName: string;
  cwd: string;
  gitBranch: string;
  production: boolean;
  ctx: VercelClientCtx;
}): Promise<VercelDeploymentResult> {
  // Lazy-import so Node-18 callers of other neonctl commands don't pay the
  // @vercel/client load cost.
  const { createDeployment: vercelCreateDeployment } = await import(
    '@vercel/client'
  );

  const commitSha = gitHeadSha(opts.cwd);

  let url: string | undefined;
  let status: string | undefined;

  const clientOpts = {
    token: opts.ctx.token,
    path: opts.cwd,
    teamId: opts.ctx.teamId,
    // `1` is the canonical form on the wire; the typed client accepts
    // boolean. Both serialize to the same query param.
    skipAutoDetectionConfirmation: true,
  };
  // `name` is the Vercel *project name* (not the id) — Vercel matches the
  // deployment to an existing project by name. Passing the id would 4xx or
  // create a new project named after the id. Resolved via `resolveProject`
  // upstream.
  const deploymentOpts = {
    name: opts.projectName,
    target: opts.production ? 'production' : undefined,
    gitMetadata: commitSha
      ? { commitRef: opts.gitBranch, commitSha }
      : undefined,
  };

  // Terminal-event handling:
  //   - PREVIEW success: 'ready' resolves with the per-deploy URL (the
  //     <id>.vercel.app host). 'alias-assigned' may NEVER fire for non-
  //     git-connected file-upload deploys, so we don't wait for it.
  //   - PROD success: 'alias-assigned' resolves with the canonical
  //     domain. 'ready' fires earlier but `payload.url` is still the
  //     per-deploy host at that point; aliases haven't been wired yet.
  //   - Failures: 'error', 'canceled', 'checks-v2-failed',
  //     'checks-conclusion-failed', 'checks-conclusion-canceled'.
  //
  // Outer timeout via Promise.race: if the underlying stream goes
  // silent (Vercel edge partial outage holding the connection open
  // without emitting events), the `for await` blocks indefinitely on
  // the iterator's `next()` promise — checking the deadline inside
  // the loop body would never fire. The race kicks the timeout
  // independent of stream activity.
  const DEPLOY_TIMEOUT_MS = 15 * 60 * 1_000;
  const iterator = vercelCreateDeployment(
    clientOpts as Parameters<typeof vercelCreateDeployment>[0],
    deploymentOpts as Parameters<typeof vercelCreateDeployment>[1],
  );
  const walk = async (): Promise<VercelDeploymentResult> => {
    let aliasedUrl: string | undefined;
    for await (const event of iterator) {
      const payload = event.payload as {
        url?: string;
        alias?: string[];
        readyState?: string;
      };
      if (payload.url) url = `https://${payload.url}`;
      if (payload.readyState) status = payload.readyState;
      if (event.type === 'ready' && !opts.production) {
        return { url: url ?? '', status: 'READY' };
      }
      if (event.type === 'alias-assigned') {
        const first = payload.alias?.[0];
        if (first) aliasedUrl = `https://${first}`;
        return { url: aliasedUrl ?? url ?? '', status: 'READY' };
      }
      if (
        event.type === 'error' ||
        event.type === 'canceled' ||
        event.type === 'checks-v2-failed' ||
        event.type === 'checks-conclusion-failed' ||
        event.type === 'checks-conclusion-canceled'
      ) {
        throw new Error(
          `[neon launch] Vercel deployment ${event.type}: ${extractEventMessage(event.type, event.payload)}`,
        );
      }
    }
    throw new Error(
      `[neon launch] Vercel deployment stream ended without a terminal event (last status: ${status ?? 'unknown'}).`,
    );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      walk(),
      new Promise<VercelDeploymentResult>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `[neon launch] Vercel deployment exceeded ${DEPLOY_TIMEOUT_MS / 60_000}min timeout (last status: ${status ?? 'unknown'}).`,
            ),
          );
        }, DEPLOY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pull a human-readable message out of a Vercel deployment event payload
 * without leaking the full deployment object to the user terminal.
 *
 * Payload shapes the client yields (verified against
 * node_modules/@vercel/client/dist/check-deployment-status.js):
 *   - `error` from BUILD_FAILED / isFailed: deployment object whose
 *     `.error` may carry a `.message` string.
 *   - `error` from isAliasError: BARE STRING (`deploymentUpdate.aliasError`,
 *     typed `string | null`) — NOT an object.
 *   - `canceled` / `checks-v2-failed` / `checks-conclusion-*`: the full
 *     deployment object. `checks-v2-failed` carries the underlying check
 *     reason at `payload.checks['deployment-alias'].errorMessage`.
 *
 * We DO NOT fall back to JSON.stringify(payload) — the deployment object
 * carries env-var keys/values and other sensitive shape that has no place
 * in a terminal error line.
 */
function extractEventMessage(eventType: string, payload: unknown): string {
  if (payload instanceof Error) return payload.message;
  if (typeof payload === 'string') return payload;
  if (payload !== null && typeof payload === 'object') {
    const p = payload as {
      message?: unknown;
      errorMessage?: unknown;
      error?: { message?: unknown };
      checks?: { 'deployment-alias'?: { errorMessage?: unknown } };
    };
    if (typeof p.message === 'string') return p.message;
    if (typeof p.errorMessage === 'string') return p.errorMessage;
    if (typeof p.error?.message === 'string') return p.error.message;
    const checkMsg = p.checks?.['deployment-alias']?.errorMessage;
    if (typeof checkMsg === 'string') return checkMsg;
  }
  // Fixed fallback per event type — never the raw payload.
  if (eventType === 'canceled') return 'deployment was canceled';
  if (eventType === 'checks-conclusion-canceled') return 'checks canceled';
  if (eventType === 'checks-conclusion-failed') return 'checks failed';
  return 'no detail provided by Vercel';
}

// =============================================================================
// Top-level provisioner entry
// =============================================================================

/**
 * Provision a vercel-deployment resource end-to-end. Returns the resolved
 * outputs (just `url` for v1).
 *
 * Responsibilities:
 *   1. Read VERCEL_TOKEN; exit 3 (caller decides) if missing.
 *   2. Resolve team slug → teamId if `spec.team` is set.
 *   3. Resolve project id (accepts id or name).
 *   4. Persist resolved ids to `.neon-launch.env`.
 *   5. Upsert env vars (target depends on `production`).
 *   6. Create deployment, await `ready`.
 */
export async function provisionVercelDeployment(opts: {
  resourceFqn: string;
  spec: VercelDeploymentSpec;
  resolvedEnv: Record<string, string>;
  ctx: VercelClientCtx;
  gitBranch: string;
  repoRoot: string;
  cwd: string;
  /**
   * Resolved project ids+names from a previous run (process.env or
   * .neon-launch.env). When `spec.project` matches the cached id or
   * name, we skip the `/v9/projects/{idOrName}` lookup — saves a Vercel
   * API round-trip on every subsequent run.
   */
  cachedProjectId?: string;
  cachedProjectName?: string;
}): Promise<{ url: string }> {
  if (!opts.ctx.token) {
    throw new LaunchError(vercelTokenMissingMessage(), ExitCode.AUTH_MISSING);
  }

  // 1. Team slug resolution + persistence.
  let teamId = opts.ctx.teamId ?? opts.spec.teamId;
  if (!teamId && opts.spec.team) {
    log.info(
      `[${opts.resourceFqn}] resolving Vercel team slug '${opts.spec.team}'…`,
    );
    teamId = await resolveTeamSlug(opts.spec.team, opts.ctx.token);
  }

  const ctx: VercelClientCtx = { token: opts.ctx.token, teamId };

  // 2. Project id + name resolution. spec.project may be an id or a name;
  // the deployment endpoint requires the NAME, env-upsert requires the ID.
  // Skip the lookup if a previous run cached both AND spec.project still
  // matches one of them.
  let project: { id: string; name: string };
  if (
    opts.cachedProjectId &&
    opts.cachedProjectName &&
    (opts.spec.project === opts.cachedProjectId ||
      opts.spec.project === opts.cachedProjectName)
  ) {
    project = { id: opts.cachedProjectId, name: opts.cachedProjectName };
    log.info(
      `[${opts.resourceFqn}] using cached Vercel project ${project.name} (${project.id}).`,
    );
  } else {
    log.info(`[${opts.resourceFqn}] resolving Vercel project…`);
    project = await resolveProject(opts.spec.project, ctx);
  }

  // 3. Persist resolved ids/names so the next run can skip the lookup.
  const persist: Record<string, string> = {
    VERCEL_PROJECT_ID: project.id,
    VERCEL_PROJECT_NAME: project.name,
  };
  if (teamId) persist.VERCEL_TEAM_ID = teamId;
  await writeNeonLaunchEnv(opts.repoRoot, persist);

  // 4. Env-var upsert.
  const production = opts.spec.production === true;
  log.info(
    `[${opts.resourceFqn}] upserting ${Object.keys(opts.resolvedEnv).length} env vars (target: ${production ? 'production' : 'preview'})…`,
  );
  await upsertEnvVars({
    projectId: project.id,
    envs: opts.resolvedEnv,
    production,
    gitBranch: opts.gitBranch,
    ctx,
  });

  // 5. Deployment trigger.
  log.info(`[${opts.resourceFqn}] triggering deployment…`);
  const result = await createDeployment({
    projectName: project.name,
    cwd: opts.cwd,
    gitBranch: opts.gitBranch,
    production,
    ctx,
  });

  return { url: result.url };
}
