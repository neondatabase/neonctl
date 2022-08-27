import * as yargs from 'yargs';

import pkg from '../package.json';
import { ensureAuth } from './commands/auth';
import { defaultDir, ensureConfigDir } from './config';

const builder = yargs
  .scriptName(pkg.name)
  .usage('$0 <cmd> [args]')
  .help()
  .option('apiHost', {
    describe: 'The API host',
    default: 'https://console.neon.tech',
  })
  .option('oauthHost', {
    description: 'URL to Neon OAUTH host',
    default: 'https://oauth2.neon.tech',
  })
  .option('clientId', {
    description: 'OAuth client id',
    type: 'string',
  })
  // Setup config directory
  .option('configDir', {
    describe: 'Path to config directory',
    type: 'string',
    default: defaultDir,
  })
  .middleware(ensureConfigDir)
  // Auth flow
  .command(
    'auth',
    'Authenticate user',
    (yargs) => yargs,
    async (args) => {
      (await import('./commands/auth')).authFlow(args);
    }
  )
  // Ensure auth token
  .option('token', {
    describe: 'Auth token',
    type: 'string',
    default: '',
  })
  .command(
    'projects [sub]',
    'Manage projects',
    async (yargs) =>
      yargs.middleware(ensureAuth).positional('sub', {
        describe: 'Subcommand',
        choices: ['list'] as const,
      }),
    async (args) => {
      (await import('./commands/projects')).default(args);
    }
  );

(async () => {
  if ((await builder.argv)._.length === 0) {
    yargs.showHelp();
  }
})();
