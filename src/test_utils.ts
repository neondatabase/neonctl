/* eslint-disable no-console */
import { test, expect, describe, beforeAll, afterAll } from '@jest/globals';
import emocks from 'emocks';
import express from 'express';
import { fork } from 'node:child_process';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';

const runMockServer = async () =>
  new Promise<Server>((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/', emocks(join(process.cwd(), 'mocks')));

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
  expected?:
    | {
        snapshot: true;
      }
    | {
        output: string;
      };
};

export const testCliCommand = ({
  args,
  name,
  expected,
}: TestCliCommandOptions) => {
  let server: Server;
  describe(name, () => {
    beforeAll(async () => {
      server = await runMockServer();
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
          if (error) {
            console.log(error);
          }
          try {
            expect(code).toBe(0);
            if (code === 0 && expected) {
              if ('snapshot' in expected) {
                expect(output).toMatchSnapshot();
              } else if ('output' in expected) {
                expect(output).toEqual(expected.output);
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
