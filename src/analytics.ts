import { Api } from '@neondatabase/api-client';
import { Analytics } from '@segment/analytics-node';

import { isCi } from './env.js';
import pkg from './pkg.js';

const WRITE_KEY = '3SQXn5ejjXWLEJ8xU2PRYhAotLtTaeeV';

export const analyticsMiddleware = (args: {
  analytics: boolean;
  apiClient: Api<unknown>;
  _: (string | number)[];
  [key: string]: unknown;
}) => {
  if (!args.analytics) {
    return;
  }

  const client = new Analytics({
    writeKey: WRITE_KEY,
    host: 'https://track.neon.tech',
  });

  (
    args.apiClient?.getCurrentUserInfo() ??
    Promise.resolve({ data: { id: undefined } })
  )
    .then(({ data }) => data.id)
    .then((userId) => {
      client.track({
        userId,
        event: 'CLI Started',
        properties: {
          version: pkg.version,
          command: args._,
          flags: {
            output: args.output,
          },
          ci: isCi(),
        },
      });
      client.closeAndFlush();
    })
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    .catch(() => {});
};
