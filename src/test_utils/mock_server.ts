import emocks from 'emocks';
import express from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { log } from '../log';

export const runMockServer = async (mockDir: string) =>
  new Promise<Server>((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/',
      emocks(join(process.cwd(), 'mocks', mockDir), {
        '404': (req, res) => res.status(404).send({ message: 'Not Found' }),
      }),
    );

    const server = app.listen(0);
    server.on('listening', () => {
      resolve(server);
      log.info(
        'Mock server listening at %d',
        (server.address() as AddressInfo).port,
      );
    });
  });
