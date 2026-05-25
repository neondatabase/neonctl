/**
 * `\crosstabview` backslash-command tests (WP-22).
 *
 * Drives `cmdCrosstabview.run` with a mock connection that returns canned
 * ResultSets and a stubbed `process.stdout` capture. Verifies:
 *   - Empty buffer → error.
 *   - No connection → error.
 *   - Args parsed as numbers vs names.
 *   - Pivot success returns reset-buf.
 *   - Pivot error surfaces on stderr with the `\crosstabview:` prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { BackslashContext } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import type {
  Connection,
  FieldDescription,
  ResultSet,
} from '../types/connection.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import { cmdCrosstabview } from './cmd_misc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ColumnSpec = { name: string; oid?: number };

const makeResultSet = ({
  columns,
  rows,
  command = 'SELECT',
}: {
  columns: ColumnSpec[];
  rows: unknown[][];
  command?: string;
}): ResultSet => {
  const fields: FieldDescription[] = columns.map((c, idx) => ({
    name: c.name,
    tableID: 0,
    columnID: idx + 1,
    dataTypeID: c.oid ?? 25,
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: 0,
  }));
  return {
    command,
    rowCount: rows.length,
    oid: null,
    fields,
    rows,
    notices: [],
  };
};

const makeMockConn = (opts: {
  results?: ResultSet[];
  err?: Error;
}): { conn: Connection; calls: string[] } => {
  const calls: string[] = [];
  const conn: Connection = {
    serverVersion: 170000,
    parameterStatus: () => undefined,
    query: () => Promise.reject(new Error('unused')),
    execSimple: (sql: string) => {
      calls.push(sql);
      if (opts.err) return Promise.reject(opts.err);
      return Promise.resolve(opts.results ?? []);
    },
    prepare: () => Promise.reject(new Error('unused')),
    startCopyIn: () => Promise.reject(new Error('unused')),
    startCopyOut: () => Promise.reject(new Error('unused')),
    pipeline: () => {
      throw new Error('unused');
    },
    cancel: () => Promise.resolve(),
    escapeIdentifier: (v: string) => `"${v}"`,
    escapeLiteral: (v: string) => `'${v}'`,
    onNotice: () => () => undefined,
    onNotification: () => () => undefined,
    close: () => Promise.resolve(),
    isClosed: () => false,
  };
  return { conn, calls };
};

const settingsWithConn = (conn: Connection | null): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  s.db = conn;
  return s;
};

/**
 * Build a BackslashContext that feeds out args lexed from `rawArgs` with
 * a simplistic whitespace split. We don't need the full scanner here —
 * the args we use in tests are plain bareword identifiers / numbers.
 */
const makeCtx = (
  settings: PsqlSettings,
  queryBuf: string,
  rawArgs: string,
): BackslashContext => {
  const tokens = rawArgs.split(/\s+/).filter((t) => t.length > 0);
  let cursor = 0;
  return {
    settings,
    cmdName: 'crosstabview',
    queryBuf,
    rawArgs,
    nextArg: () => {
      if (cursor >= tokens.length) return null;
      return tokens[cursor++];
    },
    restOfLine: () => tokens.slice(cursor).join(' '),
  };
};

// stdout/stderr capture wraps the process streams for the duration of one
// test so we don't leak into the surrounding output. The "originals" are
// captured per beforeEach to be safe under parallel test runners.
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let stdoutOrig: typeof process.stdout.write;
let stderrOrig: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  stdoutOrig = process.stdout.write.bind(process.stdout);
  stderrOrig = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    stdoutChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    stderrChunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = stdoutOrig;
  process.stderr.write = stderrOrig;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cmdCrosstabview', () => {
  test('no connection → error', async () => {
    const ctx = makeCtx(settingsWithConn(null), 'SELECT 1', '');
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/no connection/);
  });

  test('empty SQL buffer → error', async () => {
    const { conn } = makeMockConn({});
    const ctx = makeCtx(settingsWithConn(conn), '', '');
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/no SQL/);
  });

  test('renders pivot from canned ResultSet', async () => {
    const result = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', '1'],
        ['x', 'b', '2'],
        ['y', 'a', '3'],
      ],
    });
    const { conn, calls } = makeMockConn({ results: [result] });
    const ctx = makeCtx(settingsWithConn(conn), 'SELECT v,h,d FROM t', '');
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('reset-buf');
    expect(r.newBuf).toBe('');
    expect(calls).toEqual(['SELECT v,h,d FROM t']);
    const out = stdoutChunks.join('');
    expect(out).toContain('v');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toMatch(/x\s+\|\s+1\s+\|\s+2/);
  });

  test('args parsed as 1-based indices', async () => {
    const result = makeResultSet({
      columns: [{ name: 'h' }, { name: 'd' }, { name: 'v' }],
      rows: [
        ['a', 11, 'X'],
        ['b', 22, 'X'],
        ['a', 33, 'Y'],
      ],
    });
    const { conn } = makeMockConn({ results: [result] });
    const ctx = makeCtx(settingsWithConn(conn), 'SELECT h,d,v FROM t', '3 1 2');
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdoutChunks.join('');
    // colV=3 (v), colH=1 (h), colD=2 (d).
    expect(out).toMatch(/X\s+\|\s+11\s+\|\s+22/);
    expect(out).toMatch(/Y\s+\|\s+33/);
  });

  test('args parsed as names', async () => {
    const result = makeResultSet({
      columns: [{ name: 'row' }, { name: 'col' }, { name: 'val' }],
      rows: [
        ['r1', 'c1', 'A'],
        ['r1', 'c2', 'B'],
      ],
    });
    const { conn } = makeMockConn({ results: [result] });
    const ctx = makeCtx(
      settingsWithConn(conn),
      'SELECT * FROM t',
      'row col val',
    );
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdoutChunks.join('');
    expect(out).toMatch(/c1\s+\|\s+c2/);
  });

  test('sort arg with leading - sorts descending', async () => {
    const result = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }, { name: 'rank' }],
      rows: [
        ['x', 'mar', 1, '3'],
        ['x', 'feb', 2, '2'],
        ['x', 'jan', 3, '1'],
      ],
    });
    const { conn } = makeMockConn({ results: [result] });
    // Explicit colV/colH/colD/sortColH: the 4-col input needs colD to
    // disambiguate (upstream behaviour).
    const ctx = makeCtx(
      settingsWithConn(conn),
      'SELECT * FROM t',
      'v h d -rank',
    );
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdoutChunks.join('');
    // Headers should be ordered mar, feb, jan (rank 3, 2, 1 descending).
    const headerLine = out.split('\n').find((l) => /mar/.exec(l)) ?? '';
    const marPos = headerLine.indexOf('mar');
    const febPos = headerLine.indexOf('feb');
    const janPos = headerLine.indexOf('jan');
    expect(marPos).toBeGreaterThanOrEqual(0);
    expect(marPos).toBeLessThan(febPos);
    expect(febPos).toBeLessThan(janPos);
  });

  test('pivot error surfaces on stderr with command prefix', async () => {
    const result = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', 1],
        ['x', 'a', 2],
      ],
    });
    const { conn } = makeMockConn({ results: [result] });
    const ctx = makeCtx(settingsWithConn(conn), 'SELECT * FROM t', '');
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(
      /\\crosstabview:.*multiple data values/,
    );
  });

  test('execSimple failure surfaces on stderr', async () => {
    const { conn } = makeMockConn({
      err: new Error('relation "missing" does not exist'),
    });
    const ctx = makeCtx(settingsWithConn(conn), 'SELECT * FROM missing', '');
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/relation "missing"/);
  });

  test('non-tuples result errors', async () => {
    // A bare UPDATE with no fields populated.
    const result = makeResultSet({
      columns: [],
      rows: [],
      command: 'UPDATE',
    });
    const { conn } = makeMockConn({ results: [result] });
    const ctx = makeCtx(settingsWithConn(conn), 'UPDATE t SET x=1', '');
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/did not return a result set/);
  });

  test('picks the last tuples-yielding result in a multi-statement batch', async () => {
    const result1 = makeResultSet({
      columns: [],
      rows: [],
      command: 'SET',
    });
    const result2 = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [['x', 'a', 7]],
    });
    const { conn } = makeMockConn({ results: [result1, result2] });
    const ctx = makeCtx(
      settingsWithConn(conn),
      "SET search_path='public'; SELECT v,h,d FROM t",
      '',
    );
    const r = await cmdCrosstabview.run(ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdoutChunks.join('');
    expect(out).toMatch(/x\s+\|\s+7/);
  });
});
