import { init } from 'neon-init';
import yargs from 'yargs';
import { sendError } from '../analytics.js';

export const command = 'init';
export const describe =
  'Initialize a new project with Neonusing your AI coding assistant';
export const builder = (yargs: yargs.Argv) =>
  yargs
    .option('context-file', {
      hidden: true,
    })
    .strict(false);

export const handler = async () => {
  try {
    await init();
  } catch {
    const exitError = new Error(`failed to run neon-init`);
    sendError(exitError, 'NEON_INIT_FAILED');
    process.exit(1);
  }
};
