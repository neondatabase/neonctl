import { test, expect, describe, beforeAll, afterAll } from '@jest/globals';
import { runMockServer } from '../../test_utils/mock_server.js';
import { Server } from 'node:http';
import { fork } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { log } from '../../log';

describe('bootstrap/create-app', () => {
  let server: Server;
  const mockDir = 'main';
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

  test(
    'test',
    async () => {
      // Most of this forking code is copied from `test_cli_command.ts`.
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
          'create-app',
        ],
        {
          stdio: 'pipe',
          env: {
            PATH: `mocks/bin:${process.env.PATH}`,
          },
        },
      );

      process.on('SIGINT', () => {
        cp.kill();
      });

      let neonProjectCreated = false;
      return new Promise<void>((resolve, reject) => {
        cp.stdout?.on('data', (data) => {
          const stdout = data.toString();
          log.info(stdout);

          if (stdout.includes('What is your project named')) {
            cp.stdin?.write('my-app\n');
          } else if (
            stdout.includes('Which package manager would you like to use')
          ) {
            cp.stdin?.write('\n');
          } else if (stdout.includes('What framework would you like to use')) {
            cp.stdin?.write('\n');
          } else if (stdout.includes('What ORM would you like to use')) {
            cp.stdin?.write('\t');
            cp.stdin?.write('\n');
          } else if (
            stdout.includes('What authentication framework do you want to use')
          ) {
            cp.stdin?.write('\n');
          } else if (
            stdout.includes('What Neon project would you like to use')
          ) {
            neonProjectCreated = true;
            cp.stdin?.write('\n');
          }
        });

        cp.stderr?.on('data', (data) => {
          log.error(data.toString());
        });

        cp.on('error', (err) => {
          throw err;
        });

        cp.on('close', (code) => {
          // If we got to the point that a Neon project was successfully
          // created, we consider the test run to be a success. We can't
          // currently check that the template is properly generated, and that
          // the project runs. We'll have to do that with containerization in
          // the future, most likely.
          if (neonProjectCreated) {
            resolve();
          }

          try {
            expect(code).toBe(0);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    },
    1000 * 60,
  );
});
