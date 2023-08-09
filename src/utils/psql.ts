import { log } from '../log.js';
import { spawn } from 'child_process';
import which from 'which';

export const psql = async (
  connection_uri: string,
  args: string[] = [],
) => {
  const psqlPathOrNull = await which('psql', { nothrow: true });

  if (psqlPathOrNull === null) {
    log.error(`psql is not available in the PATH`);
    process.exit(1);
  }

  log.info('Connecting to the database using psql...');
  const psql = spawn(psqlPathOrNull, [connection_uri, ...args], {
    stdio: 'inherit',
  });

  psql.on('exit', (code: number|null) => {
    process.exit(code === null ? 1 : code);
  });
};
