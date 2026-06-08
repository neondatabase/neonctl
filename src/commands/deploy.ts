import yargs from 'yargs';

import { fillSingleProject } from '../utils/enrichers.js';
import { applyCmd, applyFlags, type ConfigProps } from './config.js';

export const command = 'deploy';
export const describe =
  'Apply a neon.ts policy to a branch (alias for `config apply`)';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 deploy [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
      },
      config: {
        describe: 'Path to a neon.ts policy (defaults to walking up from cwd)',
        type: 'string',
      },
      ...applyFlags,
    })
    .middleware(fillSingleProject as any)
    .strict();

export const handler = (props: ConfigProps) => applyCmd(props);
