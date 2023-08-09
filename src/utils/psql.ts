import { log } from '../log.js';

export const psql = async (
  connection_uri: string,
  args: string[] = [],
) => {
  const { execSync, spawn } = await import('child_process');

  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    execSync(`${which} psql`, { stdio: 'ignore' });
  } catch (error) {
    log.error(`psql is not available in the PATH`);
    process.exit(1);
  }

  const psql = spawn('psql', [connection_uri, ...args], {
    stdio: 'inherit',
  });

  psql.on('exit', (code) => {
    process.exit(code === null ? 1 : code);
  });
};

export const psqlArgs = (
  argv: string[]
) => {
    const doubleDashIndex = argv.indexOf('--');
    return doubleDashIndex === -1 ? [] : argv.slice(doubleDashIndex + 1);
}
