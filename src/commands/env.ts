import chalk from 'chalk';
import yargs from 'yargs';

import { type NeonApi } from '@neondatabase/config';
import { NEON_ENV_VAR_KEYS } from '@neondatabase/env';

import { existsSync } from 'node:fs';

import { log } from '../log.js';
import { BranchScopeProps } from '../types.js';
import { resolveNeonEnvVars } from '../dev/env.js';
import { mergeEnvFile, readEnvFile, resolveEnvFilePath } from '../env_file.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';

export type EnvPullProps = BranchScopeProps & {
  /** Target dotenv file. Defaults to an existing `.env`, else `.env.local`. */
  file?: string;
  /** Working directory to resolve neon.ts / write the .env file in. Defaults to cwd (tests). */
  cwd?: string;
  /** Injected NeonApi adapter (tests). Production builds it from credentials. */
  runtimeApi?: NeonApi;
};

export const command = 'env';
export const describe = "Manage a branch's Neon env variables locally";

/**
 * Shown (to stderr) when `link` / `checkout` skip the bundled env pull because the user passed
 * `--no-env-pull`. Names the two ways to get the branch's vars without an on-disk file written
 * eagerly: an explicit `neonctl env pull`, or runtime injection via `neon-env run`.
 */
export const ENV_PULL_SKIPPED_HINT =
  'Skipped env pull (--no-env-pull). Run `neonctl env pull` to write this branch’s env vars ' +
  '(DATABASE_URL, …) into a local .env, or inject them at runtime with `neon-env run -- <your dev command>`.';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 env <sub-command> [options]')
    .options({
      'project-id': { describe: 'Project ID', type: 'string' },
      branch: { describe: 'Branch ID or name', type: 'string' },
    })
    .middleware(fillSingleProject as any)
    .command(
      'pull',
      "Write the branch's Neon env variables to a local .env file",
      (yargs) =>
        yargs
          .usage('$0 env pull [options]')
          .options({
            file: {
              describe:
                'Target .env file to write. Defaults to an existing .env, ' +
                'otherwise .env.local. Only Neon variables are updated; other ' +
                'lines are preserved.',
              type: 'string',
            },
          })
          .example(
            '$0 env pull',
            "Write the linked branch's Neon vars into .env.local (or .env if present)",
          )
          .example(
            '$0 env pull --branch preview --file .env.preview',
            'Pull a specific branch into a specific file',
          ),
      async (args) => {
        await pull(args as any);
      },
    )
    .demandCommand(1);

export const handler = (args: yargs.Argv) => args;

/** Every OS-level env var name `@neondatabase/env` can emit, used only for reporting. */
const NEON_VAR_NAMES = Object.values(NEON_ENV_VAR_KEYS).flatMap((group) =>
  Object.values(group),
);

/**
 * What an env pull actually did, so callers (notably `link --agent`) can report it precisely
 * instead of guessing. `written` lists the keys merged into `file`; `empty` means the branch
 * has no Neon vars to pull yet (no DATABASE_URL / Auth / Data API).
 */
export type PullOutcome =
  | { status: 'written'; written: string[]; file: string }
  | { status: 'empty' };

export const pull = async (props: EnvPullProps): Promise<PullOutcome> => {
  const cwd = props.cwd ?? process.cwd();
  const branchId = await branchIdFromProps(props);

  // Resolve the target file first and layer its current contents under the resolver's env
  // source. This lets `fetchEnv` reuse one-time secrets that are already on disk — Neon Auth
  // keys and the unified branch credential's `api_token` / `s3_secret_access_key`, which the
  // API returns exactly once — instead of minting a fresh credential on every pull.
  const targetPath = resolveEnvFilePath(cwd, props.file);
  const existingEnv = existsSync(targetPath) ? readEnvFile(targetPath) : {};

  // Reuse `neon dev`'s tiered resolver (neon.ts policy -> plan gate -> fetchEnv, else
  // pullConfig -> fetchEnv). Unlike dev, an unresolved context or failure is surfaced —
  // `env pull` is an explicit action, so it should error rather than write nothing.
  const vars = await resolveNeonEnvVars({
    cwd,
    projectId: props.projectId,
    branchId,
    env: { ...process.env, ...existingEnv },
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.runtimeApi ? { api: props.runtimeApi } : {}),
  });

  const neonVars = pickNeonVars(vars);
  if (Object.keys(neonVars).length === 0) {
    log.info(
      'No Neon env variables to pull for this branch (no DATABASE_URL or ' +
        'enabled Auth / Data API).',
    );
    return { status: 'empty' };
  }

  const { written } = mergeEnvFile(targetPath, neonVars);
  log.info(
    'Pulled %d Neon variable%s into %s: %s',
    written.length,
    written.length === 1 ? '' : 's',
    targetPath,
    written.join(', '),
  );
  return { status: 'written', written, file: targetPath };
};

/**
 * Outcome of the env pull that `link` / `checkout` run automatically once a branch is pinned.
 * Adds the two non-`pull` cases: the user opted out (`--no-env-pull`), or the pull failed (and
 * was degraded to a warning so the pin still stands).
 */
export type AutoPullResult =
  | PullOutcome
  | { status: 'skipped' }
  | { status: 'failed'; message: string };

/**
 * Pull a freshly-pinned branch's Neon env vars into a local `.env`, bundled into `link` and
 * `checkout` so the branch-first loop is just *link + checkout* — `env pull` runs for you.
 *
 * On by default; `--no-env-pull` opts out (e.g. when env is injected at runtime via
 * `neon-env run` / `neon dev`, or to keep secrets out of the working tree). The pin is the
 * command's primary effect and has already succeeded by the time this runs, so a pull failure
 * degrades to a warning rather than failing the command. Returns what happened so
 * `link --agent` can fold an accurate note into its JSON message.
 */
export const autoPullEnvAfterPin = async (
  props: EnvPullProps & { envPull: boolean },
): Promise<AutoPullResult> => {
  if (!props.envPull) {
    log.info(chalk.dim(ENV_PULL_SKIPPED_HINT));
    return { status: 'skipped' };
  }
  try {
    return await pull(props);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warning(
      'Branch pinned, but pulling its Neon env vars failed: %s\n' +
        'Run `neonctl env pull` once resolved (e.g. `neonctl deploy` if a declared service ' +
        'is missing), or inject them at runtime with `neon-env run -- <your dev command>`.',
      message,
    );
    return { status: 'failed', message };
  }
};

/**
 * Render the one-line env-pull note appended to `link --agent`'s JSON `message`, so an agent
 * reading the structured output knows whether its branch env is already on disk.
 */
export const renderAgentPullNote = (result: AutoPullResult): string => {
  switch (result.status) {
    case 'written':
      return ` Pulled ${result.written.length} Neon env var${
        result.written.length === 1 ? '' : 's'
      } into ${result.file}.`;
    case 'empty':
      return ' No Neon env vars to pull for this branch yet.';
    case 'skipped':
      return (
        ' Skipped env pull (--no-env-pull); run `neonctl env pull` later, ' +
        'or inject env at runtime with `neon-env run -- <your dev command>`.'
      );
    case 'failed':
      return ` Could not pull env vars (${result.message}); run \`neonctl env pull\` once resolved.`;
  }
};

/**
 * Keep only the recognized Neon variables from the resolved set, so a stray inherited
 * value never lands in the user's `.env` file. (Today `resolveNeonEnvVars` only emits Neon
 * vars, but filtering keeps the contract explicit and future-proof.)
 */
const pickNeonVars = (vars: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of NEON_VAR_NAMES) {
    const value = vars[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
};
