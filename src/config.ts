import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { Arguments } from 'yargs';

const DIR_NAME = '.neonctl';

export const defaultDir = join(process.cwd(), DIR_NAME);

export const ensureConfigDir = async ({
  configDir,
}: Arguments<{ configDir: string }>) => {
  if (!existsSync(configDir)) {
    mkdirSync(configDir);
  }
};
