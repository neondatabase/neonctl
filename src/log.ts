import { format } from 'node:util';
import { isDebug } from './env.js';

export const log = {
  debug: (...args: unknown[]) => {
    if (isDebug()) {
      process.stderr.write(`DEBUG: ${format(...args)}\n`);
    }
  },
  info: (...args: unknown[]) => {
    process.stderr.write(`INFO: ${format(...args)}\n`);
  },
  error: (...args: unknown[]) => {
    process.stderr.write(`ERROR: ${format(...args)}\n`);
  },
};
