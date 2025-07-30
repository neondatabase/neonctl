import { Server } from 'node:http';
import { fork } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test as originalTest } from 'vitest';
import strip from 'strip-ansi';
import emocks from 'emocks';
import express from 'express';

import { log } from '../log';

type Fixtures = {
  runMockServer: (mockDir: string) => Promise<Server>;
  testCliCommand: (
    args: string[],
    options?: {
      mockDir?: string;
      stderr?: string;
      code?: number;
    },
  ) => Promise<void>;
};

export const test = originalTest.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  runMockServer: async ({}, use) => {
    let server: Server;
    await use(async (mockDir) => {
      const app = express();
      app.use(express.json());
      app.use(
        '/',
        emocks(join(process.cwd(), 'mocks', mockDir), {
          '404': (_req, res) => res.status(404).send({ message: 'Not Found' }),
        }),
      );

      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          resolve();
          log.debug(
            'Mock server listening at %d',
            (server.address() as AddressInfo).port,
          );
        });
      });

      return server;
    });
    await new Promise<void>((resolve, reject) =>
      server.close((err) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve();
        }
      }),
    );
  },
  testCliCommand: async ({ runMockServer }, use) => {
    await use(async (args, options = {}) => {
      const server = await runMockServer(options.mockDir || 'main');
      let output = '';
      let error = '';

      const cp = fork(
        join(process.cwd(), './dist/index.js'),
        [
          '--api-host',
          `http://localhost:${(server.address() as AddressInfo).port}`,
          '--output',
          'yaml',
          '--api-key',
          'test-key',
          '--no-analytics',
          ...args,
        ],
        {
          stdio: 'pipe',
          env: {
            PATH: `mocks/bin:${process.env.PATH}`,
          },
        },
      );

      return new Promise<void>((resolve, reject) => {
        cp.stdout?.on('data', (data: Buffer) => {
          output += data.toString();
        });

        cp.stderr?.on('data', (data: Buffer) => {
          error += data.toString();
          log.error(data.toString());
        });

        cp.on('error', (err) => {
          log.error(err);
          throw err;
        });

        cp.on('close', (code) => {
          try {
            expect(code).toBe(options?.code ?? 0);
            expect(output).toMatchSnapshot();
            if (options.stderr !== undefined) {
              expect(strip(error).replace(/\s+/g, ' ').trim()).toEqual(
                typeof options.stderr === 'string'
                  ? options.stderr.toString().replace(/\s+/g, ' ')
                  : options.stderr,
              );
            }
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }).catch((err: unknown) => {
        log.error(err);
        throw err;
      });
    });
  },
});
