import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { Arguments } from 'yargs';

const DIR_NAME = '.neonctl';

const cwdDir = join(process.cwd(), DIR_NAME);
const homeConfigDir = join(
  homedir(),
  process.env.XDG_CONFIG_HOME || '.config',
  DIR_NAME
);

export const defaultDir = existsSync(cwdDir) ? cwdDir : homeConfigDir;

export const ensureConfigDir = async ({
  'config-dir': configDir,
}: Arguments<{ 'config-dir': string }>) => {
  if (!existsSync(configDir)) {
    mkdirSync(configDir);
  }
};
