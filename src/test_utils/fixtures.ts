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
    expected?: {
      snapshot?: true;
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
      server.close((err) => (err ? reject(err) : resolve())),
    );
  },
  testCliCommand: async ({ runMockServer, task }, use) => {
    const mockDirOverride = /\*mockDir:(.*?)\*/.exec(task.name);
    const server = await runMockServer(
      mockDirOverride ? mockDirOverride[1] : 'main',
    );
    await use(async (args, expected = { snapshot: true }) => {
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
          throw err;
        });

        cp.on('close', (code) => {
          try {
            expect(code).toBe(expected?.code ?? 0);
            if (expected.snapshot) {
              expect(output).toMatchSnapshot();
            }
            if (expected.stderr !== undefined) {
              expect(strip(error).replace(/\s+/g, ' ').trim()).toEqual(
                typeof expected.stderr === 'string'
                  ? expected.stderr.toString().replace(/\s+/g, ' ')
                  : expected.stderr,
              );
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  },
});
