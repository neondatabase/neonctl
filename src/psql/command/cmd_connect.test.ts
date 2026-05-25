import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { BackslashContext, BackslashCmdSpec } from '../types/backslash.js';
import type {
  Connection,
  ConnectOptions,
  ResultSet,
} from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  cmdConnect,
  cmdConninfo,
  cmdEncoding,
  cmdPassword,
  mergeConnectOpts,
  parseConnectArgs,
  scramSha256Verifier,
  setCmdConnectDeps,
} from './cmd_connect.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMockCtx = (
  cmdName: string,
  rawArgs: string,
  settings: PsqlSettings,
): BackslashContext => {
  let cursor = 0;
  return {
    settings,
    cmdName,
    queryBuf: '',
    rawArgs,
    nextArg: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      if (cursor >= rawArgs.length) return null;
      if (rawArgs[cursor] === "'") {
        cursor++;
        let out = '';
        while (cursor < rawArgs.length && rawArgs[cursor] !== "'") {
          out += rawArgs[cursor++];
        }
        if (cursor < rawArgs.length) cursor++;
        return out;
      }
      const start = cursor;
      while (cursor < rawArgs.length && !/\s/.test(rawArgs[cursor])) cursor++;
      return rawArgs.slice(start, cursor);
    },
    restOfLine: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      const tail = rawArgs.slice(cursor);
      cursor = rawArgs.length;
      return tail;
    },
  };
};

type FakeConnectionOpts = {
  closed?: boolean;
  /** Map of SQL → ResultSet for `query()` lookups. */
  queryResponses?: Record<string, ResultSet>;
  /** Captured argument for the last `execSimple()` call. */
  onExecSimple?: (sql: string) => void;
};

const makeFakeConnection = (
  opts: FakeConnectionOpts = {},
): Connection & {
  closeCalls: number;
  lastExecSql: string | null;
} => {
  let isClosed = opts.closed ?? false;
  const responses = opts.queryResponses ?? {};
  const fake: Connection & { closeCalls: number; lastExecSql: string | null } =
    {
      closeCalls: 0,
      lastExecSql: null,
      serverVersion: 160000,
      parameterStatus: () => undefined,
      query: (sql: string) => {
        const rs = responses[sql.trim()];
        if (rs) return Promise.resolve(rs);
        return Promise.resolve<ResultSet>({
          command: 'SELECT',
          rowCount: 0,
          oid: null,
          fields: [],
          rows: [],
          notices: [],
        });
      },
      execSimple: (sql: string) => {
        fake.lastExecSql = sql;
        opts.onExecSimple?.(sql);
        return Promise.resolve<ResultSet[]>([
          {
            command: 'SET',
            rowCount: null,
            oid: null,
            fields: [],
            rows: [],
            notices: [],
          },
        ]);
      },
      prepare: () => Promise.reject(new Error('not impl')),
      startCopyIn: () => Promise.reject(new Error('not impl')),
      startCopyOut: () => Promise.reject(new Error('not impl')),
      pipeline: () => {
        throw new Error('not impl');
      },
      cancel: () => Promise.resolve(),
      escapeIdentifier: (v) => '"' + v.replace(/"/g, '""') + '"',
      escapeLiteral: (v) => "'" + v.replace(/'/g, "''") + "'",
      onNotice: () => () => undefined,
      onNotification: () => () => undefined,
      close: () => {
        fake.closeCalls++;
        isClosed = true;
        return Promise.resolve();
      },
      isClosed: () => isClosed,
    };
  return fake;
};

let stdoutChunks: string[];
let stderrChunks: string[];
let stdoutOrig: typeof process.stdout.write;
let stderrOrig: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  stdoutOrig = process.stdout.write.bind(process.stdout);
  stderrOrig = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = stdoutOrig;
  process.stderr.write = stderrOrig;
});

const stdout = (): string => stdoutChunks.join('');
const stderr = (): string => stderrChunks.join('');
const run = (spec: BackslashCmdSpec, ctx: BackslashContext) => spec.run(ctx);

// ---------------------------------------------------------------------------
// parseConnectArgs
// ---------------------------------------------------------------------------

describe('parseConnectArgs', () => {
  test('empty input yields empty override', () => {
    const r = parseConnectArgs('');
    expect(r).toEqual({});
  });

  test('positional: db user host port', () => {
    const r = parseConnectArgs('mydb alice db.example.com 5433');
    expect(r).toEqual({
      database: 'mydb',
      user: 'alice',
      host: 'db.example.com',
      port: 5433,
    });
  });

  test('positional: dashes are keep-current sentinels', () => {
    const r = parseConnectArgs('- alice - 6000');
    expect(r).toEqual({ user: 'alice', port: 6000 });
  });

  test('positional: rejects invalid port', () => {
    const r = parseConnectArgs('db user host abc');
    expect(r).toEqual({ error: expect.stringMatching(/invalid port/) });
  });

  test('URI form', () => {
    const r = parseConnectArgs(
      'postgresql://alice:s3cret@db.example.com:5433/mydb',
    );
    expect(r).toEqual({
      host: 'db.example.com',
      port: 5433,
      user: 'alice',
      password: 's3cret',
      database: 'mydb',
    });
  });

  test('URI form: missing path / port / userinfo', () => {
    const r = parseConnectArgs('postgresql://db.example.com');
    expect(r).toEqual({ host: 'db.example.com' });
  });

  test('conninfo form', () => {
    const r = parseConnectArgs('dbname=mydb host=db.example.com port=5433');
    expect(r).toEqual({
      database: 'mydb',
      host: 'db.example.com',
      port: 5433,
    });
  });

  test('conninfo: sslmode is parsed', () => {
    const r = parseConnectArgs('host=h sslmode=require');
    expect(r).toEqual({ host: 'h', ssl: 'require' });
  });

  test('conninfo: rejects invalid sslmode', () => {
    const r = parseConnectArgs('sslmode=garbage');
    expect(r).toEqual({ error: expect.stringMatching(/invalid sslmode/) });
  });

  test('conninfo: rejects malformed pair', () => {
    const r = parseConnectArgs('host=h portisbad');
    // "portisbad" lacks `=` so it triggers the parse error.
    expect(r).toEqual({ error: expect.stringMatching(/missing "="/) });
  });
});

// ---------------------------------------------------------------------------
// mergeConnectOpts
// ---------------------------------------------------------------------------

describe('mergeConnectOpts', () => {
  test('falls back to psql vars HOST/PORT/USER/DBNAME', () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('HOST', 'db.example.com');
    s.vars.set('PORT', '5433');
    s.vars.set('USER', 'alice');
    s.vars.set('DBNAME', 'mydb');
    const opts = mergeConnectOpts(s, {});
    expect(opts).toMatchObject({
      host: 'db.example.com',
      port: 5433,
      user: 'alice',
      database: 'mydb',
    });
  });

  test('override wins over psql vars', () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('HOST', 'old.example.com');
    s.vars.set('USER', 'alice');
    s.vars.set('DBNAME', 'mydb');
    const opts = mergeConnectOpts(s, { database: 'otherdb' });
    expect(opts).toMatchObject({
      host: 'old.example.com',
      user: 'alice',
      database: 'otherdb',
    });
  });

  test('errors when no user can be resolved', () => {
    const s = defaultSettings(createVarStore());
    // Wipe USER / USERNAME env vars for this assertion.
    const prevUser = process.env.USER;
    const prevUsername = process.env.USERNAME;
    delete process.env.USER;
    delete process.env.USERNAME;
    try {
      const r = mergeConnectOpts(s, {});
      expect(r).toEqual({ error: expect.stringMatching(/no user/) });
    } finally {
      if (prevUser !== undefined) process.env.USER = prevUser;
      if (prevUsername !== undefined) process.env.USERNAME = prevUsername;
    }
  });
});

// ---------------------------------------------------------------------------
// \c
// ---------------------------------------------------------------------------

describe('\\c (cmdConnect)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  test('with no args, prints conninfo (no connection)', async () => {
    const s = defaultSettings(createVarStore());
    s.db = null;
    const r = await run(cmdConnect, makeMockCtx('c', '', s));
    expect(r.status).toBe('ok');
    expect(stdout()).toMatch(/not connected/);
  });

  test('positional: new db keeps host/user', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('HOST', 'h1');
    s.vars.set('PORT', '5432');
    s.vars.set('USER', 'alice');
    s.vars.set('DBNAME', 'orig');
    const oldConn = makeFakeConnection();
    s.db = oldConn;

    const newConn = makeFakeConnection();
    const calls: ConnectOptions[] = [];
    const connect = (opts: ConnectOptions): Promise<Connection> => {
      calls.push(opts);
      return Promise.resolve(newConn);
    };
    restore = setCmdConnectDeps({ connect });

    const r = await run(cmdConnect, makeMockCtx('c', 'otherdb', s));
    expect(r.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: 'h1',
      port: 5432,
      user: 'alice',
      database: 'otherdb',
    });
    expect(oldConn.closeCalls).toBe(1);
    expect(s.db).toBe(newConn);
    expect(s.vars.get('DBNAME')).toBe('otherdb');
    expect(stdout()).toMatch(
      /You are now connected to database "otherdb" as user "alice"/,
    );
  });

  test('"-" sentinels keep current values', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('HOST', 'h1');
    s.vars.set('PORT', '5432');
    s.vars.set('USER', 'alice');
    s.vars.set('DBNAME', 'orig');
    s.db = makeFakeConnection();

    const calls: ConnectOptions[] = [];
    restore = setCmdConnectDeps({
      connect: (opts) => {
        calls.push(opts);
        return Promise.resolve(makeFakeConnection());
      },
    });

    await run(cmdConnect, makeMockCtx('c', '- bob - -', s));
    expect(calls[0]).toMatchObject({
      host: 'h1',
      port: 5432,
      user: 'bob',
      database: 'orig',
    });
  });

  test('conninfo string', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('USER', 'alice');
    s.db = makeFakeConnection();

    const calls: ConnectOptions[] = [];
    restore = setCmdConnectDeps({
      connect: (opts) => {
        calls.push(opts);
        return Promise.resolve(makeFakeConnection());
      },
    });

    await run(cmdConnect, makeMockCtx('c', 'dbname=foo host=bar port=6000', s));
    expect(calls[0]).toMatchObject({
      host: 'bar',
      port: 6000,
      database: 'foo',
      user: 'alice',
    });
  });

  test('URI string', async () => {
    const s = defaultSettings(createVarStore());
    s.db = makeFakeConnection();

    const calls: ConnectOptions[] = [];
    restore = setCmdConnectDeps({
      connect: (opts) => {
        calls.push(opts);
        return Promise.resolve(makeFakeConnection());
      },
    });

    await run(
      cmdConnect,
      makeMockCtx(
        'c',
        'postgresql://alice:secret@host.example.com:5433/mydb',
        s,
      ),
    );
    expect(calls[0]).toMatchObject({
      host: 'host.example.com',
      port: 5433,
      user: 'alice',
      password: 'secret',
      database: 'mydb',
    });
  });

  test('failure keeps the old connection alive', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('USER', 'alice');
    const oldConn = makeFakeConnection();
    s.db = oldConn;

    restore = setCmdConnectDeps({
      connect: () => Promise.reject(new Error('boom')),
    });

    const r = await run(cmdConnect, makeMockCtx('c', 'otherdb', s));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/connection failed: boom/);
    expect(s.db).toBe(oldConn);
    expect(oldConn.closeCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// \conninfo
// ---------------------------------------------------------------------------

describe('\\conninfo', () => {
  test('reports "not connected" when settings.db is null', async () => {
    const s = defaultSettings(createVarStore());
    s.db = null;
    const r = await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    expect(r.status).toBe('ok');
    expect(stdout()).toMatch(/not connected/);
  });

  test('uses psql vars when set', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('DBNAME', 'mydb');
    s.vars.set('USER', 'alice');
    s.vars.set('HOST', 'host.example.com');
    s.vars.set('PORT', '5433');
    s.db = makeFakeConnection();

    await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    expect(stdout()).toMatch(
      /You are connected to database "mydb" as user "alice" on host "host.example.com" at port "5433"\./,
    );
  });

  test('runs SQL when psql vars are unset', async () => {
    const s = defaultSettings(createVarStore());
    const fake = makeFakeConnection({
      queryResponses: {
        'SELECT current_database(), current_user, inet_server_addr()::text, inet_server_port()::text':
          {
            command: 'SELECT',
            rowCount: 1,
            oid: null,
            fields: [],
            rows: [['mydb', 'alice', '10.0.0.1', '5432']],
            notices: [],
          },
      },
    });
    s.db = fake;

    await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    expect(stdout()).toMatch(
      /You are connected to database "mydb" as user "alice" on host "10.0.0.1" at port "5432"\./,
    );
  });

  test('renders the socket form when host starts with /', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('DBNAME', 'mydb');
    s.vars.set('USER', 'alice');
    s.vars.set('HOST', '/var/run/postgresql');
    s.vars.set('PORT', '5432');
    s.db = makeFakeConnection();

    await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    expect(stdout()).toMatch(
      /via socket in "\/var\/run\/postgresql" at port "5432"/,
    );
  });
});

// ---------------------------------------------------------------------------
// \encoding
// ---------------------------------------------------------------------------

describe('\\encoding', () => {
  test('no arg → prints current encoding', async () => {
    const s = defaultSettings(createVarStore());
    await run(cmdEncoding, makeMockCtx('encoding', '', s));
    expect(stdout().trim()).toBe(s.popt.topt.encoding);
  });

  test('with arg → sets local encoding and runs SET on connection', async () => {
    const s = defaultSettings(createVarStore());
    const fake = makeFakeConnection();
    s.db = fake;

    await run(cmdEncoding, makeMockCtx('encoding', 'LATIN1', s));
    expect(s.popt.topt.encoding).toBe('LATIN1');
    expect(s.vars.get('ENCODING')).toBe('LATIN1');
    expect(fake.lastExecSql).toBe("SET client_encoding TO 'LATIN1'");
  });

  test('with arg + no connection → local-only change', async () => {
    const s = defaultSettings(createVarStore());
    s.db = null;
    const r = await run(cmdEncoding, makeMockCtx('encoding', 'LATIN1', s));
    expect(r.status).toBe('ok');
    expect(s.popt.topt.encoding).toBe('LATIN1');
  });

  test('connection error surfaces as command error', async () => {
    const s = defaultSettings(createVarStore());
    const fake = makeFakeConnection();
    fake.execSimple = () => Promise.reject(new Error('bad encoding'));
    s.db = fake;
    const r = await run(cmdEncoding, makeMockCtx('encoding', 'WHATEVER', s));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/bad encoding/);
  });
});

// ---------------------------------------------------------------------------
// SCRAM verifier encoder
// ---------------------------------------------------------------------------

describe('scramSha256Verifier', () => {
  test('produces RFC 5803 / PG-compatible format', () => {
    const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const out = scramSha256Verifier('correct horse battery staple', salt);
    // SCRAM-SHA-256$<iter>:<b64salt>$<b64storedKey>:<b64serverKey>
    expect(out).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/,
    );
    // Deterministic with fixed salt & iterations.
    const again = scramSha256Verifier('correct horse battery staple', salt);
    expect(again).toBe(out);
  });

  test('different passwords yield different verifiers', () => {
    const salt = Buffer.alloc(16, 0xaa);
    const a = scramSha256Verifier('alpha', salt);
    const b = scramSha256Verifier('beta', salt);
    expect(a).not.toBe(b);
  });

  test('iteration count is honoured', () => {
    const salt = Buffer.alloc(16, 0x5a);
    const v4 = scramSha256Verifier('pw', salt, 4096);
    const v8 = scramSha256Verifier('pw', salt, 8192);
    expect(v4.startsWith('SCRAM-SHA-256$4096:')).toBe(true);
    expect(v8.startsWith('SCRAM-SHA-256$8192:')).toBe(true);
    expect(v4).not.toBe(v8);
  });
});

// ---------------------------------------------------------------------------
// \password
// ---------------------------------------------------------------------------

describe('\\password', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  test('refuses when not connected', async () => {
    const s = defaultSettings(createVarStore());
    s.db = null;
    const r = await run(cmdPassword, makeMockCtx('password', '', s));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/not connected/);
  });

  test('issues ALTER ROLE with a SCRAM verifier', async () => {
    const s = defaultSettings(createVarStore());
    const fake = makeFakeConnection();
    s.db = fake;

    const lines = ['s3cret', 's3cret'];
    restore = setCmdConnectDeps({
      readLine: () => Promise.resolve(lines.shift() ?? ''),
      randomBytes: () => Buffer.alloc(16, 0x01),
    });

    const r = await run(cmdPassword, makeMockCtx('password', 'alice', s));
    expect(r.status).toBe('ok');
    const sql = fake.lastExecSql ?? '';
    expect(sql).toMatch(/^ALTER ROLE "alice" PASSWORD /);
    expect(sql).toMatch(/SCRAM-SHA-256\$4096:/);
  });

  test('mismatched passwords error out', async () => {
    const s = defaultSettings(createVarStore());
    s.db = makeFakeConnection();
    const lines = ['one', 'two'];
    restore = setCmdConnectDeps({
      readLine: () => Promise.resolve(lines.shift() ?? ''),
    });

    const r = await run(cmdPassword, makeMockCtx('password', 'alice', s));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/didn't match/);
  });

  test('empty password is rejected', async () => {
    const s = defaultSettings(createVarStore());
    s.db = makeFakeConnection();
    restore = setCmdConnectDeps({
      readLine: () => Promise.resolve(''),
    });
    const r = await run(cmdPassword, makeMockCtx('password', 'alice', s));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/empty password/);
  });

  test('falls back to CURRENT_USER when no username is supplied', async () => {
    const s = defaultSettings(createVarStore());
    const fake = makeFakeConnection({
      queryResponses: {
        'SELECT CURRENT_USER': {
          command: 'SELECT',
          rowCount: 1,
          oid: null,
          fields: [],
          rows: [['carol']],
          notices: [],
        },
      },
    });
    s.db = fake;
    restore = setCmdConnectDeps({
      readLine: () => Promise.resolve('pw1'),
      randomBytes: () => Buffer.alloc(16, 0x02),
    });

    const r = await run(cmdPassword, makeMockCtx('password', '', s));
    expect(r.status).toBe('ok');
    expect(fake.lastExecSql ?? '').toMatch(/^ALTER ROLE "carol" PASSWORD /);
  });
});
