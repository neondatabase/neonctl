/* eslint-disable no-console */
import { test, expect, describe, beforeAll, afterAll } from '@jest/globals';
import emocks from 'emocks';
import express from 'express';
import { fork } from 'node:child_process';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';

const runMockServer = async (mockDir: string) =>
  new Promise<Server>((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/', emocks(join(process.cwd(), 'mocks', mockDir)));

    const server = app.listen(0);
    server.on('listening', () => {
      console.log(
        `Mock server listening at ${(server.address() as AddressInfo).port}`
      );
    });
    resolve(server);
  });

export type TestCliCommandOptions = {
  name: string;
  args: string[];
  mockDir?: string;
  expected?: {
    snapshot?: true;
    stdout?: string | ReturnType<typeof expect.stringMatching>;
    stderr?: string | ReturnType<typeof expect.stringMatching>;
  };
};

export const testCliCommand = ({
  args,
  name,
  expected,
  mockDir = 'main',
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
          '--api-key',
          'test-key',
          '--output',
          'yaml',
          ...args,
        ],
        {
          stdio: 'pipe',
        }
      );

      return new Promise<void>((resolve, reject) => {
        cp.stdout?.on('data', (data) => {
          output += data.toString();
        });

        cp.stderr?.on('data', (data) => {
          error += data.toString();
        });

        cp.on('error', (err) => {
          throw err;
        });

        cp.on('close', (code) => {
          try {
            if (code !== 0 && error) {
              console.error(error);
            }
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
