/**
 * `neon launch` — provision the stack exported from `neon.ts`.
 *
 * Yargs wires the recognized flags. Unknown flags fall through to
 * `ctx.flags` for the user's stack `spec` to read (`.strict(false)`).
 *
 * The actual launcher runtime lives in `src/launch/runner.ts`.
 * This file only handles the CLI surface + the Node 22 guard.
 */
import type yargs from 'yargs';

import { log } from '../log.js';
import { sendError } from '../analytics.js';

const RECOGNIZED_FLAGS = new Set([
  'config',
  'branch',
  'branch-timeout',
  'branchTimeout',
  'yes',
  'y',
  'output',
  // yargs-injected globals from src/index.ts (every global option + its
  // camelCase alias + the apiClient internal yargs hangs off argv):
  'api-host',
  'apiHost',
  'api-key',
  'apiKey',
  'apiClient',
  'config-dir',
  'configDir',
  'analytics',
  'force-auth',
  'forceAuth',
  'oauth-host',
  'oauthHost',
  'client-id',
  'clientId',
  'context-file',
  'contextFile',
  'color',
  'help',
  'h',
  'version',
  'v',
]);

export const command = 'launch';
export const describe = 'Launch the stack defined in your neon.ts';

export const builder = (argv: yargs.Argv) =>
  argv
    .option('config', {
      type: 'string',
      describe: 'Path to neon.ts (default: ./neon.ts)',
      default: './neon.ts',
    })
    .option('branch', {
      type: 'string',
      describe: 'Override the git branch passed in ctx (default: from git)',
    })
    .option('branch-timeout', {
      type: 'number',
      describe:
        'Per-branch poll budget in seconds when waiting for Neon create ops',
      default: 300,
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      describe: 'Accept interactive prompts non-interactively (CI)',
      default: false,
    })
    .strict(false);

type LaunchArgs = {
  config: string;
  branch?: string;
  'branch-timeout': number;
  yes: boolean;
  output?: string;
  [k: string]: unknown;
};

export const handler = async (argv: LaunchArgs): Promise<void> => {
  // Node 22+ guard. `jiti`, the runner, and several deps require Node 22.
  // Other neonctl commands keep advertising `>=18` (engines.node).
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 22) {
    log.error(
      `neon launch requires Node 22 or newer (current: ${process.versions.node}). ` +
        `The rest of neonctl continues to work on Node 18+; only this command requires the bump.`,
    );
    process.exit(1);
    return;
  }

  try {
    // Lazy-import the runner. Keeps Node-18 callers of OTHER neonctl
    // commands safe.
    const { runLaunch } = await import('../launch/runner.js');
    await runLaunch({
      configPath: argv.config,
      branchFlag: argv.branch,
      branchTimeoutSeconds: argv['branch-timeout'],
      yes: argv.yes,
      argv: argv as Record<string, unknown>,
      recognizedFlags: RECOGNIZED_FLAGS,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    sendError(error, 'NEON_LAUNCH_FAILED');
    log.error(error.message);
    // LaunchError carries the right exit code (CONFIG_ERROR for plan-time,
    // AUTH_MISSING for missing tokens, etc.); other errors fall through to
    // RESOURCE_FAILED. The SIGINT path exits 130 itself, never reaches here.
    const exitCode =
      (error as { exitCode?: number }).exitCode ?? /* RESOURCE_FAILED */ 1;
    process.exit(exitCode);
  }
};
