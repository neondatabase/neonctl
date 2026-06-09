import {
  defineConfig,
  loadConfigFromFile,
  type Config,
  type NeonApi,
} from '@neondatabase/config';
import {
  plan,
  pullConfig,
  type AppliedChange,
} from '@neondatabase/config-runtime';
import { fetchEnv, toEntries } from '@neondatabase/env';

import { log } from '../log.js';

export type DevEnvContext = {
  cwd: string;
  projectId?: string;
  branchId?: string;
  apiKey?: string;
  /** Injected NeonApi adapter (tests). Production builds it from `apiKey`. */
  api?: NeonApi;
};

/**
 * Thrown when a `neon.ts` policy declares a branch-level resource (Neon Auth,
 * Data API, a bucket, the AI Gateway) that the linked remote branch does not
 * have yet. Unlike every other failure in {@link resolveDevEnv} — which degrades
 * to "run without injection" — this is a hard stop: the user's intent (a policy)
 * cannot be honored, and silently dropping the secret would be more confusing
 * than refusing to start. The fix is to provision the resource first.
 */
export class DevEnvMismatchError extends Error {
  override readonly name = 'DevEnvMismatchError';
}

/**
 * Signals that no project/branch context could be resolved, so there is nothing to
 * resolve env from. `resolveDevEnv` degrades on this (dev runs without injection);
 * `env pull` surfaces it (an explicit pull needs a branch).
 */
export class MissingBranchContextError extends Error {
  override readonly name = 'MissingBranchContextError';
}

/**
 * Resolve the branch's Neon env vars (pooled / direct `DATABASE_URL`, plus Auth /
 * Data API when enabled) into a `{ KEY: value }` map. Shared by `neon dev` (which
 * injects them) and `neon env pull` (which writes them to a `.env` file).
 *
 * Tiered:
 *
 *   1. a `neon.ts` policy is found -> the policy is the source of truth. We first
 *      check it against the branch's live state (`plan`); if it declares a resource
 *      the branch is missing, we stop with a {@link DevEnvMismatchError} pointing at
 *      `neonctl deploy`. Otherwise `fetchEnv` evaluates the policy.
 *   2. no `neon.ts`, but a project + branch are known -> `pullConfig` reads the
 *      branch's live state (incl. Auth / Data API enablement) into a config, then
 *      `fetchEnv` resolves what is actually enabled.
 *   3. otherwise -> throw {@link MissingBranchContextError}.
 *
 * Unlike {@link resolveDevEnv}, this never swallows errors — callers decide how to
 * handle them.
 */
export const resolveNeonEnvVars = async (
  ctx: DevEnvContext,
): Promise<Record<string, string>> => {
  const config = await loadNeonConfig(ctx.cwd);

  if (config) {
    if (!ctx.projectId || !ctx.branchId) {
      throw new MissingBranchContextError(
        'Found a neon.ts but could not resolve the project/branch. ' +
          'Run `neonctl link` and `neonctl checkout <branch>`, or pass ' +
          '--project-id / --branch.',
      );
    }
    await assertPolicyMatchesBranch(config, ctx);
    return await fetchAndProject(config, ctx);
  }

  if (ctx.projectId && ctx.branchId) {
    const pulled = await pullConfig({
      projectId: ctx.projectId,
      branchId: ctx.branchId,
      ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
      ...(ctx.api ? { api: ctx.api } : {}),
    });
    return await fetchAndProject(
      defineConfig(() => pulled.config),
      ctx,
    );
  }

  throw new MissingBranchContextError(
    'No project/branch context found. Link a branch (`neonctl link` / ' +
      '`neonctl checkout`) or pass --project-id and --branch.',
  );
};

/**
 * `neon dev`'s env resolver: {@link resolveNeonEnvVars} with graceful degradation.
 * A missing branch context or any failure (no Neon account, no `.neon`, no network)
 * logs a warning and returns `{}` so the function still runs locally; only a
 * {@link DevEnvMismatchError} (policy declares a resource the branch lacks) is
 * re-thrown for the caller to surface.
 */
export const resolveDevEnv = async (
  ctx: DevEnvContext,
): Promise<Record<string, string>> => {
  try {
    return await resolveNeonEnvVars(ctx);
  } catch (err) {
    if (err instanceof DevEnvMismatchError) throw err;
    if (err instanceof MissingBranchContextError) {
      log.debug('dev: %s; skipping env injection', err.message);
      return {};
    }
    log.warning(
      'Could not inject Neon env vars; the function will run without them: %s',
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
};

/**
 * Tier-1 guard. Dry-run the policy against the branch's live state and stop if
 * it declares a branch-level resource the branch is missing. Built on `plan` so
 * it covers every present and future provisionable resource for free: any
 * `create` action is a resource `neonctl deploy` would provision.
 *
 * Functions are deliberately excluded: running an *un*deployed function locally
 * is the whole point of `neon dev`, so a not-yet-deployed function in the policy
 * must not block the dev server.
 */
const assertPolicyMatchesBranch = async (
  config: Config,
  ctx: DevEnvContext,
): Promise<void> => {
  const result = await plan(config, {
    projectId: ctx.projectId as string,
    branchId: ctx.branchId as string,
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(ctx.api ? { api: ctx.api } : {}),
  });

  const missing = result.applied.filter(isMissingResource);
  if (missing.length === 0) return;

  const names = missing.map((change) => change.identifier).join(', ');
  throw new DevEnvMismatchError(
    `Your neon.ts declares ${names} for branch ${ctx.branchId}, but the branch ` +
      'does not have it yet, so the matching env vars cannot be injected. ' +
      'Provision it first with `neonctl deploy` (or `neonctl config apply`), ' +
      'then re-run `neonctl dev`.',
  );
};

/**
 * A planned change that provisions a branch-level resource the branch lacks: a
 * `create` on a service (Neon Auth, Data API, a bucket, the AI Gateway). Branch
 * setting drift (`update`) and `noop`s are ignored — they don't block local dev
 * — and functions are excluded (see {@link assertPolicyMatchesBranch}).
 */
const isMissingResource = (change: AppliedChange): boolean =>
  change.kind === 'service' &&
  change.action === 'create' &&
  !change.identifier.startsWith('function:');

const fetchAndProject = async (
  config: Config,
  ctx: DevEnvContext,
): Promise<Record<string, string>> => {
  const env = await fetchEnv(config, {
    projectId: ctx.projectId as string,
    branchId: ctx.branchId as string,
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(ctx.api ? { api: ctx.api } : {}),
  });
  return toEntries(env);
};

/**
 * Load a `neon.ts` policy if one exists on the path from `cwd` up to the repo
 * root. Returns `null` when there is none (the common "no config" case), and
 * surfaces real load errors (e.g. a syntax error in an existing file).
 */
const loadNeonConfig = async (cwd: string): Promise<Config | null> => {
  try {
    const { config } = await loadConfigFromFile({ cwd });
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not find a Neon config file/i.test(message)) {
      return null;
    }
    throw err;
  }
};
