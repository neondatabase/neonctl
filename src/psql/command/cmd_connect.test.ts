import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
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
import { createScramClient } from '../wire/sasl.js';

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
  /** Password to expose via the structural `password` getter (PgConnection parity). */
  password?: string | null;
  /** TLS attributes returned by `getTlsInfo()` (null = plaintext). */
  tlsInfo?: {
    protocol: string;
    cipher: string;
    compression: string;
    alpn: string | null;
    library: string;
    keyBits: number | null;
  } | null;
  /** Static connection facts returned by `getConnectionInfo()`. */
  connInfo?: {
    host: string;
    hostaddr: string | null;
    port: number;
    options: string | null;
    backendPid: number;
    passwordUsed: boolean;
    gssapiUsed: boolean;
  };
  /** Map of ParameterStatus name → value (e.g. is_superuser / in_hot_standby). */
  paramStatus?: Record<string, string>;
  /**
   * Connection-target fields exposed via the `database`/`user`/`host`/`port`
   * getters, mirroring how `PgConnection` surfaces `this.opts.*`. Consumed by
   * `syncConnectionVars` (the SyncVariables() port) to populate DBNAME/USER/
   * HOST/PORT after a connect.
   */
  target?: {
    database?: string;
    user?: string;
    host?: string;
    port?: number;
  };
  /** Override the integer `serverVersion` getter (default 160000). */
  serverVersion?: number;
};

const makeFakeConnection = (
  opts: FakeConnectionOpts = {},
): Connection & {
  closeCalls: number;
  lastExecSql: string | null;
  password: string | null;
} => {
  let isClosed = opts.closed ?? false;
  const responses = opts.queryResponses ?? {};
  const fake: Connection & {
    closeCalls: number;
    lastExecSql: string | null;
    password: string | null;
    database?: string;
    user?: string;
    host?: string;
    port?: number;
  } = {
    closeCalls: 0,
    lastExecSql: null,
    password: opts.password ?? null,
    ...(opts.target?.database !== undefined
      ? { database: opts.target.database }
      : {}),
    ...(opts.target?.user !== undefined ? { user: opts.target.user } : {}),
    ...(opts.target?.host !== undefined ? { host: opts.target.host } : {}),
    ...(opts.target?.port !== undefined ? { port: opts.target.port } : {}),
    serverVersion: opts.serverVersion ?? 160000,
    parameterStatus: (name: string) => opts.paramStatus?.[name],
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
    getTlsInfo: () => opts.tlsInfo ?? null,
    getConnectionInfo: () =>
      opts.connInfo ?? {
        host: '',
        hostaddr: null,
        port: 5432,
        options: null,
        backendPid: 0,
        passwordUsed: false,
        gssapiUsed: false,
      },
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

  test('conninfo: hostaddr is kept distinct from host', () => {
    const r = parseConnectArgs('host=db.example.com hostaddr=1.2.3.4');
    expect(r).toEqual({ host: 'db.example.com', hostaddr: '1.2.3.4' });
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

  test('URI: malformed percent-escape yields an error, not a thrown URIError', () => {
    // `%zz` is not a valid percent-escape — decodeURIComponent throws URIError.
    // It must surface as a clean error rather than crashing the REPL.
    const r = parseConnectArgs('postgresql://user@host/db%zz');
    expect(r).toEqual({ error: expect.stringMatching(/invalid URI/i) });
  });

  test('URI: percent-escapes in userinfo/dbname are decoded', () => {
    const r = parseConnectArgs(
      'postgresql://al%20ice:p%40ss@host.example.com/my%20db',
    );
    expect(r).toEqual({
      host: 'host.example.com',
      user: 'al ice',
      password: 'p@ss',
      database: 'my db',
    });
  });

  test('URI: query parameters map onto connection keywords', () => {
    const r = parseConnectArgs(
      'postgresql://host.example.com/mydb?sslmode=require&connect_timeout=10&application_name=myapp',
    );
    expect(r).toEqual({
      host: 'host.example.com',
      database: 'mydb',
      ssl: 'require',
      connectTimeoutMs: 10_000,
      applicationName: 'myapp',
    });
  });

  test('URI: an invalid query-param value is rejected', () => {
    const r = parseConnectArgs(
      'postgresql://host.example.com/mydb?sslmode=garbage',
    );
    expect(r).toEqual({ error: expect.stringMatching(/invalid sslmode/) });
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

  test('carries TLS/cert options from the prior connection', () => {
    const s = defaultSettings(createVarStore());
    const prior: Partial<ConnectOptions> = {
      host: 'h1',
      port: 5432,
      user: 'alice',
      database: 'orig',
      ssl: 'verify-full',
      sslrootcert: '/ca.pem',
      sslcert: '/client.crt',
      sslkey: '/client.key',
      sslnegotiation: 'direct',
      channelBinding: 'require',
    };
    const opts = mergeConnectOpts(s, { database: 'otherdb' }, prior);
    expect(opts).toMatchObject({
      database: 'otherdb',
      ssl: 'verify-full',
      sslrootcert: '/ca.pem',
      sslcert: '/client.crt',
      sslkey: '/client.key',
      sslnegotiation: 'direct',
      channelBinding: 'require',
    });
  });

  test('keeps the prior password when the target is unchanged', () => {
    const s = defaultSettings(createVarStore());
    const prior: Partial<ConnectOptions> = {
      host: 'h1',
      port: 5432,
      user: 'alice',
      password: 's3cret',
    };
    const opts = mergeConnectOpts(s, { database: 'otherdb' }, prior);
    expect(opts).toMatchObject({ user: 'alice', password: 's3cret' });
  });

  test.each([
    ['host', { host: 'attacker.example.com' }],
    ['user', { user: 'bob' }],
    ['port', { port: 5544 }],
  ])('drops the prior password when %s changes', (_label, override) => {
    const s = defaultSettings(createVarStore());
    const prior: Partial<ConnectOptions> = {
      host: 'h1',
      port: 5432,
      user: 'alice',
      password: 's3cret',
    };
    const opts = mergeConnectOpts(s, override, prior);
    expect('error' in opts ? undefined : opts.password).toBeUndefined();
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
    const oldConn = makeFakeConnection({ password: 's3cret' });
    s.db = oldConn;

    // The new connection reports its target the way `PgConnection` does
    // (getters backed by the merged connect opts), so SyncVariables() reads
    // DBNAME=otherdb / HOST=h1 / etc. straight off the live connection.
    const newConn = makeFakeConnection({
      target: { database: 'otherdb', user: 'alice', host: 'h1', port: 5432 },
    });
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
      // Password is retained from the previous connection (libpq parity) so
      // the user doesn't have to re-supply it on every `\c`.
      password: 's3cret',
    });
    expect(oldConn.closeCalls).toBe(1);
    expect(s.db).toBe(newConn);
    expect(s.vars.get('DBNAME')).toBe('otherdb');
    expect(stdout()).toMatch(
      /You are now connected to database "otherdb" as user "alice"/,
    );
  });

  test('explicit password in URI wins over the previous connection password', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('USER', 'alice');
    s.db = makeFakeConnection({ password: 'old-pw' });

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
        'postgresql://alice:new-pw@host.example.com:5433/mydb',
        s,
      ),
    );
    expect(calls[0]).toMatchObject({
      host: 'host.example.com',
      database: 'mydb',
      user: 'alice',
      password: 'new-pw',
    });
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

  test('re-syncs connection vars from the new connection (SyncVariables)', async () => {
    const s = defaultSettings(createVarStore());
    // Stale values from the previous connection — must be overwritten.
    s.vars.set('HOST', 'old-host');
    s.vars.set('PORT', '5432');
    s.vars.set('USER', 'old-user');
    s.vars.set('DBNAME', 'old-db');
    s.vars.set('ENCODING', 'LATIN1');
    s.vars.set('SERVER_VERSION_NAME', '14.0');
    s.vars.set('SERVER_VERSION_NUM', '140000');
    s.db = makeFakeConnection({ password: 's3cret' });

    const newConn = makeFakeConnection({
      target: {
        database: 'newdb',
        user: 'bob',
        host: 'newhost',
        port: 6000,
      },
      serverVersion: 180004,
      paramStatus: { client_encoding: 'UTF8', server_version: '18.4' },
    });
    restore = setCmdConnectDeps({
      connect: () => Promise.resolve(newConn),
    });

    const r = await run(
      cmdConnect,
      makeMockCtx('c', 'newdb bob newhost 6000', s),
    );
    expect(r.status).toBe('ok');
    expect(s.vars.get('DBNAME')).toBe('newdb');
    expect(s.vars.get('USER')).toBe('bob');
    expect(s.vars.get('HOST')).toBe('newhost');
    expect(s.vars.get('PORT')).toBe('6000');
    expect(s.vars.get('ENCODING')).toBe('UTF8');
    expect(s.vars.get('SERVER_VERSION_NAME')).toBe('18.4');
    expect(s.vars.get('SERVER_VERSION_NUM')).toBe('180004');
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
  // A TCP connection's static facts, as PgConnection.getConnectionInfo()
  // would report them (resolved peer IP, backend PID, etc.).
  const tcpConnInfo = {
    host: 'host.example.com',
    hostaddr: '3.131.64.200',
    port: 5432,
    options: null,
    backendPid: -2141034612,
    passwordUsed: true,
    gssapiUsed: false,
  };

  test('reports "not connected" when settings.db is null', async () => {
    const s = defaultSettings(createVarStore());
    s.db = null;
    const r = await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    expect(r.status).toBe('ok');
    expect(stdout()).toMatch(/not connected/);
  });

  test('renders the PG18 Connection Information table (plaintext)', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('DBNAME', 'neondb');
    s.vars.set('USER', 'vadim');
    s.db = makeFakeConnection({
      tlsInfo: null,
      connInfo: { ...tcpConnInfo, hostaddr: null, passwordUsed: false },
      paramStatus: { is_superuser: 'off', in_hot_standby: 'off' },
    });

    await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    const out = stdout();
    // Title + the (left-aligned) Parameter/Value header.
    expect(out).toMatch(/Connection Information/);
    expect(out).toMatch(/Parameter\s+\|\s+Value/);
    // Representative rows.
    expect(out).toMatch(/Database\s+\| neondb/);
    expect(out).toMatch(/Client User\s+\| vadim/);
    expect(out).toMatch(/Host\s+\| host\.example\.com/);
    expect(out).toMatch(/Protocol Version\s+\| 3\.0/);
    expect(out).toMatch(/Password Used\s+\| false/);
    expect(out).toMatch(/GSSAPI Authenticated\s+\| false/);
    expect(out).toMatch(/SSL Connection\s+\| false/);
    expect(out).toMatch(/Superuser\s+\| off/);
    expect(out).toMatch(/Hot Standby\s+\| off/);
    // No SSL rows on a plaintext connection.
    expect(out).not.toMatch(/SSL Library/);
    expect(out).not.toMatch(/SSL Cipher/);
    // Default footer is on → "(N rows)". Plaintext = the 12 non-SSL rows.
    expect(out).toMatch(/\(12 rows\)/);
  });

  test('includes all SSL rows for a TLS connection', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('DBNAME', 'neondb');
    s.vars.set('USER', 'vadim');
    s.db = makeFakeConnection({
      tlsInfo: {
        protocol: 'TLSv1.3',
        cipher: 'TLS_AES_256_GCM_SHA384',
        compression: 'off',
        alpn: 'postgresql',
        library: 'OpenSSL',
        keyBits: 256,
      },
      connInfo: tcpConnInfo,
      paramStatus: { is_superuser: 'off', in_hot_standby: 'off' },
    });

    await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    const out = stdout();
    expect(out).toMatch(/SSL Connection\s+\| true/);
    expect(out).toMatch(/SSL Library\s+\| OpenSSL/);
    expect(out).toMatch(/SSL Protocol\s+\| TLSv1\.3/);
    expect(out).toMatch(/SSL Key Bits\s+\| 256/);
    expect(out).toMatch(/SSL Cipher\s+\| TLS_AES_256_GCM_SHA384/);
    expect(out).toMatch(/SSL Compression\s+\| false/);
    expect(out).toMatch(/ALPN\s+\| postgresql/);
    // Password Used reflects an authenticated password connection.
    expect(out).toMatch(/Password Used\s+\| true/);
    // A distinct hostaddr surfaces as its own row.
    expect(out).toMatch(/Host Address\s+\| 3\.131\.64\.200/);
  });

  test('omits the separate Host Address row when hostaddr equals host', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('DBNAME', 'neondb');
    s.vars.set('USER', 'vadim');
    s.db = makeFakeConnection({
      tlsInfo: null,
      // host literal == resolved peer IP (a bare-IP connection).
      connInfo: {
        ...tcpConnInfo,
        host: '3.131.64.200',
        hostaddr: '3.131.64.200',
      },
      paramStatus: { is_superuser: 'off', in_hot_standby: 'off' },
    });

    await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    const out = stdout();
    expect(out).toMatch(/Host\s+\| 3\.131\.64\.200/);
    // No redundant Host Address row.
    expect(out).not.toMatch(/Host Address/);
  });

  test('reports Superuser/Hot Standby as "unknown" when the status is absent', async () => {
    const s = defaultSettings(createVarStore());
    s.vars.set('DBNAME', 'neondb');
    s.vars.set('USER', 'vadim');
    s.db = makeFakeConnection({ tlsInfo: null, connInfo: tcpConnInfo });

    await run(cmdConninfo, makeMockCtx('conninfo', '', s));
    const out = stdout();
    expect(out).toMatch(/Superuser\s+\| unknown/);
    expect(out).toMatch(/Hot Standby\s+\| unknown/);
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

  test('verifier authenticates the original password (SCRAM round-trip)', () => {
    // End-to-end proof that the verifier we'd store on the server is valid:
    // run a SCRAM-SHA-256 handshake where the "server" only knows the
    // verifier (salt, iterations, StoredKey, ServerKey) and the client
    // knows the cleartext. If the verifier is sound the client's proof
    // must validate and the server's signature must be accepted.
    const password = 'correct horse battery staple';
    const salt = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
    const verifier = scramSha256Verifier(password, salt);

    // Parse: SCRAM-SHA-256$<iter>:<b64salt>$<b64storedKey>:<b64serverKey>
    const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
    if (!m) throw new Error(`bad verifier: ${verifier}`);
    const iterations = parseInt(m[1], 10);
    const verifierSalt = Buffer.from(m[2], 'base64');
    const storedKey = Buffer.from(m[3], 'base64');
    const serverKey = Buffer.from(m[4], 'base64');

    // Salt/iterations round-trip cleanly.
    expect(verifierSalt.equals(salt)).toBe(true);
    expect(iterations).toBe(4096);

    // Drive a real SCRAM client against a fake server that only ever uses
    // the verifier-derived material.
    const clientNonce = Buffer.from(
      '000102030405060708090a0b0c0d0e0f1011',
      'hex',
    );
    const client = createScramClient({
      user: 'user',
      password,
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: () => clientNonce,
    });
    const { clientFirstMessage } = client.start();

    // Reconstruct the gs2-less client-first-bare and assemble server-first.
    const cfStr = clientFirstMessage.toString('utf8');
    const nIdx = cfStr.indexOf('n=');
    const clientFirstBare = cfStr.substring(nIdx);
    const rIdx = cfStr.indexOf(',r=');
    const clientNonceB64 = cfStr.substring(rIdx + 3);
    const serverNonceSuffix = 'serverNoncePart';
    const combinedNonce = clientNonceB64 + serverNonceSuffix;
    const serverFirstStr = `r=${combinedNonce},s=${verifierSalt.toString(
      'base64',
    )},i=${String(iterations)}`;
    const serverFirst = Buffer.from(serverFirstStr, 'utf8');

    const clientFinal = client.continue(serverFirst);

    // Server verifies the proof using only StoredKey.
    const cfinalStr = clientFinal.toString('utf8');
    const pIdx = cfinalStr.lastIndexOf(',p=');
    const clientFinalWithoutProof = cfinalStr.substring(0, pIdx);
    const proof = Buffer.from(cfinalStr.substring(pIdx + 3), 'base64');
    const authMessage = `${clientFirstBare},${serverFirstStr},${clientFinalWithoutProof}`;
    const clientSig = createHmac('sha256', storedKey)
      .update(authMessage)
      .digest();
    const reconstructedClientKey = Buffer.alloc(proof.length);
    for (let i = 0; i < proof.length; i++) {
      reconstructedClientKey[i] = proof[i] ^ clientSig[i];
    }
    const reconstructedStoredKey = createHash('sha256')
      .update(reconstructedClientKey)
      .digest();
    expect(reconstructedStoredKey.equals(storedKey)).toBe(true);

    // Server-final is HMAC(ServerKey, authMessage).
    const serverSig = createHmac('sha256', serverKey)
      .update(authMessage)
      .digest();
    const serverFinal = Buffer.from(
      `v=${serverSig.toString('base64')}`,
      'utf8',
    );
    expect(() => {
      client.finish(serverFinal);
    }).not.toThrow();
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

  test('issues ALTER USER with a SCRAM verifier', async () => {
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
    // Matches libpq's PQchangePassword: `ALTER USER <id> PASSWORD <lit>`.
    expect(sql).toMatch(/^ALTER USER "alice" PASSWORD /);
    expect(sql).toMatch(/SCRAM-SHA-256\$4096:/);
  });

  test('refuses with "not in interactive mode" when settings.notty is true', async () => {
    const s = defaultSettings(createVarStore());
    s.db = makeFakeConnection();
    s.notty = true;
    // No `readLine` mock — the cmd should reject before prompting.
    const r = await run(cmdPassword, makeMockCtx('password', 'alice', s));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/not in interactive mode/);
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
    expect(fake.lastExecSql ?? '').toMatch(/^ALTER USER "carol" PASSWORD /);
  });
});
