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

import { ensureAuth, deleteCredentials } from './commands/auth.js';
import { defaultDir, ensureConfigDir } from './config.js';
import { log } from './log.js';
import { defaultClientID } from './auth.js';
import { fillInArgs } from './utils/middlewares.js';
import pkg from './pkg.js';
import commands from './commands/index.js';
import {
  analyticsMiddleware,
  closeAnalytics,
  getAnalyticsEventProperties,
  sendError,
  trackEvent,
} from './analytics.js';
import { isAxiosError } from 'axios';
import { matchErrorCode } from './errors.js';
import { showHelp } from './help.js';
import { currentContextFile, enrichFromContext } from './context.js';

const NO_SUBCOMMANDS_VERBS = [
  // aliases
  'auth',
  'login',
  'me',

  // aliases
  'cs',
  'connection-string',

  'set-context',

  // aliases
];

let builder = yargs(hideBin(process.argv));
builder = builder
  .scriptName(pkg.name)
  .locale('en')
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
    default: process.env.NEON_API_HOST ?? 'https://console.neon.tech/api/v2',
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
  .options({
    'oauth-host': {
      description: 'URL to Neon OAuth host',
      hidden: true,
      default: process.env.NEON_OAUTH_HOST ?? 'https://oauth2.neon.tech',
    },
    'client-id': {
      description: 'OAuth client id',
      hidden: true,
      type: 'string',
      default: defaultClientID,
    },
    'api-key': {
      describe: 'API key',
      group: 'Global options:',
      type: 'string',
      default: process.env.NEON_API_KEY ?? '',
    },
    apiClient: {
      hidden: true,
      coerce: (v) => v as Api<unknown>,
      default: null as unknown as Api<unknown>,
    },
    'context-file': {
      describe: 'Context file',
      type: 'string',
      default: currentContextFile,
    },
    color: {
      group: 'Global options:',
      describe: 'Colorize the output. Example: --no-color, --color false',
      type: 'boolean',
      default: true,
    },
  })
  .middleware((args) => {
    fillInArgs(args);
  }, true)
  .help(false)
  .group('help', 'Global options:')
  .option('help', {
    describe: 'Show help',
    type: 'boolean',
    default: false,
  })
  .alias('help', 'h')
  .middleware(async (args) => {
    if (
      args.help ||
      (args._.length === 1 &&
        !NO_SUBCOMMANDS_VERBS.includes(args._[0] as string))
    ) {
      await showHelp(builder);
    }
  })
  .middleware(ensureAuth)
  .middleware(enrichFromContext as any)
  .command(commands as any)
  .strictCommands()
  .option('analytics', {
    describe: 'Manage analytics. Example: --no-analytics, --analytics false',
    group: 'Global options:',
    type: 'boolean',
    default: true,
  })
  .middleware(analyticsMiddleware, true)
  .version(pkg.version)
  .group('version', 'Global options:')
  .alias('version', 'v')
  .completion()
  .scriptName(basename(process.argv[1]) === 'neon' ? 'neon' : 'neonctl')
  .epilog(
    'For more information, visit https://neon.tech/docs/reference/neon-cli',
  )
  .wrap(null)
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
        log.error('Authentication failed, please run `neonctl auth`');
        sendError(err, 'AUTH_FAILED');
        try {
          deleteCredentials(defaultDir);
        } catch (deleteErr) {
          log.debug(
            'Failed to delete credentials: %s',
            deleteErr instanceof Error ? deleteErr.message : 'unknown error',
          );
        }
      } else {
        if (err.response?.data?.message) {
          log.error(err.response?.data?.message);
        }
        log.debug(
          'status: %d %s | path: %s',
          err.response?.status,
          err.response?.statusText,
          err.request?.path,
        );
        sendError(err, 'API_ERROR');
      }
    } else {
      sendError(err || new Error(msg), matchErrorCode(msg || err?.message));
      log.error(msg || err?.message);
    }
    await closeAnalytics();
    if (err?.stack) {
      log.debug('Stack: %s', err.stack);
    }
    process.exit(1);
  });

void (async () => {
  try {
    const args = await builder.argv;
    trackEvent('cli_command_success', {
      ...getAnalyticsEventProperties(args),
      projectId: args.projectId,
      branchId: args.branchId,
    });
    if (args._.length === 0 || args.help) {
      await showHelp(builder);
      process.exit(0);
    }
    await closeAnalytics();
  } catch {
    // noop
  }
})();
