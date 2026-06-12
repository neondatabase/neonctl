import { interactiveInit, orchestrate } from 'neon-init';
import yargs from 'yargs';
import { sendError } from '../analytics.js';
import { log } from '../log.js';

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
    .option('preview', {
      type: 'boolean',
      default: false,
      describe:
        'Enable preview features (e.g. project bootstrapping from templates).',
    })
    .strict(false);

export const handler = async (argv: {
  agent?: string;
  skipNeonAuth?: boolean;
  skipMigrations?: boolean;
  preview?: boolean;
}) => {
  try {
    if (argv.agent !== undefined) {
      const result = await orchestrate({
        agent: argv.agent || undefined,
        skipNeonAuth: argv.skipNeonAuth,
        skipMigrations: argv.skipMigrations,
        preview: argv.preview,
      });
      log.info(JSON.stringify(result, null, 2));
    } else {
      await interactiveInit({ preview: argv.preview });
    }
  } catch {
    const exitError = new Error(`failed to run neon-init`);
    sendError(exitError, 'NEON_INIT_FAILED');
    process.exit(1);
  }
};
