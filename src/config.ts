import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import yargs from 'yargs';

import { isCi } from './env.js';

export const CREDENTIALS_FILE = 'credentials.json';

export const defaultDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'neonctl',
);

export const ensureConfigDir = ({
  'config-dir': configDir,
  'force-auth': forceAuth,
}: yargs.Arguments<{ 'config-dir': string }>) => {
  if (!existsSync(configDir) && (!isCi() || forceAuth)) {
    mkdirSync(configDir, { recursive: true });
  }
};
