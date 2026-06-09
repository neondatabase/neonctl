import yargs from 'yargs';

import { type NeonApi } from '@neondatabase/config';
import { NEON_ENV_VAR_KEYS } from '@neondatabase/env';

import { log } from '../log.js';
import { BranchScopeProps } from '../types.js';
import { resolveNeonEnvVars } from '../dev/env.js';
import { mergeEnvFile, resolveEnvFilePath } from '../env_file.js';
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
 * The canonical "what to do next" after a branch is pinned (`checkout` / `link`): pull its
 * Neon env vars into a local `.env`. Shared so the hint reads identically across commands
 * (and the `link --agent` JSON message), and updates in one place.
 */
export const ENV_PULL_NEXT_STEP =
  'Next: run `neonctl env pull` to write this branch’s env vars (DATABASE_URL, …) into a local .env';
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
      (args) => pull(args as any),
    )
    .demandCommand(1);

export const handler = (args: yargs.Argv) => args;

/** Every OS-level env var name `@neondatabase/env` can emit, used only for reporting. */
const NEON_VAR_NAMES = Object.values(NEON_ENV_VAR_KEYS).flatMap((group) =>
  Object.values(group),
);

export const pull = async (props: EnvPullProps): Promise<void> => {
  const cwd = props.cwd ?? process.cwd();
  const branchId = await branchIdFromProps(props);

  // Reuse `neon dev`'s tiered resolver (neon.ts policy -> plan gate -> fetchEnv, else
  // pullConfig -> fetchEnv). Unlike dev, an unresolved context or failure is surfaced —
  // `env pull` is an explicit action, so it should error rather than write nothing.
  const vars = await resolveNeonEnvVars({
    cwd,
    projectId: props.projectId,
    branchId,
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.runtimeApi ? { api: props.runtimeApi } : {}),
  });

  const neonVars = pickNeonVars(vars);
  if (Object.keys(neonVars).length === 0) {
    log.info(
      'No Neon env variables to pull for this branch (no DATABASE_URL or ' +
        'enabled Auth / Data API).',
    );
    return;
  }

  const targetPath = resolveEnvFilePath(cwd, props.file);
  const { written } = mergeEnvFile(targetPath, neonVars);
  log.info(
    'Pulled %d Neon variable%s into %s: %s',
    written.length,
    written.length === 1 ? '' : 's',
    targetPath,
    written.join(', '),
  );
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
