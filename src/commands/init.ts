import {
  detectAgent,
  enrichResponse,
  interactiveInit,
  orchestrate,
  routeDataStep,
} from 'neon-init';
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
      type: 'boolean',
      default: false,
      describe: 'Enable agent/JSON mode (agent type is auto-detected).',
    })
    .option('data', {
      type: 'string',
      describe:
        'JSON object with a "step" field to route to a specific phase and phase-specific options.',
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
  agent?: boolean;
  data?: string;
  skipMigrations?: boolean;
  preview?: boolean;
}) => {
  try {
    // Auto-detect agent from environment. For IDE-based detection (Cursor,
    // VS Code, Windsurf), require non-TTY stdin to distinguish "agent spawned
    // this" from "human typed this in terminal".
    const agent = (!process.stdin.isTTY ? detectAgent() : null) || undefined;
    const isAgentMode = argv.agent || false;

    // --data with a "step" field routes to the appropriate phase
    if (argv.data && isAgentMode) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(argv.data);
      } catch {
        log.error('Invalid JSON in --data flag. Expected a JSON object.');
        process.exit(1);
        return;
      }
      if (typeof data.step === 'string') {
        const result = await routeDataStep(data, agent);
        log.info(JSON.stringify(enrichResponse(result), null, 2));
        return;
      }
    }

    if (isAgentMode) {
      const result = await orchestrate({
        agent,
        skipMigrations: argv.skipMigrations,
        preview: argv.preview,
      });
      log.info(JSON.stringify(enrichResponse(result), null, 2));
    } else {
      await interactiveInit({ preview: argv.preview });
    }
  } catch {
    const exitError = new Error(`failed to run neon-init`);
    sendError(exitError, 'NEON_INIT_FAILED');
    process.exit(1);
  }
};
