import { describe, expect, test } from 'vitest';

import type { Connection } from '../types/connection.js';

import { createVarStore } from './variables.js';
import {
  clientVersionNum,
  setStartupVars,
  syncConnectionVars,
} from './syncVars.js';

// ---------------------------------------------------------------------------
// A minimal Connection stub that mirrors how `PgConnection` surfaces the
// connection target (getters backed by the connect opts) plus the two
// ParameterStatus values SyncVariables() reads.
// ---------------------------------------------------------------------------

type StubOpts = {
  database?: string;
  user?: string;
  host?: string;
  port?: number;
  serverVersion?: number;
  params?: Record<string, string>;
};

const makeConn = (o: StubOpts = {}): Connection =>
  ({
    ...(o.database !== undefined ? { database: o.database } : {}),
    ...(o.user !== undefined ? { user: o.user } : {}),
    ...(o.host !== undefined ? { host: o.host } : {}),
    ...(o.port !== undefined ? { port: o.port } : {}),
    serverVersion: o.serverVersion ?? 0,
    parameterStatus: (name: string) => o.params?.[name],
  }) as unknown as Connection;

describe('syncConnectionVars', () => {
  test('sets DBNAME/USER/HOST/PORT/ENCODING/SERVER_VERSION_* from the connection', () => {
    const vars = createVarStore();
    const conn = makeConn({
      database: 'mydb',
      user: 'postgres',
      host: 'db.example.com',
      port: 5433,
      serverVersion: 180004,
      params: { client_encoding: 'UTF8', server_version: '18.4' },
    });

    syncConnectionVars(vars, conn);

    expect(vars.get('DBNAME')).toBe('mydb');
    expect(vars.get('USER')).toBe('postgres');
    expect(vars.get('HOST')).toBe('db.example.com');
    expect(vars.get('PORT')).toBe('5433');
    expect(vars.get('ENCODING')).toBe('UTF8');
    expect(vars.get('SERVER_VERSION_NAME')).toBe('18.4');
    expect(vars.get('SERVER_VERSION_NUM')).toBe('180004');
  });

  test('HOST for a Unix-domain socket is the socket directory', () => {
    const vars = createVarStore();
    syncConnectionVars(
      vars,
      makeConn({ host: '/var/run/postgresql', port: 5432 }),
    );
    expect(vars.get('HOST')).toBe('/var/run/postgresql');
    expect(vars.get('PORT')).toBe('5432');
  });

  test('overwrites stale values on a subsequent (reconnect) call', () => {
    const vars = createVarStore();
    syncConnectionVars(
      vars,
      makeConn({
        database: 'a',
        user: 'u1',
        host: 'h1',
        port: 1,
        serverVersion: 140000,
        params: { client_encoding: 'LATIN1', server_version: '14.0' },
      }),
    );
    syncConnectionVars(
      vars,
      makeConn({
        database: 'b',
        user: 'u2',
        host: 'h2',
        port: 2,
        serverVersion: 170002,
        params: { client_encoding: 'UTF8', server_version: '17.2' },
      }),
    );
    expect(vars.get('DBNAME')).toBe('b');
    expect(vars.get('USER')).toBe('u2');
    expect(vars.get('HOST')).toBe('h2');
    expect(vars.get('PORT')).toBe('2');
    expect(vars.get('ENCODING')).toBe('UTF8');
    expect(vars.get('SERVER_VERSION_NAME')).toBe('17.2');
    expect(vars.get('SERVER_VERSION_NUM')).toBe('170002');
  });

  test('skips SERVER_VERSION_NUM when the connection has not reported a version yet', () => {
    const vars = createVarStore();
    syncConnectionVars(vars, makeConn({ database: 'd', serverVersion: 0 }));
    expect(vars.get('DBNAME')).toBe('d');
    expect(vars.has('SERVER_VERSION_NUM')).toBe(false);
  });

  test('leaves a var untouched when the connection cannot report it', () => {
    const vars = createVarStore();
    vars.set('USER', 'preexisting');
    // Connection exposes only a database; USER getter is absent.
    syncConnectionVars(vars, makeConn({ database: 'd' }));
    expect(vars.get('USER')).toBe('preexisting');
    expect(vars.get('DBNAME')).toBe('d');
  });
});

describe('setStartupVars', () => {
  test('seeds VERSION / VERSION_NAME / VERSION_NUM from the client version', () => {
    const vars = createVarStore();
    setStartupVars(vars, '2.22.0');
    expect(vars.get('VERSION')).toBe('psql-ts (neonctl) 2.22.0');
    expect(vars.get('VERSION_NAME')).toBe('2.22.0');
    expect(vars.get('VERSION_NUM')).toBe('22200');
  });
});

describe('clientVersionNum', () => {
  test('maps MAJOR.MINOR.PATCH to PG_VERSION_NUM layout', () => {
    expect(clientVersionNum('2.22.0')).toBe(22200);
    expect(clientVersionNum('1.0.0')).toBe(10000);
    expect(clientVersionNum('18.4')).toBe(180400);
    expect(clientVersionNum('3')).toBe(30000);
  });

  test('returns 0 for a non-numeric leading component', () => {
    expect(clientVersionNum('abc')).toBe(0);
  });
});
