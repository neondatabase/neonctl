import { format } from 'node:util';

export const log = {
  info: (...args: unknown[]) => {
    process.stderr.write(`INFO: ${format(...args)}\n`);
  },
  error: (...args: unknown[]) => {
    process.stderr.write(`ERROR: ${format(...args)}\n`);
  },
};
