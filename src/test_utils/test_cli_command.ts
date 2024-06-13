import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import { fork } from 'node:child_process';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { log } from '../log.js';
import strip from 'strip-ansi';

import { runMockServer } from './mock_server.js';

export type TestCliCommandOptions = {
  name: string;
  args: string[];
  before?: () => Promise<void>;
  after?: () => Promise<void>;
  mockDir?: string;
  expected?: {
    snapshot?: true;
    stdout?: string | ReturnType<typeof expect.stringMatching>;
    stderr?: string | ReturnType<typeof expect.stringMatching>;
    code?: number;
  };
};

export const testCliCommand = ({
  args,
  name,
  expected,
  before,
  after,
  mockDir = 'main',
}: TestCliCommandOptions) => {
  let server: Server;
  describe(name, () => {
    beforeAll(async () => {
      if (before) {
        await before();
      }
      server = await runMockServer(mockDir);
    });

    afterAll(async () => {
      if (after) {
        await after();
      }
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });

    test('test', async () => {
      let output = '';
      let error = '';

      // TODO: Maybe make this run source code? Bun supports that no problem
      // Or maybe spawn the binary for better e2e?
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
        cp.stdout?.on('data', (data) => {
          output += data.toString();
        });

        cp.stderr?.on('data', (data) => {
          error += data.toString();
          log.error(data.toString());
        });

        cp.on('error', (err) => {
          throw err;
        });

        cp.on('close', (code) => {
          try {
            expect(code).toBe(expected?.code ?? 0);
            if (expected) {
              if (expected.snapshot) {
                expect(output).toMatchSnapshot();
              }
              if (expected.stdout !== undefined) {
                expect(strip(output)).toEqual(expected.stdout);
              }
              if (expected.stderr !== undefined) {
                expect(strip(error).replace(/\s+/g, ' ').trim()).toEqual(
                  typeof expected.stderr === 'string'
                    ? expected.stderr.toString().replace(/\s+/g, ' ')
                    : expected.stderr,
                );
              }
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  });
};
