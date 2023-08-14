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
import { analyticsMiddleware, sendError } from './analytics.js';
import { isCi } from './env.js';
import { isAxiosError } from 'axios';
import { matchErrorCode } from './errors.js';
import { showHelp } from './help.js';

let builder = yargs(hideBin(process.argv));
builder = builder
  .scriptName(pkg.name)
  .usage('$0 <command> [options]')
  .parserConfiguration({
    'populate--': true,
  })
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
  .middleware(analyticsMiddleware, true)
  .group('version', 'Global options:')
  .alias('version', 'v')
  .help(false)
  .group('help', 'Global options:')
  .option('help', {
    describe: 'Show help',
    type: 'boolean',
    default: false,
  })
  .alias('help', 'h')
  .completion()
  .scriptName(basename(process.argv[1]) === 'neon' ? 'neon' : 'neonctl')
  .fail(async (msg, err) => {
    if (process.argv.some((arg) => arg === '--help' || arg === '-h')) {
      await showHelp(builder);
      process.exit(0);
    }

    if (isAxiosError(err)) {
      if (err.code === 'ECONNABORTED') {
        log.error('Request timed out');
        sendError(err, 'REQUEST_TIMEOUT');
      } else if (err.response?.status === 401) {
        sendError(err, 'AUTH_FAILED');
        log.error('Authentication failed, please run `neonctl auth`');
      } else {
        log.debug(
          'Fail: %d | %s',
          err.response?.status,
          err.response?.statusText
        );
        log.error(err.response?.data?.message);
        sendError(err, 'API_ERROR');
      }
    } else {
      sendError(err || new Error(msg), matchErrorCode(msg || err?.message));
      log.error(msg || err?.message);
    }
    err?.stack && log.debug('Stack: %s', err.stack);
    process.exit(1);
  });

(async () => {
  const args = await builder.argv;
  if (args._.length === 0 || args.help) {
    await showHelp(builder);
    process.exit(0);
  }
})();
