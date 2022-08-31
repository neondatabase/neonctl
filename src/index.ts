import * as yargs from 'yargs';

import pkg from '../package.json';
import { ApiError } from './api/gateway';
import { ensureAuth } from './commands/auth';
import { defaultDir, ensureConfigDir } from './config';
import { log } from './log';

const wrapWithHelp = async (yargs: yargs.Argv) => {
  const { _ } = await yargs.argv;
  if (_.length === 1) {
    yargs.showHelp();
  }
  return yargs;
};

const builder = yargs
  .scriptName(pkg.name)
  .usage('usage: $0 <cmd> [args]')
  .help()
  .option('apiHost', {
    describe: 'The API host',
    default: 'https://console.neon.tech',
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
    (yargs) =>
      yargs
        .option('oauthHost', {
          description: 'URL to Neon OAUTH host',
          default: 'https://oauth2.neon.tech',
        })
        .option('clientId', {
          description: 'OAuth client id',
          type: 'string',
          demandOption: true,
        }),
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
    'me',
    'Get user info',
    (yargs) => yargs,
    async (args) => {
      await (await import('./commands/users')).me(args);
    }
  )
  .command('projects', 'Manage projects', (yargs) =>
    wrapWithHelp(
      yargs
        .usage('usage: $0 projects <cmd> [args]')
        .command(
          'list',
          'List projects',
          (yargs) => yargs,
          async (args) => {
            await (await import('./commands/projects')).list(args);
          }
        )
        .command(
          'create',
          'Create a project',
          (yargs) => yargs,
          async (args) => {
            await (await import('./commands/projects')).create(args);
          }
        )
    )
  )
  .fail(async (msg, err) => {
    if (err instanceof ApiError) {
      log.error(await err.getApiError());
    } else {
      log.error(msg || err.message);
    }
    process.exit(1);
  });

(async () => {
  if ((await builder.argv)._.length === 0) {
    yargs.showHelp();
  }
})();
