import { spawn } from 'child_process';
import yargs from 'yargs';
import which from 'which';
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

const runNeonInit = async (args: string[] = []) => {
  const npxPathOrNull = await which('npx', { nothrow: true });

  if (npxPathOrNull === null) {
    const error = new Error('npx is not available in the PATH');
    log.error(error.message);
    sendError(error, 'NPX_NOT_FOUND');
    process.exit(1);
  }

  const isWindows = process.platform === 'win32';

  const child = isWindows
    ? spawn('cmd', ['/c', 'npx', 'neon-init', ...args], {
        stdio: 'inherit',
      })
    : spawn(npxPathOrNull, ['neon-init', ...args], {
        stdio: 'inherit',
      });

  for (const signame of ['SIGINT', 'SIGTERM']) {
    process.on(signame, (code) => {
      if (!child.killed && code !== null) {
        child.kill(code);
      }
    });
  }

  child.on('exit', (code: number | null) => {
    const exitCode = code === null ? 1 : code;

    if (exitCode !== 0 && code !== null) {
      const error = new Error(`neon-init exited with code ${exitCode}`);
      sendError(error, 'NEON_INIT_FAILED');
    }

    process.exit(exitCode);
  });
};
