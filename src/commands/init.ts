import { execa } from 'execa';
import yargs from 'yargs';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import { sendError } from '../analytics.js';

export const command = 'init';
export const describe =
  'Initialize a new Neon project using your AI coding assistant';
export const builder = (yargs: yargs.Argv) =>
  yargs
    .option('context-file', {
      hidden: true,
    })
    .strict(false);

export const handler = async (
  args: CommonProps & {
    '--'?: string[];
  },
) => {
  const passThruArgs = args['--'] || [];
  await runNeonInit(passThruArgs);
};

const runNeonInit = async (args: string[]) => {
  try {
    await execa('npx', ['neon-init', ...args], {
      stdio: 'inherit',
    });
  } catch (error: any) {
    // Check if it's an ENOENT error (command not found)
    if (error?.code === 'ENOENT') {
      log.error('npx is not available in the PATH');
      sendError(error, 'NPX_NOT_FOUND');
      process.exit(1);
    }

    // Check if the process was killed by a signal (user cancelled)
    else if (error?.signal) {
      process.exit(1);
    }

    // Handle all other errors
    else {
      const exitError = new Error(`failed to run neon-init`);
      sendError(exitError, 'NEON_INIT_FAILED');
      if (typeof error?.exitCode === 'number') {
        process.exit(error.exitCode);
      } else {
        process.exit(1);
      }
    }
  }
};
