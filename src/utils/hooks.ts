import { Api } from '@neondatabase/api-client';
import type {
  GitContext,
  HookBranch,
  HookEnv,
  Hooks,
  NeonApi,
  PushResult,
} from '@neondatabase/config';
import { loadConfigFromFile, runHook } from '@neondatabase/config-runtime';
import { NEON_ENV_VAR_KEYS } from '@neondatabase/env';

import { resolveNeonEnvVars } from '../dev/env.js';
import { log } from '../log.js';

/**
 * Load the `hooks` block from the nearest `neon.ts`, or `undefined` when there is no policy
 * on disk (so every command degrades to a no-op without a `neon.ts`). Other load errors —
 * a genuinely broken policy — propagate so the user sees them.
 */
export const loadHooks = async (cwd: string): Promise<Hooks | undefined> => {
  try {
    const { config } = await loadConfigFromFile({ cwd });
    return config.hooks;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not find a Neon config file/i.test(message)) return undefined;
    throw err;
  }
};

/** Stream hook (shell) output through the CLI logger. */
const onOutput = (chunk: string) => {
  const text = chunk.replace(/\n$/, '');
  if (text.length > 0) log.info('%s', text);
};

/**
 * Run the `checkout.before` hook (if any). Returns the rewritten branch name when the hook
 * (function form) returns `{ name }`, else `undefined`. Throws propagate to abort the
 * checkout — that's the documented `before`-hook contract.
 */
export const runCheckoutBeforeHook = async (args: {
  hooks: Hooks | undefined;
  inputName: string;
  git: GitContext;
  cwd: string;
}): Promise<string | undefined> => {
  const hook = args.hooks?.checkout?.before;
  if (!hook) return undefined;
  const result = await runHook(
    hook,
    { inputName: args.inputName, git: args.git },
    { cwd: args.cwd, onOutput },
  );
  return result?.name;
};

/** Run the `deploy.before` hook (if any). Throws propagate to abort the deploy. */
export const runDeployBeforeHook = async (args: {
  hooks: Hooks | undefined;
  branch: HookBranch;
  git: GitContext;
  cwd: string;
}): Promise<void> => {
  const hook = args.hooks?.deploy?.before;
  if (!hook) return;
  await runHook(
    hook,
    { branch: args.branch, git: args.git },
    {
      cwd: args.cwd,
      onOutput,
    },
  );
};

/**
 * Run the `checkout.after` hook (if any). Failures degrade to a warning — the branch is
 * already checked out, so an `after` failure must not unwind the pin.
 */
export const runCheckoutAfterHook = async (args: {
  hooks: Hooks | undefined;
  branch: HookBranch;
  env: HookEnv;
  git: GitContext;
  cwd: string;
}): Promise<void> => {
  const hook = args.hooks?.checkout?.after;
  if (!hook) return;
  await runAfter('checkout.after', () =>
    runHook(
      hook,
      { branch: args.branch, env: args.env, git: args.git },
      { cwd: args.cwd, env: hookEnvToProcessEnv(args.env), onOutput },
    ),
  );
};

/** Run the `deploy.after` hook (if any). Failures degrade to a warning (apply already ran). */
export const runDeployAfterHook = async (args: {
  hooks: Hooks | undefined;
  branch: HookBranch;
  env: HookEnv;
  result: PushResult;
  git: GitContext;
  cwd: string;
}): Promise<void> => {
  const hook = args.hooks?.deploy?.after;
  if (!hook) return;
  await runAfter('deploy.after', () =>
    runHook(
      hook,
      {
        branch: args.branch,
        env: args.env,
        result: args.result,
        git: args.git,
      },
      { cwd: args.cwd, env: hookEnvToProcessEnv(args.env), onOutput },
    ),
  );
};

const runAfter = async (
  label: string,
  run: () => Promise<unknown>,
): Promise<void> => {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warning(
      'The `%s` hook failed: %s\nThe branch change already succeeded; re-run the hook ' +
        'manually if needed.',
      label,
      message,
    );
  }
};

/**
 * Fetch the branch's resolved Neon env (DATABASE_URL, …) for an `after` hook, shaped into
 * {@link HookEnv}. Resolved in-memory regardless of `--env-pull`, so a migration hook always
 * has a connection string even when no `.env` is written. Returns `undefined` on failure so
 * the caller can skip the hook with a warning rather than crash.
 */
export const resolveHookEnv = async (args: {
  cwd: string;
  projectId: string;
  branchId: string;
  apiKey?: string;
  apiHost?: string;
  api?: NeonApi;
}): Promise<HookEnv | undefined> => {
  try {
    const vars = await resolveNeonEnvVars({
      cwd: args.cwd,
      projectId: args.projectId,
      branchId: args.branchId,
      env: { ...process.env },
      ...(args.apiKey ? { apiKey: args.apiKey } : {}),
      ...(args.apiHost ? { apiHost: args.apiHost } : {}),
      ...(args.api ? { api: args.api } : {}),
    });
    return buildHookEnv(vars);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warning('Could not resolve env for the after hook: %s', message);
    return undefined;
  }
};

/** OS-level var carrying the branch name. Literal (not via NEON_ENV_VAR_KEYS) so this stays
 * compatible across `@neondatabase/env` versions that predate the `branch` key group. */
const NEON_BRANCH_VAR = 'NEON_BRANCH';

/** Map the flat resolved Neon vars into the structured {@link HookEnv}. */
export const buildHookEnv = (vars: Record<string, string>): HookEnv => {
  const keys = NEON_ENV_VAR_KEYS;
  const env: HookEnv = {
    postgres: {
      databaseUrl: vars[keys.postgres.databaseUrl] ?? '',
      databaseUrlUnpooled: vars[keys.postgres.databaseUrlUnpooled] ?? '',
    },
  };
  const branchName = vars[NEON_BRANCH_VAR];
  if (branchName) env.branch = { name: branchName };
  return env;
};

/** Re-derive the OS-level env vars from a {@link HookEnv} for injection into shell hooks. */
const hookEnvToProcessEnv = (env: HookEnv): Record<string, string> => {
  const keys = NEON_ENV_VAR_KEYS;
  const out: Record<string, string> = {
    [keys.postgres.databaseUrl]: env.postgres.databaseUrl,
    [keys.postgres.databaseUrlUnpooled]: env.postgres.databaseUrlUnpooled,
  };
  if (env.branch?.name) out[NEON_BRANCH_VAR] = env.branch.name;
  return out;
};

/**
 * Build a {@link HookBranch} from the live branch metadata. `created` is supplied by the
 * caller (only the checkout/deploy flow knows whether this op created the branch).
 */
export const buildHookBranch = async (args: {
  apiClient: Api<unknown>;
  projectId: string;
  branchId: string;
  created: boolean;
}): Promise<HookBranch> => {
  const { data } = await args.apiClient.getProjectBranch(
    args.projectId,
    args.branchId,
  );
  const branch = data.branch;
  return {
    projectId: args.projectId,
    id: branch.id,
    name: branch.name,
    created: args.created,
    isDefault: branch.default ?? false,
    isProtected: branch.protected ?? false,
    ...(branch.parent_id ? { parentId: branch.parent_id } : {}),
    ...(branch.expires_at ? { expiresAt: branch.expires_at } : {}),
  };
};
