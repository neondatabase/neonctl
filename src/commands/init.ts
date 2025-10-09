import { spawn } from 'child_process';
import yargs from 'yargs';
import which from 'which';
import { log } from '../log.js';
import { CommonProps } from '../types.js';

export const command = 'init';
export const describe = false; // Hidden command - neon-init is pre-release
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
    log.error(`npx is not available in the PATH`);
    process.exit(1);
  }

  const child = spawn(npxPathOrNull, ['neon-init', ...args], {
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
    process.exit(code === null ? 1 : code);
  });
};
