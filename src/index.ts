import * as yargs from 'yargs';

import pkg from '../package.json';
import { ApiError } from './api/gateway';
import { ensureAuth } from './commands/auth';
import { defaultDir, ensureConfigDir } from './config';
import { log } from './log';
import { defaultClientID } from './auth';

const showHelpMiddleware = (argv: yargs.Arguments) => {
  if (argv._.length === 1) {
    yargs.showHelp();
    process.exit(0);
  }
};

const builder = yargs
  .scriptName(pkg.name)
  .usage('usage: $0 <cmd> [args]')
  .help()
  .option('output', {
    describe: 'Set output format',
    type: 'string',
    choices: ['json', 'yaml', 'table'],
    default: 'table',
  })
  .option('api-host', {
    describe: 'The API host',
    default: 'https://console.neon.tech',
  })
  // Setup config directory
  .option('config-dir', {
    describe: 'Path to config directory',
    type: 'string',
    default: defaultDir,
  })
  .middleware(ensureConfigDir)
  // Auth flow
  .option('oauth-host', {
    description: 'URL to Neon OAUTH host',
    default: 'https://oauth2.neon.tech',
  })
  .option('client-id', {
    description: 'OAuth client id',
    type: 'string',
    default: defaultClientID,
  })
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
    'me',
    'Get user info',
    (yargs) => yargs.middleware(ensureAuth),
    async (args) => {
      await (await import('./commands/users')).me(args);
    }
  )
  .command('roles', 'Manage roles', async (yargs) => {
    yargs
      .usage('usage: $0 roles <cmd> [args]')
      .command(
        'resetpassword',
        'Reset password for a role',
        (yargs) =>
          yargs
            .option('project-id', {
              describe: 'Project ID',
              type: 'string',
              demandOption: true,
            })
            .option('role-name', {
              describe: 'Role name',
              type: 'string',
              demandOption: true,
            }),
        async (args) => {
          await (
            await import('./commands/roles')
          ).resetPwd({
            ...args,
            role_name: args['role-name'],
            project_id: args['project-id'],
          });
        }
      )
      .middleware(showHelpMiddleware)
      .middleware(ensureAuth);
  })
  .command('projects', 'Manage projects', async (yargs) => {
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
        (yargs) =>
          yargs.option('name', {
            describe: 'Project name',
            type: 'string',
          }),
        async (args) => {
          await (await import('./commands/projects')).create(args);
        }
      )
      .middleware(showHelpMiddleware)
      .middleware(ensureAuth);
  })

  .strict()
  .fail(async (msg, err) => {
    if (err instanceof ApiError) {
      log.error(await err.getApiError());
    } else {
      log.error(msg || err.message);
    }
    process.exit(1);
  });

(async () => {
  const args = await builder.argv;
  if (args._.length === 0) {
    yargs.showHelp();
    process.exit(0);
  }
})();
