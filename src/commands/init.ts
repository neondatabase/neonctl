import { init, orchestrate } from 'neon-init';
import type { OrchestratorOptions } from 'neon-init';
import yargs from 'yargs';
import { sendError } from '../analytics.js';

export const command = 'init';
export const describe =
  'Initialize a project with Neon using your AI coding assistant';
export const builder = (yargs: yargs.Argv) =>
  yargs
    .option('context-file', {
      hidden: true,
    })
    .option('agent', {
      alias: 'a',
      type: 'string',
      describe: 'Agent to configure (cursor, copilot, claude, etc.).',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      describe:
        'Output structured JSON for agent consumption. Suppresses interactive UI.',
    })
    .option('skip-neon-auth', {
      type: 'boolean',
      default: false,
      describe: 'Skip the Neon Auth setup phase.',
    })
    .option('skip-migrations', {
      type: 'boolean',
      default: false,
      describe: 'Skip the migrations phase.',
    })
    .strict(false);

export const handler = async (argv: {
  agent?: string;
  json?: boolean;
  skipNeonAuth?: boolean;
  skipMigrations?: boolean;
}) => {
  const agentArg = argv.agent;
  const jsonMode = argv.json === true || agentArg !== undefined;

  if (jsonMode) {
    // v2: agent-driven state machine via orchestrate()
    try {
      const options: OrchestratorOptions = {
        agent: agentArg,
        skipNeonAuth: argv.skipNeonAuth,
        skipMigrations: argv.skipMigrations,
      };
      const result = await orchestrate(options);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch {
      const exitError = new Error('failed to run neon-init orchestrate');
      sendError(exitError, 'NEON_INIT_FAILED');
      process.exit(1);
    }
    return;
  }

  // v1: interactive mode (agentArg is always undefined here since --agent triggers jsonMode)
  try {
    await init();
  } catch {
    const exitError = new Error(`failed to run neon-init`);
    sendError(exitError, 'NEON_INIT_FAILED');
    process.exit(1);
  }
};
