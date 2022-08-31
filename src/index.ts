import * as yargs from 'yargs';

import pkg from '../package.json';
import { ApiError } from './api/gateway';
import { ensureAuth } from './commands/auth';
import { defaultDir, ensureConfigDir } from './config';
import { log } from './log';

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
  .middleware(ensureAuth)
  .command(
    'projects [sub]',
    'Manage projects',
    async (yargs) =>
      yargs.positional('sub', {
        describe: 'Subcommand',
        choices: ['list', 'create'] as const,
      }),
    async (args) => {
      await (await import('./commands/projects')).default(args);
    }
  )
  .fail(async (msg, err) => {
    log.error('Command failed');
    if (err instanceof ApiError) {
      log.error(await err.getApiError());
    } else {
      log.error(msg || err);
    }
    process.exit(1);
  });

(async () => {
  if ((await builder.argv)._.length === 0) {
    yargs.showHelp();
  }
})();
