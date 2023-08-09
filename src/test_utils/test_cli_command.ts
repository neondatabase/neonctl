import { test, expect, describe, beforeAll, afterAll } from '@jest/globals';
import { fork } from 'node:child_process';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { log } from '../log.js';

import { runMockServer } from './mock_server.js';

export type TestCliCommandOptions = {
  name: string;
  args: string[];
  mockDir?: string;
  expected?: {
    snapshot?: true;
    stdout?: string | ReturnType<typeof expect.stringMatching>;
    stderr?: string | ReturnType<typeof expect.stringMatching>;
  };
  env?: Record<string, string>;
};

export const testCliCommand = ({
  args,
  name,
  expected,
  mockDir = 'main',
  env = {},
}: TestCliCommandOptions) => {
  let server: Server;
  describe(name, () => {
    beforeAll(async () => {
      server = await runMockServer(mockDir);
    });

    afterAll(async () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });

    test('test', async () => {
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
          ...args,
        ],
        {
          stdio: 'pipe',
          env: env,
        }
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
            expect(code).toBe(0);
            if (code === 0 && expected) {
              if (expected.snapshot) {
                expect(output).toMatchSnapshot();
              }
              if (expected.stdout !== undefined) {
                expect(output).toEqual(expected.stdout);
              }
              if (expected.stderr !== undefined) {
                expect(error).toEqual(expected.stderr);
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
