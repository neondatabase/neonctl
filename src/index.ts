import { basename } from 'node:path';
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
import { fillInArgs } from './utils/middlewares.js';
import pkg from './pkg.js';
import commands from './commands/index.js';
import { analyticsMiddleware } from './analytics.js';
import { isCi } from './env.js';
import { isAxiosError } from 'axios';

let builder = yargs(hideBin(process.argv));
builder = builder
  .scriptName(pkg.name)
  .usage('usage: $0 <command> [options]')
  .help()
  .option('output', {
    alias: 'o',
    group: 'Global options:',
    describe: 'Set output format',
    type: 'string',
    choices: ['json', 'yaml', 'table'],
    default: 'table',
  })
  .option('api-host', {
    describe: 'The API host',
    hidden: true,
    default: 'https://console.neon.tech/api/v2',
  })
  // Setup config directory
  .option('config-dir', {
    describe: 'Path to config directory',
    group: 'Global options:',
    type: 'string',
    default: defaultDir,
  })
  .option('force-auth', {
    describe: 'Force authentication',
    type: 'boolean',
    hidden: true,
    default: false,
  })
  .middleware(ensureConfigDir)
  // Auth flow
  .option('oauth-host', {
    description: 'URL to Neon OAuth host',
    hidden: true,
    default: 'https://oauth2.neon.tech',
  })
  .option('client-id', {
    description: 'OAuth client id',
    hidden: true,
    type: 'string',
    default: defaultClientID,
  })
  .option('api-key', {
    describe: 'API key',
    group: 'Global options:',
    type: 'string',
    default: process.env.NEON_API_KEY ?? '',
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
    describe: 'Manage analytics. Example: --no-analytics, --analytics false',
    group: 'Global options:',
    type: 'boolean',
    default: !isCi(),
  })
  .middleware(analyticsMiddleware)
  .group('version', 'Global options:')
  .alias('version', 'v')
  .group('help', 'Global options:')
  .alias('help', 'h')
  .completion()
  .scriptName(basename(process.argv[1]) === 'neon' ? 'neon' : 'neonctl')
  .fail(async (msg, err) => {
    if (isAxiosError(err)) {
      if (err.code === 'ECONNABORTED') {
        log.error('Request timed out');
      } else if (err.response?.status === 401) {
        log.error('Authentication failed, please run `neonctl auth`');
      } else {
        log.debug(
          'Fail: %d | %s',
          err.response?.status,
          err.response?.statusText
        );
        log.error(err.response?.data?.message);
      }
    } else {
      log.error(msg || err?.message);
    }
    err?.stack && log.debug('Stack: %s', err.stack);
    process.exit(1);
  });

(async () => {
  const args = await builder.argv;
  if (args._.length === 0) {
    builder.showHelp();
    process.exit(0);
  }
})();
