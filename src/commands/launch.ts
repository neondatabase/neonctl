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
import { closeAnalytics, sendError } from '../analytics.js';
import { ExitCode, isCliShutdownInFlight } from '../launch/errors.js';

const RECOGNIZED_FLAGS = new Set([
  'config',
  'branch',
  'branch-timeout',
  'branchTimeout',
  'output',
  // yargs-injected globals from src/index.ts (every global option + its
  // camelCase alias + the apiClient internal yargs hangs off argv):
  'api-host',
  'apiHost',
  'api-key',
  'apiKey',
  'apiClient',
  'project-id',
  'projectId',
  'org-id',
  'orgId',
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
export const describe =
  'Provision a Neon + Vercel + local-command stack from a neon.ts file (requires Node 22+)';

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
        'Per-poll-phase budget in seconds — applied independently to op polling and branch-ready polling (worst case ~2× this value)',
      default: 300,
    })
    .example('$0 launch', 'Run the stack defined in ./neon.ts')
    .example(
      '$0 launch --config infra/launch.ts',
      'Use a non-default config path',
    )
    .example(
      '$0 launch --preview --branch "${BRANCH_NAME}"',
      'CI preview deploy — branch flows into Neon branch name + Vercel preview scoping',
    )
    .epilogue(
      [
        'Unknown flags (e.g. `--preview`, `--prod`, or anything app-specific) are forwarded to your stack via `ctx.flags`.',
        'See https://github.com/neondatabase/neonctl/tree/main/examples/neon-launch-vercel for a `--preview`/`--prod` topology.',
      ].join('\n'),
    )
    .check((args) => {
      // `--output=json` is a global flag that callers expect to make the
      // command produce machine-readable JSON. The launcher's runtime is
      // streaming human logs from child processes (next dev, migrations,
      // vercel build), so JSON output is not coherent for `launch` in v1.
      // Reject explicitly rather than silently ignoring — a CI script
      // piping to `jq` should fail loudly.
      if (args.output === 'json') {
        throw new Error(
          '[neon launch] --output=json is not supported for `launch` (the command streams human logs from child processes). Drop the flag and parse stdout/stderr directly, or open an issue if you need structured output.',
        );
      }
      return true;
    })
    .strict(false);

type LaunchArgs = {
  config: string;
  branch?: string;
  'branch-timeout': number;
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
      argv: argv as Record<string, unknown>,
      recognizedFlags: RECOGNIZED_FLAGS,
    });
  } catch (err) {
    // If a SIGINT/SIGTERM handler is already mid-shutdown (kill children
    // + flush analytics + process.exit(signalCode)), the killed-sibling
    // rejection bubbles up here. Park instead of racing the handler with
    // our own closeAnalytics + exit — the handler owns the exit code.
    if (isCliShutdownInFlight()) {
      await new Promise<never>(() => undefined);
      return;
    }
    const error = err instanceof Error ? err : new Error(String(err));
    sendError(error, 'NEON_LAUNCH_FAILED');
    log.error(error.message);
    // Flush Segment's buffered events before exit — process.exit would
    // otherwise drop the most interesting error/failure analytics.
    await closeAnalytics();
    // LaunchError carries the right exit code (CONFIG_ERROR for plan-time,
    // AUTH_MISSING for missing tokens, etc.); other errors fall through to
    // RESOURCE_FAILED.
    const exitCode =
      (error as { exitCode?: number }).exitCode ?? ExitCode.RESOURCE_FAILED;
    process.exit(exitCode);
  }
};
