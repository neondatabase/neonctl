import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import yargs from 'yargs';

import { isCi } from './env.js';

export const defaultDir = join(
  homedir(),
  process.env.XDG_CONFIG_HOME || '.config',
  'neonctl'
);

export const ensureConfigDir = async ({
  'config-dir': configDir,
}: yargs.Arguments<{ 'config-dir': string }>) => {
  if (!existsSync(configDir) && !isCi()) {
    mkdirSync(configDir);
  }
};
