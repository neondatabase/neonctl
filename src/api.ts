import { createApiClient } from '@neondatabase/api-client';
import { isAxiosError } from 'axios';

import { log } from './log.js';
import pkg from './pkg.js';

export type ApiCallProps = {
  apiKey: string;
  apiHost?: string;
};

export const getApiClient = ({ apiKey, apiHost }: ApiCallProps) =>
  createApiClient({
    apiKey,
    baseURL: apiHost,
    timeout: 10000,
    headers: {
      'User-Agent': `neonctl v${pkg.version}`,
    },
  });

const RETRY_COUNT = 5;
const RETRY_DELAY = 3000;
export const retryOnLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let attempt = 0;
  let errOut: unknown;
  while (attempt < RETRY_COUNT) {
    try {
      return await fn();
    } catch (err) {
      errOut = err;
      if (isAxiosError(err) && err.response?.status === 423) {
        attempt++;
        log.info(
          `Resource is locked. Waiting ${RETRY_DELAY}ms before retrying...`
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      } else {
        throw err;
      }
    }
  }
  throw errOut;
};
