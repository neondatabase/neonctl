import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Analytics } from '@segment/analytics-node';
import { isAxiosError } from 'axios';

import { CREDENTIALS_FILE } from './config.js';
import { isCi } from './env.js';
import { ErrorCode } from './errors.js';
import { log } from './log.js';
import pkg from './pkg.js';

const WRITE_KEY = '3SQXn5ejjXWLEJ8xU2PRYhAotLtTaeeV';

let client: Analytics | undefined;
let userId = '';

export const analyticsMiddleware = async (args: {
  analytics: boolean;
  configDir: string;
  _: (string | number)[];
  [key: string]: unknown;
}) => {
  if (!args.analytics) {
    return;
  }

  try {
    const credentialsPath = join(args.configDir, CREDENTIALS_FILE);
    const credentials = readFileSync(credentialsPath, { encoding: 'utf-8' });
    userId = JSON.parse(credentials).user_id;
  } catch (err) {
    log.debug('Failed to read credentials file', err);
  }

  client = new Analytics({
    writeKey: WRITE_KEY,
    host: 'https://track.neon.tech',
  });
  client.identify({
    userId: userId?.toString() ?? 'anonymous',
  });

  client.track({
    userId: userId ?? 'anonymous',
    event: 'CLI Started',
    properties: {
      version: pkg.version,
      command: args._.join(' '),
      flags: {
        output: args.output,
      },
      ci: isCi(),
    },
  });
  await client.closeAndFlush();
  log.debug('Sent CLI started event with userId: %s', userId);
};

export const sendError = (err: Error, errCode: ErrorCode) => {
  if (!client) {
    return;
  }
  const axiosError = isAxiosError(err) ? err : undefined;
  client.track({
    event: 'CLI Error',
    userId: userId ?? 'anonymous',
    properties: {
      message: err.message,
      stack: err.stack,
      errCode,
      statusCode: axiosError?.response?.status,
    },
  });
  client.closeAndFlush();
  log.debug('Sent CLI error event: %s', errCode);
};
