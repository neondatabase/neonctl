import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import axiosDebug from 'axios-debug-log';
axiosDebug({
  request(debug, config) {
    debug(`${config.method?.toUpperCase()} ${config.url}`);
  },
  response(debug, response) {
    debug(`${response.status} ${response.statusText}`);
  },
  error(debug, error) {
    debug(error);
  },
});
import { Api } from '@neondatabase/api-client';

import { ensureAuth } from './commands/auth.js';
import { defaultDir, ensureConfigDir } from './config.js';
import { log } from './log.js';
import { defaultClientID } from './auth.js';
import { isApiError } from './api.js';
import { fillInArgs } from './utils.js';
import pkg from './pkg.js';
import commands from './commands/index.js';
import { analyticsMiddleware } from './analytics.js';

const builder = yargs(hideBin(process.argv))
  .scriptName(pkg.name)
  .usage('usage: $0 <cmd> [args]')
  .help()
  .option('output', {
    alias: 'o',
    describe: 'Set output format',
    type: 'string',
    choices: ['json', 'yaml', 'table'],
    default: 'table',
  })
  .option('api-host', {
    describe: 'The API host',
    default: 'https://console.neon.tech/api/v2',
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
    description: 'URL to Neon OAuth host',
    default: 'https://oauth2.neon.tech',
  })
  .option('client-id', {
    description: 'OAuth client id',
    type: 'string',
    default: defaultClientID,
  })
  .option('api-key', {
    describe: 'API key',
    type: 'string',
    default: '',
  })
  .option('apiClient', {
    hidden: true,
    coerce: (v) => v as Api<unknown>,
    default: null as unknown as Api<unknown>,
  })
  .middleware((args) => fillInArgs(args), true)
  .middleware(ensureAuth)
  .command(commands as any)
  .strictCommands()
  .option('analytics', {
    describe: 'Enable analytics',
    type: 'boolean',
    default: true,
  })
  .middleware(analyticsMiddleware)
  .fail(async (msg, err) => {
    if (isApiError(err)) {
      if (err.response.status === 401) {
        log.error('Authentication failed, please run `neonctl auth`');
      } else {
        log.error(
          '%d: %s\n%s',
          err.response.status,
          err.response.statusText,
          err.response.data?.message
        );
      }
    } else {
      log.error(msg || err?.message);
    }
    process.exit(1);
  });

(async () => {
  const args = await builder.argv;
  if (args._.length === 0) {
    builder.showHelp();
    process.exit(0);
  }
})();
