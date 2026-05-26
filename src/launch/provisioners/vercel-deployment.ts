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
import { vercelTokenMissingMessage } from '../errors.js';

// =============================================================================
// Endpoint versions (locked, do not change without re-checking)
// =============================================================================

const VERCEL_API = {
  base: 'https://api.vercel.com',
  /** Single-project read. v9 still current per Vercel docs 2026-05. */
  projectGet: (idOrName: string) => `/v9/projects/${idOrName}`,
  /** Project list (paginated `{ projects, pagination }`). */
  projectList: () => `/v10/projects`,
  /** Env-var upsert (array body). */
  envUpsert: (id: string) => `/v10/projects/${id}/env?upsert=true`,
  /** Team-slug → team-id resolution. */
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
function wrapTeam(path: string, ctx: VercelClientCtx): string {
  if (!ctx.teamId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}teamId=${encodeURIComponent(ctx.teamId)}`;
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
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[neon launch] Vercel ${init?.method ?? 'GET'} ${path} returned ${res.status}: ${body}`,
    );
  }
  return (await res.json()) as T;
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

  // The client yields events. The iterator emits one of these terminal
  // types and then `return`s:
  //   - 'ready' / 'alias-assigned' → success
  //   - 'error' / 'canceled' → failure with payload
  //   - 'checks-v2-failed' → post-deploy checks failed; iterator ends
  //     silently otherwise, which would surface as a generic "stream ended"
  //     message masking the actual failure reason
  // Non-terminal informational events: 'created', 'building', 'checks-running',
  // 'checks-conclusion-failed' (latter does NOT end the stream — wait for
  // the subsequent error / alias-assigned).
  for await (const event of vercelCreateDeployment(
    clientOpts as Parameters<typeof vercelCreateDeployment>[0],
    deploymentOpts as Parameters<typeof vercelCreateDeployment>[1],
  )) {
    const payload = event.payload as {
      url?: string;
      readyState?: string;
      errorMessage?: string;
    };
    if (payload.url) url = `https://${payload.url}`;
    if (payload.readyState) status = payload.readyState;
    if (event.type === 'ready' || event.type === 'alias-assigned') {
      return { url: url ?? '', status: 'READY' };
    }
    if (
      event.type === 'error' ||
      event.type === 'canceled' ||
      event.type === 'checks-v2-failed'
    ) {
      const msg =
        event.payload instanceof Error
          ? event.payload.message
          : (payload.errorMessage ?? JSON.stringify(event.payload));
      throw new Error(`[neon launch] Vercel deployment ${event.type}: ${msg}`);
    }
  }

  // Iterator ended without a terminal event — surface what we last saw.
  throw new Error(
    `[neon launch] Vercel deployment stream ended without a terminal event (last status: ${status ?? 'unknown'}).`,
  );
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
}): Promise<{ url: string }> {
  if (!opts.ctx.token) {
    throw new Error(vercelTokenMissingMessage());
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

  // 2. Project id + name resolution (spec.project may be an id or a name —
  // the Vercel deployment endpoint requires the NAME).
  log.info(`[${opts.resourceFqn}] resolving Vercel project…`);
  const project = await resolveProject(opts.spec.project, ctx);

  // 3. Persist resolved ids.
  const persist: Record<string, string> = { VERCEL_PROJECT_ID: project.id };
  if (teamId) persist.VERCEL_TEAM_ID = teamId;
  writeNeonLaunchEnv(opts.repoRoot, persist);

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
