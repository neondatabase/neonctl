import { Api } from '@neondatabase/api-client';
import type {
  GitContext,
  HookBranch,
  Hooks,
  NeonApi,
  NeonAiGatewayEnv,
  NeonAuthEnv,
  NeonDataApiEnv,
  NeonEnv,
  NeonStorageEnv,
  PushResult,
} from '@neondatabase/config';
import { loadConfigFromFile, runHook } from '@neondatabase/config-runtime';

import { resolveNeonEnvVars } from '../dev/env.js';
import { log } from '../log.js';

/**
 * OS-level env-var names a resolved Neon env can carry. Spelled out as literals (rather than
 * reaching into `@neondatabase/env`'s `NEON_ENV_VAR_KEYS`) so this stays robust across env
 * package versions — these names are a stable public contract.
 */
const ENV_VARS = {
  databaseUrl: 'DATABASE_URL',
  databaseUrlUnpooled: 'DATABASE_URL_UNPOOLED',
  branch: 'NEON_BRANCH',
  authBaseUrl: 'NEON_AUTH_BASE_URL',
  authJwksUrl: 'NEON_AUTH_JWKS_URL',
  dataApiUrl: 'NEON_DATA_API_URL',
  awsAccessKeyId: 'AWS_ACCESS_KEY_ID',
  awsSecretAccessKey: 'AWS_SECRET_ACCESS_KEY',
  awsEndpoint: 'AWS_ENDPOINT_URL_S3',
  awsRegion: 'AWS_REGION',
  openaiApiKey: 'OPENAI_API_KEY',
  openaiBaseUrl: 'OPENAI_BASE_URL',
} as const;

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
  env: NeonEnv;
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
  env: NeonEnv;
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
}): Promise<NeonEnv | undefined> => {
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

/**
 * A resolved Neon env with **all** optional namespaces spelled out. A structural superset of
 * the bare {@link NeonEnv} (so it's assignable wherever `NeonEnv<C>` is expected) that also
 * lets us read/populate the policy-dependent namespaces without casting. neonctl resolves a
 * general env (it doesn't have the literal policy type), populated to match whatever the
 * policy enabled — which is exactly the `NeonEnv<typeof config>` the hook author's `env` is.
 */
export type ResolvedHookEnv = NeonEnv & {
  auth?: NeonAuthEnv;
  dataApi?: NeonDataApiEnv;
  storage?: NeonStorageEnv;
  aiGateway?: NeonAiGatewayEnv;
};

/**
 * Map the flat resolved Neon vars into a structured {@link ResolvedHookEnv}. Populates
 * **every** namespace whose vars are present (auth / dataApi / storage / aiGateway), not just
 * postgres — so the runtime value matches the `NeonEnv<typeof config>` a hook author's `env`
 * is typed as. `resolveNeonEnvVars` only emits a namespace's vars when the policy enables it,
 * so the presence here lines up with the policy's static toggles.
 */
export const buildHookEnv = (vars: Record<string, string>): ResolvedHookEnv => {
  const env: ResolvedHookEnv = {
    postgres: {
      databaseUrl: vars[ENV_VARS.databaseUrl] ?? '',
      databaseUrlUnpooled: vars[ENV_VARS.databaseUrlUnpooled] ?? '',
    },
  };

  const branchName = vars[ENV_VARS.branch];
  if (branchName) env.branch = { name: branchName };

  const authBaseUrl = vars[ENV_VARS.authBaseUrl];
  const authJwksUrl = vars[ENV_VARS.authJwksUrl];
  if (authBaseUrl && authJwksUrl) {
    env.auth = { baseUrl: authBaseUrl, jwksUrl: authJwksUrl };
  }

  const dataApiUrl = vars[ENV_VARS.dataApiUrl];
  if (dataApiUrl) env.dataApi = { url: dataApiUrl };

  const accessKeyId = vars[ENV_VARS.awsAccessKeyId];
  const secretAccessKey = vars[ENV_VARS.awsSecretAccessKey];
  if (accessKeyId && secretAccessKey) {
    env.storage = {
      accessKeyId,
      secretAccessKey,
      endpoint: vars[ENV_VARS.awsEndpoint] ?? '',
      region: vars[ENV_VARS.awsRegion] ?? '',
      // Neon's object storage always uses path-style addressing today.
      forcePathStyle: true,
    };
  }

  const aiApiKey = vars[ENV_VARS.openaiApiKey];
  const aiBaseUrl = vars[ENV_VARS.openaiBaseUrl];
  if (aiApiKey && aiBaseUrl) {
    env.aiGateway = { apiKey: aiApiKey, baseUrl: aiBaseUrl };
  }

  return env;
};

/** Re-derive the OS-level env vars from a {@link ResolvedHookEnv} for shell-hook injection. */
const hookEnvToProcessEnv = (env: ResolvedHookEnv): Record<string, string> => {
  const out: Record<string, string> = {
    [ENV_VARS.databaseUrl]: env.postgres.databaseUrl,
    [ENV_VARS.databaseUrlUnpooled]: env.postgres.databaseUrlUnpooled,
  };
  if (env.branch?.name) out[ENV_VARS.branch] = env.branch.name;
  if (env.auth) {
    out[ENV_VARS.authBaseUrl] = env.auth.baseUrl;
    out[ENV_VARS.authJwksUrl] = env.auth.jwksUrl;
  }
  if (env.dataApi) out[ENV_VARS.dataApiUrl] = env.dataApi.url;
  if (env.storage) {
    out[ENV_VARS.awsAccessKeyId] = env.storage.accessKeyId;
    out[ENV_VARS.awsSecretAccessKey] = env.storage.secretAccessKey;
    out[ENV_VARS.awsEndpoint] = env.storage.endpoint;
    out[ENV_VARS.awsRegion] = env.storage.region;
  }
  if (env.aiGateway) {
    out[ENV_VARS.openaiApiKey] = env.aiGateway.apiKey;
    out[ENV_VARS.openaiBaseUrl] = env.aiGateway.baseUrl;
  }
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
