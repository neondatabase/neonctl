import yargs from 'yargs';
import chalk from 'chalk';
import { resolveConfig } from '@neondatabase/config';
import {
  apply,
  createBranch as createBranchFromPolicy,
  inspect,
  loadConfigFromFile,
  plan,
  type Config,
  type ConflictReport,
  type FunctionBundler,
  type NeonApi,
  type PushResult,
} from '@neondatabase/config-runtime';
import { toNeonConfigView } from '../config_format.js';

import { log } from '../log.js';
import { isCi } from '../env.js';
import { BranchScopeProps } from '../types.js';
import { loadEnvFileIntoProcess } from '../env_file.js';
import { fillSingleProject, resolveBranchRef } from '../utils/enrichers.js';
import { announceTargetBranch } from '../utils/branch_notice.js';
import { bundleEntry } from '../utils/esbuild.js';
import { zipBundle } from '../utils/zip.js';
import { writer } from '../writer.js';
import { autoPullEnvAfterPin } from './env.js';

/**
 * Bundle a function with neonctl's OWN bundler (the shared esbuild helper) so the
 * config-runtime never has to import esbuild itself. Injecting this keeps esbuild
 * out of config-runtime's static module graph — and therefore out of the packaged
 * neonctl snapshot, which resolves esbuild dynamically at deploy time.
 */
const neonctlBundler: FunctionBundler = async (fn) =>
  zipBundle(await bundleEntry(fn.source));

const INSPECT_FIELDS = ['project', 'branch', 'config'] as const;
// Deliberately minimal: action/kind/identifier are short and fixed-ish, so the table can
// never overflow. Per-change `details` (a function's long invocationUrl in particular) are
// intentionally NOT a column — they used to be JSON-stringified into a cell and blew the
// table past 190 cols. Function URLs are printed below as a plain list (see reportPushResult),
// and the full details are still available via `--output json`.
const APPLIED_FIELDS = ['action', 'kind', 'identifier'] as const;
const CONFLICT_FIELDS = [
  'identifier',
  'field',
  'current',
  'desired',
  'reason',
] as const;

export type ConfigProps = BranchScopeProps & {
  /** Explicit path to a neon.ts policy. When omitted, loadConfigFromFile walks up from cwd. */
  config?: string;
  /**
   * Optional path to a `.env` file loaded into `process.env` **before** the `neon.ts`
   * policy is evaluated, so function `env` values that read `process.env.X` pick up the
   * right per-environment values without juggling shells. Existing `process.env` entries
   * win over the file.
   */
  env?: string;
  /** Auto-confirm overriding existing remote settings (apply only). */
  updateExisting?: boolean;
  /** Auto-confirm applying to a protected branch (apply only). */
  allowProtected?: boolean;
  /** `status` only: print just the neon.ts-shaped config JSON to stdout. */
  configJson?: boolean;
  /**
   * After a successful `config apply` / `deploy`, pull the branch's Neon env vars into a
   * local `.env` (DATABASE_URL, AI Gateway, object storage, …) — the same convenience as
   * `link` / `checkout`. On by default; `--no-env-pull` sets this `false`.
   */
  envPull?: boolean;
  /**
   * Working directory used to resolve `neon.ts` and write the `.env` during the bundled env
   * pull. Defaults to `process.cwd()`; set by tests to redirect the write to a temp dir.
   */
  cwd?: string;
  /** Injected NeonApi adapter (tests). Production omits it so the real adapter is built from credentials. */
  runtimeApi?: NeonApi;
};

/**
 * Shared `--env` flag for `config plan|apply` and `deploy`. Loads a `.env` into
 * `process.env` before the policy is evaluated.
 */
export const envFlag = {
  env: {
    describe:
      'Path to a .env file to load into the environment before evaluating neon.ts ' +
      '(so function env values resolve from it). Existing env vars are not overridden.',
    type: 'string',
  },
} as const;

/** Apply-only flags, exported so `deploy` can reuse the exact same surface. */
export const applyFlags = {
  'update-existing': {
    describe: 'Auto-confirm overriding existing remote settings on the branch',
    type: 'boolean',
    default: false,
  },
  'allow-protected': {
    describe: 'Auto-confirm applying to a branch marked protected on Neon',
    type: 'boolean',
    default: false,
  },
} as const;

/**
 * `--env-pull` for `config apply` / `deploy` (shared so both expose the identical surface).
 * After a successful apply, the branch's Neon env vars are written to a local `.env` — the
 * same bundled convenience as `link` / `checkout`. On by default; `--no-env-pull` opts out.
 */
export const envPullFlag = {
  'env-pull': {
    describe:
      "Pull the branch's Neon env vars (DATABASE_URL, …) into a local .env after a " +
      'successful apply. On by default; use --no-env-pull to skip (e.g. when injecting ' +
      'env at runtime with `neon-env run` / `neon dev`).',
    type: 'boolean',
    default: true,
  },
} as const;

export const command = 'config';
export const describe = 'Manage a branch with a neon.ts policy';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 config <sub-command> [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'status',
      "Show the branch's live Neon state",
      (yargs) =>
        yargs.options({
          'config-json': {
            describe:
              "Print only the branch's live config as neon.ts-shaped JSON " +
              '(services + branch tuning + preview), to stdout. Useful for ' +
              'scripting or copying into a neon.ts.',
            type: 'boolean',
            default: false,
          },
        }),
      (args) => status(args as any),
    )
    .command(
      'plan',
      'Show what `config apply` would change (dry run)',
      (yargs) =>
        yargs.options({
          config: {
            describe:
              'Path to a neon.ts policy (defaults to walking up from cwd)',
            type: 'string',
          },
          ...envFlag,
        }),
      (args) => planCmd(args as any),
    )
    .command(
      'apply',
      'Apply a neon.ts policy to the branch',
      (yargs) =>
        yargs.options({
          config: {
            describe:
              'Path to a neon.ts policy (defaults to walking up from cwd)',
            type: 'string',
          },
          ...envFlag,
          ...applyFlags,
          ...envPullFlag,
        }),
      (args) => applyCmd(args as any),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

const loadConfig = async (props: ConfigProps): Promise<Config> => {
  // Load the optional --env file FIRST so a `neon.ts` whose function `env` values read
  // `process.env.X` sees them. Must happen before the policy module is imported/evaluated.
  if (props.env) {
    const applied = loadEnvFileIntoProcess(props.env);
    log.debug(
      'Loaded %d var(s) from %s into the environment: %s',
      applied.length,
      props.env,
      applied.join(', '),
    );
  }
  const { config } = await loadConfigFromFile({
    ...(props.config ? { path: props.config } : {}),
  });
  return config;
};

export const status = async (props: ConfigProps): Promise<void> => {
  const branch = await resolveBranchRef(props);
  // `--config-json` is a script-friendly mode that emits only JSON to stdout, so keep it
  // pristine; the regular human view gets the "which branch am I inspecting" guardrail.
  if (!props.configJson) {
    announceTargetBranch(props, branch, 'Inspecting branch');
  }
  const branchId = branch.branchId;
  const live = await inspect({
    projectId: props.projectId,
    branchId,
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.apiHost ? { apiHost: props.apiHost } : {}),
    ...(props.runtimeApi ? { api: props.runtimeApi } : {}),
  });

  // The pulled `config` carries the branch's tuning inside a closure that JSON can't
  // render. Resolve it against the live branch target to get the concrete settings, then
  // project both that and the separately-pulled preview state into a neon.ts-shaped view.
  const resolved = resolveConfig(live.config, {
    name: live.branch.name,
    id: live.branch.id,
    exists: true,
    isDefault: live.branch.isDefault,
    isProtected: live.branch.protected,
    ...(live.branch.parent ? { parentId: live.branch.parent } : {}),
    ...(live.branch.expiresAt ? { expiresAt: live.branch.expiresAt } : {}),
  });
  const configView = toNeonConfigView(resolved, live.preview);

  // `--config-json`: emit just the neon.ts-shaped config to stdout (script-friendly,
  // copy-paste-able), regardless of the global --output.
  if (props.configJson) {
    process.stdout.write(`${JSON.stringify(configView, null, 2)}\n`);
    return;
  }

  // Default: the live project/branch tables, but with the unhelpful raw `config` replaced
  // by the resolved neon.ts-shaped view so the user sees enabled infra + branch tuning.
  writer(props).end(
    { project: live.project, branch: live.branch, config: configView },
    { fields: INSPECT_FIELDS },
  );
};

export const planCmd = async (props: ConfigProps): Promise<void> => {
  const config = await loadConfig(props);
  const branch = await resolveBranchRef(props);
  announceTargetBranch(props, branch, 'Planning against branch');
  const branchId = branch.branchId;
  // `plan` is a dry run that never bundles, so its options don't accept (or need)
  // an injected bundler — only `apply` does (it uses neonctlBundler).
  const result = await plan(config, {
    projectId: props.projectId,
    branchId,
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.apiHost ? { apiHost: props.apiHost } : {}),
    ...(props.runtimeApi ? { api: props.runtimeApi } : {}),
  });
  reportPushResult(props, result, 'plan', utilizedServices(config));
};

export const applyCmd = async (props: ConfigProps): Promise<void> => {
  const config = await loadConfig(props);
  const branch = await resolveBranchRef(props);
  announceTargetBranch(props, branch, 'Applying to branch');
  const branchId = branch.branchId;
  const result = await apply(config, {
    projectId: props.projectId,
    branchId,
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.apiHost ? { apiHost: props.apiHost } : {}),
    ...(props.runtimeApi ? { api: props.runtimeApi } : {}),
    ...(props.updateExisting ? { updateExisting: true } : {}),
    ...(props.allowProtected ? { allowProtectedBranch: true } : {}),
    bundleFunction: neonctlBundler,
  });
  reportPushResult(props, result, 'apply', utilizedServices(config));

  // After a successful apply/deploy, write the branch's Neon env vars to a local .env —
  // the same bundled convenience as `link` / `checkout`, so the branch is immediately
  // usable for local dev. `--no-env-pull` opts out; a pull failure degrades to a warning
  // (the apply already succeeded). See autoPullEnvAfterPin.
  await autoPullEnvAfterPin({ ...props, envPull: props.envPull !== false });
};

type ReportMode = 'plan' | 'apply';

/**
 * A static service toggle (`auth` / `dataApi` / `preview.aiGateway`) is "on" unless
 * explicitly disabled: `true` / `{}` / `{ enabled: true }` enable it; `false` /
 * `{ enabled: false }` / absent leave it off. Mirrors the runtime's `isServiceEnabled`
 * (which isn't exported), kept tiny and pure so it can be read straight off the policy.
 */
const isToggleEnabled = (
  toggle: boolean | { enabled?: boolean } | undefined,
): boolean => {
  if (toggle === undefined) return false;
  if (typeof toggle === 'boolean') return toggle;
  return toggle.enabled !== false;
};

/**
 * Human-readable list of the services a `neon.ts` policy utilizes on the branch, shown under
 * the plan/apply table. Postgres is always present (every branch has it); the rest are listed
 * only when the policy declares them. This deliberately surfaces services that produce **no**
 * plan step — notably the AI Gateway, which is always available and only needs a scoped branch
 * credential (not a provisioning step) — so adding `preview.aiGateway` to a neon.ts isn't
 * mistaken for being silently dropped. Service enablement is static top-level config (it never
 * lives in the per-branch closure), so reading it straight off `config` is accurate.
 */
const utilizedServices = (config: Config): string[] => {
  const services = ['Postgres'];
  if (isToggleEnabled(config.auth)) services.push('Neon Auth');
  if (isToggleEnabled(config.dataApi)) services.push('Data API');
  if (Object.keys(config.preview?.buckets ?? {}).length > 0) {
    services.push('Object Storage');
  }
  if (Object.keys(config.preview?.functions ?? {}).length > 0) {
    services.push('Functions');
  }
  if (isToggleEnabled(config.preview?.aiGateway)) services.push('AI Gateway');
  return services;
};

/**
 * Render a {@link PushResult}. JSON/YAML output emits the raw result (plus a `services`
 * summary) verbatim so it can be piped; the human-readable path renders the actual changes
 * (dropping noops) and any blocking conflicts as tables, or a "nothing to do" line when both
 * are empty — and always closes with the list of services the policy utilizes so a service
 * that produces no plan step (Postgres, or the credential-gated AI Gateway) isn't mistaken
 * for being missing from the plan above.
 */
const reportPushResult = (
  props: ConfigProps,
  result: PushResult,
  mode: ReportMode,
  services: string[],
): void => {
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end({ ...result, services }, { fields: [] });
    return;
  }

  const changes = result.applied
    .filter((change) => change.action !== 'noop')
    .map((change) => ({
      action: change.action,
      kind: change.kind,
      identifier: change.identifier,
    }));
  const conflicts = result.conflicts.map((conflict: ConflictReport) => ({
    identifier: conflict.identifier,
    field: conflict.field,
    current: stringify(conflict.current),
    desired: stringify(conflict.desired),
    reason: conflict.reason,
  }));

  // Deployed functions carry their invocation URL in the change details — collect them so
  // we can list where to call each function without digging through the raw details blob.
  // Keyed by slug so a function never shows twice.
  const functionUrlBySlug = new Map<string, string>();
  for (const change of result.applied) {
    if (change.action === 'noop') continue;
    const slug = change.details?.slug;
    const invocationUrl = change.details?.invocationUrl;
    if (typeof slug === 'string' && typeof invocationUrl === 'string') {
      functionUrlBySlug.set(slug, invocationUrl);
    }
  }

  const out = writer(props);
  const noChanges = changes.length === 0 && conflicts.length === 0;
  if (changes.length > 0) {
    out.write(changes, {
      fields: APPLIED_FIELDS,
      title: mode === 'plan' ? 'Planned changes' : 'Applied changes',
    });
  }
  if (conflicts.length > 0) {
    out.write(conflicts, { fields: CONFLICT_FIELDS, title: 'Conflicts' });
  }
  // Flush any tables, then append the lists/summary so they read directly below them.
  out.end();

  // Function URLs are a plain list rather than a table: an invocation URL can be 70+ chars,
  // which makes any bordered table overflow and wrap awkwardly in a normal terminal. A list
  // lets each URL reflow on its own line, and stays copy-pasteable.
  if (functionUrlBySlug.size > 0) {
    const heading =
      mode === 'plan' ? 'Function URLs (after apply)' : 'Function URLs';
    out.text(`\n${isCi() ? heading : chalk.bold(heading)}\n`);
    for (const [slug, invocationUrl] of functionUrlBySlug) {
      out.text(`  • ${slug}: ${invocationUrl}\n`);
    }
  }

  if (noChanges) {
    log.info(
      `No changes — branch ${result.branchName} already matches the policy.`,
    );
  }
  out.text(`\nUtilized services: ${services.join(', ')}\n`);

  if (conflicts.length > 0) {
    log.info(
      'Resolve the conflicts above, or re-run with --update-existing to override the current remote settings.',
    );
  }
};

const stringify = (value: unknown): string =>
  value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

/**
 * Apply a `neon.ts` policy to a **freshly created** branch (used by `neonctl checkout`
 * when it creates a branch). No-op when there is no `neon.ts` on the path from cwd up to
 * the repo root — checkout still succeeds, it just has no policy to apply.
 *
 * The branch was just created by us, so we apply non-interactively (`updateExisting` /
 * `allowProtectedBranch`) — there is no pre-existing state a user would be surprised to
 * see overridden. Functions are bundled with neonctl's own esbuild helper.
 */
export const applyPolicyOnCreate = async (props: {
  projectId: string;
  branchId: string;
  apiKey?: string;
  apiHost?: string;
  runtimeApi?: NeonApi;
  /** Directory to search for `neon.ts` from. Defaults to the process cwd. */
  cwd?: string;
}): Promise<void> => {
  let config: Config;
  try {
    ({ config } = await loadConfigFromFile({
      ...(props.cwd ? { cwd: props.cwd } : {}),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not find a Neon config file/i.test(message)) return;
    throw err;
  }

  log.info('Applying neon.ts policy to the new branch…');
  const result = await apply(config, {
    projectId: props.projectId,
    branchId: props.branchId,
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.apiHost ? { apiHost: props.apiHost } : {}),
    ...(props.runtimeApi ? { api: props.runtimeApi } : {}),
    updateExisting: true,
    allowProtectedBranch: true,
    bundleFunction: neonctlBundler,
  });
  logPolicyResult(result);
};

/** Log a one-line summary of what applying a `neon.ts` policy changed (or that nothing did). */
const logPolicyResult = (result: PushResult): void => {
  const changes = result.applied.filter((c) => c.action !== 'noop');
  if (changes.length === 0) {
    log.info('neon.ts applied — no changes were needed.');
    return;
  }
  log.info(
    'neon.ts applied — %d change%s: %s',
    changes.length,
    changes.length === 1 ? '' : 's',
    changes.map((c) => `${c.action} ${c.identifier}`).join(', '),
  );
};

/**
 * Create a branch **from** the local `neon.ts` policy. Returns `null` when there is no
 * `neon.ts` on the path from cwd up to the repo root, so `neonctl checkout` can fall back to a
 * bare branch create.
 *
 * Unlike a bare create followed by {@link applyPolicyOnCreate}, this evaluates the policy for
 * the **new** branch (`exists: false`): the runtime branches from the policy's `parent` and
 * brings the branch up with its declared TTL / compute settings / services. That's what makes
 * a policy keyed on `!branch.exists` (the common "only configure new branches" shape) take
 * effect on the very first `checkout` — a bare create + `apply` always saw `exists: true` and
 * skipped that block.
 */
export const createBranchFromPolicyOnCheckout = async (props: {
  projectId: string;
  branchName: string;
  apiKey?: string;
  apiHost?: string;
  runtimeApi?: NeonApi;
  /** Directory to search for `neon.ts` from. Defaults to the process cwd. */
  cwd?: string;
}): Promise<{ branchId: string } | null> => {
  let config: Config;
  try {
    ({ config } = await loadConfigFromFile({
      ...(props.cwd ? { cwd: props.cwd } : {}),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not find a Neon config file/i.test(message)) return null;
    throw err;
  }

  const { branchId, branchName, result } = await createBranchFromPolicy(
    config,
    {
      projectId: props.projectId,
      branchName: props.branchName,
      ...(props.apiKey ? { apiKey: props.apiKey } : {}),
      ...(props.apiHost ? { apiHost: props.apiHost } : {}),
      ...(props.runtimeApi ? { api: props.runtimeApi } : {}),
      bundleFunction: neonctlBundler,
    },
  );
  log.info('Created branch %s (%s) from neon.ts policy.', branchName, branchId);
  logPolicyResult(result);
  return { branchId };
};
