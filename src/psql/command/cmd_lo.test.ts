/**
 * `\lo_list` / `\lo_import` / `\lo_export` / `\lo_unlink` tests.
 *
 * Drives the four commands against a mock {@link Connection} that
 * records the SQL and parameters it sees, returning canned result sets.
 * The file-system tests use a real temp dir created with `fs.mkdtemp`
 * and cleaned up in `afterEach`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BackslashContext } from '../types/backslash.js';
import type { Connection, ResultSet } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import { createBackslashRegistry } from './dispatch.js';
import {
  cmdLoExport,
  cmdLoImport,
  cmdLoList,
  cmdLoListPlus,
  cmdLoUnlink,
  registerLargeObjectCommands,
} from './cmd_lo.js';

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

/** A captured `conn.query` call. */
type QueryCall = { sql: string; params: unknown[] };

const mkResultSet = (fields: string[], rows: unknown[][]): ResultSet => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: null,
  fields: fields.map((name) => ({
    name,
    tableID: 0,
    columnID: 0,
    dataTypeID: 25,
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: 0 as const,
  })),
  rows,
  notices: [],
});

type MockResponse =
  | { match: (sql: string) => boolean; rs: ResultSet }
  | { match: (sql: string) => boolean; err: Error };

const mkConn = (
  responses: MockResponse[],
  spy: {
    queries: QueryCall[];
    execs: string[];
  },
): Connection => ({
  serverVersion: 170000,
  parameterStatus: () => undefined,
  query: ((sql: string, params?: unknown[]) => {
    spy.queries.push({ sql, params: params ?? [] });
    const found = responses.find((r) => r.match(sql));
    if (!found) {
      return Promise.reject(
        new Error(`mock: unexpected query: ${sql.slice(0, 80)}`),
      );
    }
    if ('err' in found) return Promise.reject(found.err);
    return Promise.resolve(found.rs);
  }) as Connection['query'],
  execSimple: ((sql: string) => {
    spy.execs.push(sql);
    return Promise.resolve([mkResultSet([], [])]);
  }) as Connection['execSimple'],
  prepare: vi.fn() as unknown as Connection['prepare'],
  startCopyIn: vi.fn() as unknown as Connection['startCopyIn'],
  startCopyOut: vi.fn() as unknown as Connection['startCopyOut'],
  pipeline: vi.fn() as unknown as Connection['pipeline'],
  cancel: vi.fn(() => Promise.resolve()),
  escapeIdentifier: (s) => `"${s.replace(/"/g, '""')}"`,
  escapeLiteral: (s) => `'${s.replace(/'/g, "''")}'`,
  onNotice: () => () => undefined,
  onNotification: () => () => undefined,
  close: vi.fn(() => Promise.resolve()),
  isClosed: () => false,
});

const mkSettings = (db: Connection | null): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  s.db = db;
  return s;
};

/**
 * Build a `BackslashContext` matching what the dispatcher would synthesise
 * — but with a simple whitespace-only argument lexer. This is sufficient
 * for the `\lo_*` commands because their args are non-quoted (file paths
 * and OIDs).
 */
const mkCtx = (
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
    nextArg: (): string | null => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      if (cursor >= rawArgs.length) return null;
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

// ---------------------------------------------------------------------------
// stdout/stderr/tmpdir setup
// ---------------------------------------------------------------------------

let stdoutChunks: string[];
let stderrChunks: string[];
let stdoutOrig: typeof process.stdout.write;
let stderrOrig: typeof process.stderr.write;
let tmpDir: string;

beforeEach(async () => {
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psql-lo-test-'));
});

afterEach(async () => {
  process.stdout.write = stdoutOrig;
  process.stderr.write = stderrOrig;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Connection guard (shared across all four commands)
// ---------------------------------------------------------------------------

describe('cmd_lo — connection guard', () => {
  test.each([
    { name: 'lo_list', spec: cmdLoList, args: '' },
    { name: 'lo_list+', spec: cmdLoListPlus, args: '' },
    { name: 'lo_import', spec: cmdLoImport, args: '/tmp/foo' },
    { name: 'lo_export', spec: cmdLoExport, args: '42 /tmp/foo' },
    { name: 'lo_unlink', spec: cmdLoUnlink, args: '42' },
  ])('$name with null db → error + stderr', async ({ name, spec, args }) => {
    const ctx = mkCtx(name, args, mkSettings(null));
    const r = await spec.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/no connection to the server/);
  });
});

// ---------------------------------------------------------------------------
// \lo_list / \lo_list+
// ---------------------------------------------------------------------------

describe('cmd_lo — \\lo_list', () => {
  test('prints aligned table from mock result set', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const rs = mkResultSet(
      ['ID', 'Owner', 'Description'],
      [
        [42, 'alice', 'a tarball'],
        [43, 'bob', null],
      ],
    );
    const conn = mkConn(
      [{ match: (sql) => sql.includes('pg_largeobject_metadata'), rs }],
      spy,
    );
    const ctx = mkCtx('lo_list', '', mkSettings(conn));
    const r = await cmdLoList.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.queries.length).toBe(1);
    expect(spy.queries[0].sql).toMatch(
      /FROM pg_catalog\.pg_largeobject_metadata/,
    );
    // Non-verbose: no ACL column.
    expect(spy.queries[0].sql).not.toMatch(/Access privileges/);
    const out = stdoutChunks.join('');
    // Aligned printer renders the column headers and values.
    expect(out).toMatch(/ID/);
    expect(out).toMatch(/Owner/);
    expect(out).toMatch(/Description/);
    expect(out).toMatch(/42/);
    expect(out).toMatch(/alice/);
    expect(out).toMatch(/43/);
    expect(out).toMatch(/bob/);
    // Title comes from listLargeObjects.description.
    expect(out).toMatch(/Large objects/);
  });

  test('\\lo_list+ includes Access privileges column in the SQL', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const rs = mkResultSet(
      ['ID', 'Owner', 'Access privileges', 'Description'],
      [],
    );
    const conn = mkConn(
      [{ match: (sql) => sql.includes('pg_largeobject_metadata'), rs }],
      spy,
    );
    const ctx = mkCtx('lo_list+', '', mkSettings(conn));
    const r = await cmdLoListPlus.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.queries[0].sql).toMatch(/Access privileges/);
  });

  test('query failure surfaces as error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn(
      [
        {
          match: () => true,
          err: new Error('boom'),
        },
      ],
      spy,
    );
    const ctx = mkCtx('lo_list', '', mkSettings(conn));
    const r = await cmdLoList.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\lo_list: boom/);
  });
});

// ---------------------------------------------------------------------------
// \lo_import FILE [COMMENT]
// ---------------------------------------------------------------------------

describe('cmd_lo — \\lo_import', () => {
  test('reads file, calls lo_from_bytea, prints lo_import OID, sets LASTOID', async () => {
    const filePath = path.join(tmpDir, 'payload.bin');
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x10]);
    await fs.writeFile(filePath, bytes);

    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('lo_from_bytea'),
          rs: mkResultSet(['lo_from_bytea'], [[12345]]),
        },
      ],
      spy,
    );
    const settings = mkSettings(conn);
    const ctx = mkCtx('lo_import', filePath, settings);

    const r = await cmdLoImport.run(ctx);
    expect(r.status).toBe('ok');

    // SQL is the parameterised form.
    expect(spy.queries[0].sql).toMatch(
      /SELECT pg_catalog\.lo_from_bytea\(0, \$1::bytea\)/,
    );
    // Param is the hex-escaped bytea: \x followed by the lowercase hex of bytes.
    expect(spy.queries[0].params[0]).toBe('\\x0001ff10');
    // No COMMENT clause was emitted.
    expect(spy.execs).toEqual([]);
    expect(stdoutChunks.join('')).toMatch(/lo_import 12345/);
    expect(settings.vars.get('LASTOID')).toBe('12345');
  });

  test('with COMMENT, issues COMMENT ON LARGE OBJECT via execSimple', async () => {
    const filePath = path.join(tmpDir, 'commented.bin');
    await fs.writeFile(filePath, Buffer.from('hi'));

    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('lo_from_bytea'),
          rs: mkResultSet(['lo_from_bytea'], [[42]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx(
      'lo_import',
      `${filePath} my comment with ' inside`,
      mkSettings(conn),
    );

    const r = await cmdLoImport.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.execs.length).toBe(1);
    expect(spy.execs[0]).toBe(
      "COMMENT ON LARGE OBJECT 42 IS 'my comment with '' inside'",
    );
    expect(stdoutChunks.join('')).toMatch(/lo_import 42/);
  });

  test('missing file argument → error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn([], spy);
    const ctx = mkCtx('lo_import', '', mkSettings(conn));
    const r = await cmdLoImport.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/missing required argument/);
  });

  test('file read failure → error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn([], spy);
    const ctx = mkCtx(
      'lo_import',
      path.join(tmpDir, 'does-not-exist'),
      mkSettings(conn),
    );
    const r = await cmdLoImport.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\lo_import:/);
  });
});

// ---------------------------------------------------------------------------
// \lo_export OID FILE
// ---------------------------------------------------------------------------

describe('cmd_lo — \\lo_export', () => {
  test('decodes hex bytea cell and writes to the supplied path', async () => {
    const outPath = path.join(tmpDir, 'out.bin');
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('lo_get'),
          rs: mkResultSet(['lo_get'], [['\\xdeadbeef']]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('lo_export', `99 ${outPath}`, mkSettings(conn));

    const r = await cmdLoExport.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.queries[0].sql).toMatch(/SELECT pg_catalog\.lo_get\(\$1::oid\)/);
    expect(spy.queries[0].params[0]).toBe(99);
    const written = await fs.readFile(outPath);
    expect(written.equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true);
    expect(stdoutChunks.join('')).toMatch(/lo_export/);
  });

  test('accepts Buffer cell directly', async () => {
    const outPath = path.join(tmpDir, 'buf.bin');
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const payload = Buffer.from([1, 2, 3, 4]);
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('lo_get'),
          rs: mkResultSet(['lo_get'], [[payload]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('lo_export', `7 ${outPath}`, mkSettings(conn));
    const r = await cmdLoExport.run(ctx);
    expect(r.status).toBe('ok');
    const written = await fs.readFile(outPath);
    expect(written.equals(payload)).toBe(true);
  });

  test('missing file argument → error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn([], spy);
    const ctx = mkCtx('lo_export', '42', mkSettings(conn));
    const r = await cmdLoExport.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/missing required argument/);
  });

  test('invalid OID → error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn([], spy);
    const ctx = mkCtx(
      'lo_export',
      `notanumber ${path.join(tmpDir, 'x')}`,
      mkSettings(conn),
    );
    const r = await cmdLoExport.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/not a valid large object OID/);
  });
});

// ---------------------------------------------------------------------------
// \lo_unlink OID
// ---------------------------------------------------------------------------

describe('cmd_lo — \\lo_unlink', () => {
  test('runs SELECT lo_unlink and prints the summary', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('lo_unlink'),
          rs: mkResultSet(['lo_unlink'], [[1]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('lo_unlink', '17', mkSettings(conn));
    const r = await cmdLoUnlink.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.queries[0].sql).toMatch(
      /SELECT pg_catalog\.lo_unlink\(\$1::oid\)/,
    );
    expect(spy.queries[0].params[0]).toBe(17);
    expect(stdoutChunks.join('')).toMatch(/lo_unlink 17/);
  });

  test('missing OID → error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn([], spy);
    const ctx = mkCtx('lo_unlink', '', mkSettings(conn));
    const r = await cmdLoUnlink.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/missing required argument/);
  });

  test('invalid OID → error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn([], spy);
    const ctx = mkCtx('lo_unlink', 'abc', mkSettings(conn));
    const r = await cmdLoUnlink.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/not a valid large object OID/);
  });

  test('server error surfaces as error', async () => {
    const spy = { queries: [], execs: [] } as {
      queries: QueryCall[];
      execs: string[];
    };
    const conn = mkConn(
      [
        {
          match: () => true,
          err: new Error('large object 9999 does not exist'),
        },
      ],
      spy,
    );
    const ctx = mkCtx('lo_unlink', '9999', mkSettings(conn));
    const r = await cmdLoUnlink.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/large object 9999 does not exist/);
  });
});

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('registerLargeObjectCommands', () => {
  test('registers all four primary commands', () => {
    const r = createBackslashRegistry();
    registerLargeObjectCommands(r);
    expect(r.lookup('lo_list')?.name).toBe('lo_list');
    expect(r.lookup('lo_list+')?.name).toBe('lo_list+');
    expect(r.lookup('lo_import')?.name).toBe('lo_import');
    expect(r.lookup('lo_export')?.name).toBe('lo_export');
    expect(r.lookup('lo_unlink')?.name).toBe('lo_unlink');
  });
});
