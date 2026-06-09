import {
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
    // Resolve env from the policy with its `preview.functions` removed. Functions carry no
    // branch-level secrets — their env comes from the local `neon.ts` `functions.<slug>.env`,
    // layered per-function by the dev server — so env resolution never needs the functions
    // API. Probing it (via `plan`/`fetchEnv`) only adds a failure mode: an undeployed
    // function, or a project where the Functions Preview isn't enabled, would error and sink
    // ALL injection (including DATABASE_URL). Stripping functions keeps env resolution honest
    // while leaving buckets / AI Gateway / Auth / Data API fully checked — those DO carry
    // secrets, so a declared-but-missing one still hard-stops (see assertPolicyMatchesBranch).
    const envConfig = withoutPreviewFunctions(config);
    await assertPolicyMatchesBranch(envConfig, ctx);
    return await fetchAndProject(envConfig, ctx);
  }

  if (ctx.projectId && ctx.branchId) {
    const pulled = await pullConfig({
      projectId: ctx.projectId,
      branchId: ctx.branchId,
      ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
      ...(ctx.api ? { api: ctx.api } : {}),
    });
    // `pulled.config` is already a `Config` (static auth/dataApi toggles + a branch
    // tuning closure), so it feeds straight into fetchEnv — no wrapping needed.
    return await fetchAndProject(pulled.config, ctx);
  }

  throw new MissingBranchContextError(
    'No project/branch context found. Link a branch (`neonctl link` / ' +
      '`neonctl checkout`) or pass --project-id and --branch.',
  );
};

/**
 * The outcome of {@link resolveDevEnv}: the resolved Neon branch vars plus, when none could
 * be injected, a calm and actionable `skipped` reason for the dev server to surface. We
 * return the reason rather than logging it here so the imperative shell (`neon dev`) can
 * present it in context (in the banner, next to the URLs) — keeping this resolver a pure
 * "compute what env we have" function.
 */
export type DevEnvResolution = {
  /** Neon branch env vars to inject (DATABASE_URL[_UNPOOLED], NEON_AUTH_BASE_URL, …). */
  vars: Record<string, string>;
  /**
   * Present only when `vars` is empty *because* resolution was skipped/degraded (not when
   * the branch legitimately has no extra services). A short, actionable explanation.
   */
  skipped?: { reason: string };
};

/**
 * `neon dev`'s env resolver: {@link resolveNeonEnvVars} with graceful degradation.
 *
 * - Success → `{ vars }` (possibly just the always-present Postgres URLs).
 * - No linked branch / project → `{ vars: {}, skipped }` with a "link a branch" hint; the
 *   function still runs locally, just without Neon env.
 * - Any other failure (offline, transient API error) → `{ vars: {}, skipped }` naming the
 *   cause; again non-fatal.
 * - {@link DevEnvMismatchError} (policy declares a secret-bearing service the branch lacks)
 *   is the one hard stop and is re-thrown for the caller to surface.
 */
export const resolveDevEnv = async (
  ctx: DevEnvContext,
): Promise<DevEnvResolution> => {
  try {
    return { vars: await resolveNeonEnvVars(ctx) };
  } catch (err) {
    if (err instanceof DevEnvMismatchError) throw err;
    if (err instanceof MissingBranchContextError) {
      log.debug('dev: %s; skipping env injection', err.message);
      return {
        vars: {},
        skipped: {
          reason:
            'no linked Neon branch — run `neonctl link`, then ' +
            '`neonctl checkout <branch>`, to inject DATABASE_URL and friends',
        },
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.debug('dev: env resolution failed: %s', detail);
    return {
      vars: {},
      skipped: {
        reason: `could not reach Neon (${detail}); running without Neon env`,
      },
    };
  }
};

/**
 * Return the policy with its `preview.functions` removed, so the env path never enumerates
 * functions against the Neon API. Functions are local-source-bundled and produce no
 * branch-level secrets, so they are irrelevant to env resolution; probing them only risks
 * failing the whole resolve (undeployed function, or Functions Preview disabled on the
 * project). Buckets / AI Gateway and the top-level Auth / Data API toggles are preserved —
 * they DO carry env, so they must still be checked and resolved. Returns the config
 * unchanged when it declares no functions.
 */
const withoutPreviewFunctions = (config: Config): Config => {
  const preview = config.preview;
  if (!preview?.functions) return config;
  const previewWithoutFunctions = { ...preview };
  delete previewWithoutFunctions.functions;
  return { ...config, preview: previewWithoutFunctions };
};

/**
 * Tier-1 guard. Dry-run the policy against the branch's live state and stop if
 * it declares a branch-level resource the branch is missing. Built on `plan` so
 * it covers every present and future provisionable resource for free: any
 * `create` action is a resource `neonctl deploy` would provision.
 *
 * Called with functions already stripped (see {@link withoutPreviewFunctions}), so the
 * `plan` probe never enumerates the functions API — an undeployed function, or a project
 * without the Functions Preview, must never block local dev or sink env injection.
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
