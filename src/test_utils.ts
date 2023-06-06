/* eslint-disable no-console */
import { test, expect } from '@jest/globals';
import emocks from 'emocks';
import express from 'express';
import { fork } from 'node:child_process';
import { join } from 'node:path';

export const runMockServer = () => {
  const app = express();
  const port = 3000;
  app.use(express.json());
  app.use('/', emocks(join(process.cwd(), 'mocks')));

  return app.listen(port, () => {
    console.log(`Mock server listening at ${port}`);
  });
};

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
  test(name, (done) => {
    let output = '';
    let error = '';

    const cp = fork(
      join(process.cwd(), './dist/index.js'),
      ['--api-host', 'http://localhost:3000', '--api-key', 'test-key', ...args],
      {
        stdio: 'pipe',
      }
    );

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
      done();
      if (error) {
        console.log(error);
      }
      if (expected) {
        if ('snapshot' in expected) {
          expect(output).toMatchSnapshot();
        } else if ('output' in expected) {
          expect(output).toEqual(expected.output);
        }
        expect(code).toBe(0);
      }
    });
  });
};
