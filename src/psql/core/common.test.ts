/**
 * Tests for `core/common.ts` — AUTOCOMMIT, ON_ERROR_ROLLBACK, FETCH_COUNT,
 * SINGLESTEP, and timing behaviour around the unified send-query path.
 *
 * Strategy: build a mock `Connection` whose `execSimple` records every SQL
 * string it sees and, optionally, drives `txStatus` transitions based on the
 * verb (so AUTOCOMMIT / savepoint flows can be observed end-to-end).
 */

import { Readable, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';

import type {
  Connection,
  FieldDescription,
  ResultSet,
} from '../types/connection.js';
import type { BackslashRegistry } from '../types/backslash.js';
import type { REPLContext } from '../types/repl.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from './variables.js';
import { defaultSettings } from './settings.js';
import { createCondStack } from '../command/cmd_cond.js';
import {
  refreshErrorVars,
  sendQuery,
  executeAndPrint,
  psqlExec,
} from './common.js';

// ---------------------------------------------------------------------------
// Mock Connection. Tracks calls in order; updates txStatus based on the
// verb so AUTOCOMMIT / savepoint flows behave realistically.
// ---------------------------------------------------------------------------

type Canned = ResultSet[] | (() => ResultSet[]) | Error;

type MockConn = Connection & {
  calls: string[];
  txStatus: 'I' | 'T' | 'E';
};

const buildResultSet = (
  cmd: string,
  fields: { name: string }[],
  rows: unknown[][],
): ResultSet => ({
  command: cmd,
  rowCount: rows.length,
  oid: null,
  fields: fields.map(
    (f): FieldDescription => ({
      name: f.name,
      tableID: 0,
      columnID: 0,
      dataTypeID: 25,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: 0,
    }),
  ),
  rows,
  notices: [],
});

const emptyResult = (cmd: string): ResultSet => buildResultSet(cmd, [], []);

const makeMockConn = (canned: Map<string, Canned> = new Map()): MockConn => {
  const calls: string[] = [];
  const conn = {
    serverVersion: 170000,
    calls,
    txStatus: 'I' as 'I' | 'T' | 'E',
    parameterStatus: (): string | undefined => undefined,
    query: () => Promise.reject(new Error('not implemented')),
    execSimple(sql: string): Promise<ResultSet[]> {
      const trimmed = sql.trim();
      calls.push(trimmed);
      // Track transaction status transitions for AUTOCOMMIT/SAVEPOINT tests.
      const verb = trimmed.split(/\s+/u, 1)[0].toUpperCase();
      if (verb === 'BEGIN' || verb === 'START') conn.txStatus = 'T';
      else if (verb === 'COMMIT' || verb === 'ROLLBACK' || verb === 'END')
        conn.txStatus = 'I';
      // CLOSE / FETCH / DECLARE / SAVEPOINT / RELEASE leave us inside the
      // transaction.

      const lookup = canned.get(trimmed);
      if (lookup === undefined) {
        // Default: return a SELECT result with one row.
        if (
          verb === 'SELECT' ||
          verb === 'WITH' ||
          verb === 'VALUES' ||
          verb === 'TABLE'
        ) {
          return Promise.resolve([
            buildResultSet('SELECT', [{ name: '?column?' }], [[1]]),
          ]);
        }
        if (verb === 'FETCH') {
          // Return an empty fetch by default — overridden via canned where
          // chunking tests want data.
          return Promise.resolve([
            buildResultSet('FETCH', [{ name: '?column?' }], []),
          ]);
        }
        return Promise.resolve([emptyResult(verb || 'OK')]);
      }
      if (lookup instanceof Error) return Promise.reject(lookup);
      const result = typeof lookup === 'function' ? lookup() : lookup;
      return Promise.resolve(result);
    },
    prepare: () => Promise.reject(new Error('not implemented')),
    startCopyIn: () => Promise.reject(new Error('not implemented')),
    startCopyOut: () => Promise.reject(new Error('not implemented')),
    pipeline: () => {
      throw new Error('not implemented');
    },
    cancel: (): Promise<void> => Promise.resolve(),
    escapeIdentifier: (v: string) => `"${v}"`,
    escapeLiteral: (v: string) => `'${v}'`,
    onNotice: (): (() => void) => () => undefined,
    onNotification: (): (() => void) => () => undefined,
    close: () => Promise.resolve(),
    isClosed: () => false,
  };
  return conn as unknown as MockConn;
};

const makeBuffer = (): NodeJS.WritableStream & { text(): string } => {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    },
  });
  (w as unknown as { text: () => string }).text = (): string =>
    Buffer.concat(chunks).toString('utf8');
  return w as unknown as NodeJS.WritableStream & { text(): string };
};

const makeRegistry = (): BackslashRegistry => {
  const map = new Map();
  return {
    register: (spec): void => {
      map.set(spec.name, spec);
    },
    lookup: (name) => map.get(name),
    all: () => map.values(),
  };
};

type CtxOpts = {
  canned?: Map<string, Canned>;
  noConnection?: boolean;
  settingsOverride?: (s: PsqlSettings) => void;
  stdinLines?: string[];
};

const buildCtxWithBuffers = (
  opts: CtxOpts = {},
): {
  ctx: REPLContext;
  stdout: ReturnType<typeof makeBuffer>;
  stderr: ReturnType<typeof makeBuffer>;
  db: MockConn | null;
} => {
  const vars = createVarStore();
  const settings = defaultSettings(vars);
  settings.notty = true;
  const db = opts.noConnection ? null : makeMockConn(opts.canned);
  settings.db = db;
  opts.settingsOverride?.(settings);
  const stdin = Readable.from((opts.stdinLines ?? []).map((l) => l + '\n'));
  const stdout = makeBuffer();
  const stderr = makeBuffer();
  return {
    ctx: {
      settings,
      registry: makeRegistry(),
      cond: createCondStack(),
      stdin,
      stdout,
      stderr,
    } as REPLContext,
    stdout,
    stderr,
    db,
  };
};

// ---------------------------------------------------------------------------
// AUTOCOMMIT
// ---------------------------------------------------------------------------

describe('sendQuery — AUTOCOMMIT', () => {
  test('AUTOCOMMIT=off issues BEGIN before first DML', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
      },
    });
    const stats = await sendQuery(ctx, 'SELECT 1;');
    expect(stats.hadError).toBe(false);
    expect(db?.calls).toEqual(['BEGIN', 'SELECT 1;']);
  });

  test('AUTOCOMMIT=off skips BEGIN for transaction-control verbs', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
      },
    });
    await sendQuery(ctx, 'BEGIN;');
    expect(db?.calls).toEqual(['BEGIN;']);
  });

  test('AUTOCOMMIT=on issues no BEGIN', async () => {
    const { ctx, db } = buildCtxWithBuffers();
    await sendQuery(ctx, 'SELECT 1;');
    expect(db?.calls).toEqual(['SELECT 1;']);
  });

  test('AUTOCOMMIT=off does not double-BEGIN once inside a transaction', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
      },
    });
    // First statement opens the implicit transaction; the mock flips
    // txStatus -> 'T' on BEGIN.
    await sendQuery(ctx, 'SELECT 1;');
    await sendQuery(ctx, 'SELECT 2;');
    expect(db?.calls).toEqual(['BEGIN', 'SELECT 1;', 'SELECT 2;']);
  });
});

// ---------------------------------------------------------------------------
// ON_ERROR_ROLLBACK
// ---------------------------------------------------------------------------

describe('sendQuery — ON_ERROR_ROLLBACK', () => {
  test('on success: SAVEPOINT issued and RELEASE on success', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
        s.vars.set('ON_ERROR_ROLLBACK', 'on');
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    await sendQuery(ctx, 'SELECT 2;');
    // After the implicit BEGIN the connection is in 'T', so every
    // subsequent statement (including the first SELECT *after* the BEGIN)
    // gets a SAVEPOINT/RELEASE pair.
    expect(db?.calls).toEqual([
      'BEGIN',
      'SAVEPOINT pg_psql_temporary_savepoint',
      'SELECT 1;',
      'RELEASE SAVEPOINT pg_psql_temporary_savepoint',
      'SAVEPOINT pg_psql_temporary_savepoint',
      'SELECT 2;',
      'RELEASE SAVEPOINT pg_psql_temporary_savepoint',
    ]);
  });

  test('on error: ROLLBACK TO + RELEASE', async () => {
    const canned = new Map<string, Canned>([
      ['SELECT bad;', new Error('syntax error')],
    ]);
    const { ctx, db } = buildCtxWithBuffers({
      canned,
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
        s.vars.set('ON_ERROR_ROLLBACK', 'on');
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    await sendQuery(ctx, 'SELECT bad;');
    expect(db?.calls).toEqual([
      'BEGIN',
      'SAVEPOINT pg_psql_temporary_savepoint',
      'SELECT 1;',
      'RELEASE SAVEPOINT pg_psql_temporary_savepoint',
      'SAVEPOINT pg_psql_temporary_savepoint',
      'SELECT bad;',
      'ROLLBACK TO SAVEPOINT pg_psql_temporary_savepoint',
      'RELEASE SAVEPOINT pg_psql_temporary_savepoint',
    ]);
  });

  test('off: no SAVEPOINT', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    await sendQuery(ctx, 'SELECT 2;');
    expect(db?.calls).toEqual(['BEGIN', 'SELECT 1;', 'SELECT 2;']);
  });

  test('interactive: only fires when notty is false', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
        s.vars.set('ON_ERROR_ROLLBACK', 'interactive');
        s.notty = true;
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    await sendQuery(ctx, 'SELECT 2;');
    // notty=true means non-interactive — savepoints disabled.
    expect(db?.calls).toEqual(['BEGIN', 'SELECT 1;', 'SELECT 2;']);
  });

  test('skip RELEASE when user issues COMMIT (svpt_gone)', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
        s.vars.set('ON_ERROR_ROLLBACK', 'on');
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    await sendQuery(ctx, 'COMMIT;');
    expect(db?.calls).toEqual([
      'BEGIN',
      'SAVEPOINT pg_psql_temporary_savepoint',
      'SELECT 1;',
      'RELEASE SAVEPOINT pg_psql_temporary_savepoint',
      'SAVEPOINT pg_psql_temporary_savepoint',
      'COMMIT;',
      // No RELEASE here because COMMIT collapsed the savepoint and the
      // connection is back at txStatus='I'.
    ]);
  });
});

// ---------------------------------------------------------------------------
// FETCH_COUNT
// ---------------------------------------------------------------------------

describe('sendQuery — FETCH_COUNT', () => {
  test('FETCH_COUNT>0 on SELECT wraps in DECLARE CURSOR + FETCH FORWARD', async () => {
    const fetchResults = new Map<string, Canned>([
      [
        'FETCH FORWARD 2 FROM _psql_cursor',
        // First chunk: 2 rows; second chunk: 0 rows (loop exits).
        (() => {
          let call = 0;
          return () => {
            call += 1;
            return [
              buildResultSet(
                'FETCH',
                [{ name: '?column?' }],
                call === 1 ? [[1], [2]] : [],
              ),
            ];
          };
        })(),
      ],
    ]);
    const { ctx, db } = buildCtxWithBuffers({
      canned: fetchResults,
      settingsOverride: (s) => {
        s.vars.set('FETCH_COUNT', '2');
      },
    });
    const stats = await sendQuery(ctx, 'SELECT * FROM t;');
    expect(stats.fetched).toBe(true);
    expect(stats.hadError).toBe(false);
    // We expect BEGIN (from cursor loop, because we were idle), DECLARE,
    // at least one FETCH, CLOSE, COMMIT.
    expect(db?.calls.slice(0, 2)).toEqual([
      'BEGIN',
      'DECLARE _psql_cursor NO SCROLL CURSOR FOR SELECT * FROM t',
    ]);
    expect(db?.calls).toContain('FETCH FORWARD 2 FROM _psql_cursor');
    expect(db?.calls).toContain('CLOSE _psql_cursor');
    expect(db?.calls).toContain('COMMIT');
  });

  test('FETCH_COUNT>0 on non-SELECT falls back to simple path', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('FETCH_COUNT', '5');
      },
    });
    await sendQuery(ctx, 'INSERT INTO t VALUES (1);');
    expect(db?.calls).toEqual(['INSERT INTO t VALUES (1);']);
  });

  test('FETCH_COUNT=0 disables chunking', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('FETCH_COUNT', '0');
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    expect(db?.calls).toEqual(['SELECT 1;']);
  });

  test('DECLARE failure: lastErrorResult.sqlText is the user query, position rebased into user-sql coords', async () => {
    // The user typed `SELECT error;`. Our wrapper sends
    // `DECLARE _psql_cursor NO SCROLL CURSOR FOR SELECT error`, which the
    // server rejects with a position pointing into the DECLARE statement
    // (at the `error` token — column 49 = 1-based offset of `error` inside
    // `DECLARE _psql_cursor NO SCROLL CURSOR FOR SELECT error`). The
    // catch path inside `runCursorLoop` must rebase that position back
    // into the user's `SELECT error;` coordinates so `\errverbose` can
    // render `LINE 1: SELECT error;` with the caret under `error`.
    const declaredSql =
      'DECLARE _psql_cursor NO SCROLL CURSOR FOR SELECT error';
    // 1-based position of `e` (start of `error`) inside the DECLARE form.
    const errorTokenPosInDeclare = declaredSql.indexOf('error') + 1;
    const err = Object.assign(new Error('column "error" does not exist'), {
      severity: 'ERROR',
      code: '42703',
      position: String(errorTokenPosInDeclare),
    });
    const canned = new Map<string, Canned>([[declaredSql, err]]);
    const { ctx, stderr } = buildCtxWithBuffers({
      canned,
      settingsOverride: (s) => {
        s.vars.set('FETCH_COUNT', '1');
      },
    });
    const stats = await sendQuery(ctx, 'SELECT error;');
    expect(stats.hadError).toBe(true);

    // sqlText must be the user's original SQL so the LINE re-print picks
    // up `SELECT error;` and not the synthetic DECLARE form.
    expect(ctx.settings.lastErrorResult?.sqlText).toBe('SELECT error;');
    expect(ctx.settings.lastErrorResult?.message).toContain(
      'column "error" does not exist',
    );
    // Position must have been rebased from the DECLARE coords into the
    // user's `SELECT error;` coords — `error` starts at column 8.
    expect(ctx.settings.lastErrorResult?.position).toBe('8');

    // Default-verbosity rendering: severity line + LINE/caret. The caret
    // sits exactly 7 spaces past the `LINE 1: ` prefix (column 8 - 1).
    const text = stderr.text();
    expect(text).toContain('LINE 1: SELECT error;');
    expect(text).toMatch(/^ {8} {7}\^$/m);
  });

  test('DECLARE failure: position outside the user SQL is stripped so caret is not mis-pointed', async () => {
    // If the server reports a position somewhere inside the DECLARE
    // prefix (e.g. column 5 = `LARE` token — impossible in practice but
    // pessimistic about server behaviour), rebasing produces a value <=
    // 0. We must drop the field rather than render a caret that lands
    // outside `userSql`.
    const declaredSql = 'DECLARE _psql_cursor NO SCROLL CURSOR FOR SELECT x';
    const err = Object.assign(new Error('parser confusion'), {
      severity: 'ERROR',
      code: '42601',
      position: '5', // inside the DECLARE keyword
    });
    const canned = new Map<string, Canned>([[declaredSql, err]]);
    const { ctx } = buildCtxWithBuffers({
      canned,
      settingsOverride: (s) => {
        s.vars.set('FETCH_COUNT', '1');
      },
    });
    await sendQuery(ctx, 'SELECT x;');
    expect(ctx.settings.lastErrorResult?.sqlText).toBe('SELECT x;');
    expect(ctx.settings.lastErrorResult?.position).toBeUndefined();
  });

  test('FETCH_COUNT after a prior backslash line: sqlText trimmed and LINE counter starts at 1', async () => {
    // Our mainloop carries a `\n` over from prior backslash-only lines
    // (upstream's mainloop.c strips that; ours doesn't — yet). So the SQL
    // passed in here looks like `\nSELECT error;`. We sent
    // `DECLARE _psql_cursor NO SCROLL CURSOR FOR \nSELECT error` to the
    // server; the position points at the `error` token inside the wrapper.
    // After capture, `lastErrorResult.sqlText` must be the trimmed form
    // (`SELECT error;`) so `\errverbose` renders `LINE 1: SELECT error;`
    // — matching upstream where the blank line is invisible.
    const declaredSql =
      'DECLARE _psql_cursor NO SCROLL CURSOR FOR \nSELECT error';
    const errorTokenPosInDeclare = declaredSql.indexOf('error') + 1;
    const err = Object.assign(new Error('column "error" does not exist'), {
      severity: 'ERROR',
      code: '42703',
      position: String(errorTokenPosInDeclare),
    });
    const canned = new Map<string, Canned>([[declaredSql.trim(), err]]);
    const { ctx, stderr } = buildCtxWithBuffers({
      canned,
      settingsOverride: (s) => {
        s.vars.set('FETCH_COUNT', '1');
      },
    });
    await sendQuery(ctx, '\nSELECT error;');

    // Leading `\n` stripped; LINE 1 renders against `SELECT error;`.
    expect(ctx.settings.lastErrorResult?.sqlText).toBe('SELECT error;');
    expect(ctx.settings.lastErrorResult?.position).toBe('8');
    const text = stderr.text();
    expect(text).toContain('LINE 1: SELECT error;');
    expect(text).not.toContain('LINE 2:');
  });
});

// ---------------------------------------------------------------------------
// SINGLESTEP
// ---------------------------------------------------------------------------

describe('sendQuery — SINGLESTEP', () => {
  test('prompts on stderr and executes on empty line', async () => {
    const { ctx, db, stderr } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.singlestep = true;
      },
      stdinLines: [''],
    });
    const stats = await sendQuery(ctx, 'SELECT 1;');
    expect(stats.hadError).toBe(false);
    expect(db?.calls).toEqual(['SELECT 1;']);
    expect(stderr.text()).toContain('Single step mode: verify command');
    expect(stderr.text()).toContain('SELECT 1;');
  });

  test("'x' on the prompt cancels the statement", async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.singlestep = true;
      },
      stdinLines: ['x'],
    });
    const stats = await sendQuery(ctx, 'SELECT 1;');
    expect(stats.hadError).toBe(true);
    expect(db?.calls).toEqual([]);
    expect(ctx.settings.lastErrorResult?.message).toMatch(/cancelled/);
  });
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

describe('sendQuery — \\timing', () => {
  test('emits Time: line on stdout when timing is on', async () => {
    const { ctx, stdout } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.timing = true;
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    expect(stdout.text()).toMatch(/^Time: \d+\.\d{3} ms$/m);
  });

  test('no Time: line when timing is off', async () => {
    const { ctx, stdout } = buildCtxWithBuffers();
    await sendQuery(ctx, 'SELECT 1;');
    expect(stdout.text()).not.toMatch(/^Time: /m);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('sendQuery — errors', () => {
  test('hadError true on server failure', async () => {
    const canned = new Map<string, Canned>([
      ['SELECT bad;', new Error('boom')],
    ]);
    const { ctx, stderr } = buildCtxWithBuffers({ canned });
    const stats = await sendQuery(ctx, 'SELECT bad;');
    expect(stats.hadError).toBe(true);
    expect(stderr.text()).toMatch(/boom/);
    expect(ctx.settings.lastErrorResult?.message).toBe('boom');
  });

  test('no connection: returns hadError without crashing', async () => {
    const { ctx, stderr } = buildCtxWithBuffers({ noConnection: true });
    const stats = await sendQuery(ctx, 'SELECT 1;');
    expect(stats.hadError).toBe(true);
    expect(stderr.text()).toMatch(/no connection to the server/);
  });

  test('server error renders the layered form (psql: prefix, LINE / caret on default verbosity)', async () => {
    // Build a throwable that carries the full ErrorResponse shape — this
    // mirrors what `asThrowable` in wire/connection.ts produces.
    const err = Object.assign(new Error('syntax error at or near "FOO"'), {
      severity: 'ERROR',
      code: '42601',
      detail: 'parse failed',
      hint: 'check spelling',
      position: '8',
    });
    const canned = new Map<string, Canned>([['SELECT FOO FROM bar;', err]]);
    const { ctx, stderr } = buildCtxWithBuffers({ canned });
    await sendQuery(ctx, 'SELECT FOO FROM bar;');
    const text = stderr.text();
    expect(text).toContain('ERROR:  syntax error at or near "FOO"');
    // Default verbosity hides the SQLSTATE on the severity line.
    expect(text).not.toMatch(/^ERROR: {2}42601:/m);
    expect(text).toContain('LINE 1: SELECT FOO FROM bar;');
    expect(text).toMatch(/^\s+\^$/m);
    expect(text).toContain('DETAIL:  parse failed');
    expect(text).toContain('HINT:  check spelling');
    // No `psql:` diagnostic prefix when reading from stdin (the default
    // `curCmdSource` in the mock). Upstream `psql_log_pre_callback` only
    // emits `psql:<file>:<line>: ` when `cur_cmd_source == QUERY_FROM_FILE`
    // (i.e. `-f FILE` / `\i FILE`); the regress harness drives via stdin
    // pipe so the expected `.out` shape is the bare `ERROR:` line.
    expect(text).toMatch(/^ERROR: {2}syntax error at or near "FOO"$/m);
    expect(text).not.toMatch(/^psql:/m);
  });

  test('verbose verbosity exposes the SQLSTATE on the severity line', async () => {
    const err = Object.assign(new Error('boom'), {
      severity: 'ERROR',
      code: '42P01',
    });
    const canned = new Map<string, Canned>([['SELECT bad;', err]]);
    const { ctx, stderr } = buildCtxWithBuffers({
      canned,
      settingsOverride: (s) => {
        s.verbosity = 'verbose';
      },
    });
    await sendQuery(ctx, 'SELECT bad;');
    expect(stderr.text()).toContain('ERROR:  42P01: boom');
  });

  test('terse verbosity prints only the severity line', async () => {
    const err = Object.assign(new Error('boom'), {
      severity: 'ERROR',
      code: '42P01',
      detail: 'gone',
      hint: 'use IF NOT EXISTS',
    });
    const canned = new Map<string, Canned>([['SELECT bad;', err]]);
    const { ctx, stderr } = buildCtxWithBuffers({
      canned,
      settingsOverride: (s) => {
        s.verbosity = 'terse';
      },
    });
    await sendQuery(ctx, 'SELECT bad;');
    const text = stderr.text();
    expect(text).toContain('ERROR:  boom');
    expect(text).not.toContain('DETAIL');
    expect(text).not.toContain('HINT');
  });
});

// ---------------------------------------------------------------------------
// refreshErrorVars — built-in :SQLSTATE / :ERROR / :LAST_ERROR_* /
// :ROW_COUNT psql variables refreshed at the tail of sendQuery /
// executeAndPrint. Mirrors upstream `SetResultVariables`.
// ---------------------------------------------------------------------------

describe('refreshErrorVars', () => {
  test('success path: SQLSTATE=00000, ERROR=false, ROW_COUNT mirrors rs.rowCount', () => {
    const vars = createVarStore();
    const settings = defaultSettings(vars);
    refreshErrorVars(settings, { kind: 'success', rowCount: 5 });
    expect(vars.get('SQLSTATE')).toBe('00000');
    expect(vars.get('ERROR')).toBe('false');
    expect(vars.get('ROW_COUNT')).toBe('5');
  });

  test('success with null rowCount falls back to "0"', () => {
    const vars = createVarStore();
    const settings = defaultSettings(vars);
    refreshErrorVars(settings, { kind: 'success', rowCount: null });
    expect(vars.get('ROW_COUNT')).toBe('0');
  });

  test('error path: LAST_ERROR_*, SQLSTATE mirror lastErrorResult; ROW_COUNT=0', () => {
    const vars = createVarStore();
    const settings = defaultSettings(vars);
    settings.lastErrorResult = {
      severity: 'ERROR',
      code: '22012',
      message: 'division by zero',
    };
    refreshErrorVars(settings, { kind: 'error' });
    expect(vars.get('LAST_ERROR_MESSAGE')).toBe('division by zero');
    expect(vars.get('LAST_ERROR_SQLSTATE')).toBe('22012');
    expect(vars.get('SQLSTATE')).toBe('22012');
    expect(vars.get('ERROR')).toBe('true');
    expect(vars.get('ROW_COUNT')).toBe('0');
  });

  test('error path with no lastErrorResult falls back to XX000', () => {
    const vars = createVarStore();
    const settings = defaultSettings(vars);
    settings.lastErrorResult = null;
    refreshErrorVars(settings, { kind: 'error' });
    expect(vars.get('LAST_ERROR_SQLSTATE')).toBe('XX000');
    expect(vars.get('SQLSTATE')).toBe('XX000');
    expect(vars.get('ERROR')).toBe('true');
  });

  test('LAST_ERROR_* are sticky across a subsequent success', () => {
    const vars = createVarStore();
    const settings = defaultSettings(vars);
    settings.lastErrorResult = {
      code: '22012',
      message: 'division by zero',
    };
    refreshErrorVars(settings, { kind: 'error' });
    expect(vars.get('LAST_ERROR_MESSAGE')).toBe('division by zero');
    // The next statement succeeds: LAST_ERROR_* must be preserved.
    refreshErrorVars(settings, { kind: 'success', rowCount: 1 });
    expect(vars.get('LAST_ERROR_MESSAGE')).toBe('division by zero');
    expect(vars.get('LAST_ERROR_SQLSTATE')).toBe('22012');
    expect(vars.get('SQLSTATE')).toBe('00000');
    expect(vars.get('ERROR')).toBe('false');
    expect(vars.get('ROW_COUNT')).toBe('1');
  });
});

describe('sendQuery — built-in :SQLSTATE / :ERROR / :ROW_COUNT vars', () => {
  test('successful SELECT sets ROW_COUNT to rows returned', async () => {
    const { ctx } = buildCtxWithBuffers();
    await sendQuery(ctx, 'SELECT 1;');
    expect(ctx.settings.vars.get('SQLSTATE')).toBe('00000');
    expect(ctx.settings.vars.get('ERROR')).toBe('false');
    expect(ctx.settings.vars.get('ROW_COUNT')).toBe('1');
  });

  test('error sets LAST_ERROR_*, SQLSTATE, ERROR=true, ROW_COUNT=0', async () => {
    const err = Object.assign(new Error('division by zero'), {
      severity: 'ERROR',
      code: '22012',
    });
    const canned = new Map<string, Canned>([['SELECT 1/0;', err]]);
    const { ctx } = buildCtxWithBuffers({ canned });
    await sendQuery(ctx, 'SELECT 1/0;');
    expect(ctx.settings.vars.get('LAST_ERROR_MESSAGE')).toBe(
      'division by zero',
    );
    expect(ctx.settings.vars.get('LAST_ERROR_SQLSTATE')).toBe('22012');
    expect(ctx.settings.vars.get('SQLSTATE')).toBe('22012');
    expect(ctx.settings.vars.get('ERROR')).toBe('true');
    expect(ctx.settings.vars.get('ROW_COUNT')).toBe('0');
  });

  test('LAST_ERROR_* survive a subsequent successful statement', async () => {
    const err = Object.assign(new Error('boom'), {
      severity: 'ERROR',
      code: '22012',
    });
    const canned = new Map<string, Canned>([['SELECT bad;', err]]);
    const { ctx } = buildCtxWithBuffers({ canned });
    await sendQuery(ctx, 'SELECT bad;');
    await sendQuery(ctx, 'SELECT 1;');
    expect(ctx.settings.vars.get('LAST_ERROR_MESSAGE')).toBe('boom');
    expect(ctx.settings.vars.get('LAST_ERROR_SQLSTATE')).toBe('22012');
    expect(ctx.settings.vars.get('SQLSTATE')).toBe('00000');
    expect(ctx.settings.vars.get('ERROR')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// executeAndPrint — bypasses AUTOCOMMIT/savepoint scaffolding
// ---------------------------------------------------------------------------

describe('executeAndPrint', () => {
  test('does not issue BEGIN even with AUTOCOMMIT=off', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('AUTOCOMMIT', 'off');
        s.vars.set('ON_ERROR_ROLLBACK', 'on');
      },
    });
    await executeAndPrint(ctx, 'SELECT 1;');
    expect(db?.calls).toEqual(['SELECT 1;']);
  });

  test('still honours FETCH_COUNT', async () => {
    const { ctx, db } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('FETCH_COUNT', '10');
      },
    });
    await executeAndPrint(ctx, 'SELECT * FROM t;');
    expect(db?.calls).toContain(
      'DECLARE _psql_cursor NO SCROLL CURSOR FOR SELECT * FROM t',
    );
  });
});

// ---------------------------------------------------------------------------
// psqlExec
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SHOW_ALL_RESULTS
// ---------------------------------------------------------------------------

describe('sendQuery — SHOW_ALL_RESULTS', () => {
  const twoResults = new Map<string, Canned>([
    [
      "SELECT 'four' ; SELECT 'five';",
      [
        buildResultSet('SELECT', [{ name: '?column?' }], [['four']]),
        buildResultSet('SELECT', [{ name: '?column?' }], [['five']]),
      ],
    ],
  ]);

  test('default (on): every \\;-separated result is printed', async () => {
    const { ctx, stdout } = buildCtxWithBuffers({ canned: twoResults });
    const stats = await sendQuery(ctx, "SELECT 'four' ; SELECT 'five';");
    expect(stats.hadError).toBe(false);
    expect(stdout.text()).toMatch(/four/);
    expect(stdout.text()).toMatch(/five/);
  });

  test('off (0): only the LAST result is printed', async () => {
    const { ctx, stdout } = buildCtxWithBuffers({
      canned: twoResults,
      settingsOverride: (s) => {
        s.vars.set('SHOW_ALL_RESULTS', '0');
      },
    });
    const stats = await sendQuery(ctx, "SELECT 'four' ; SELECT 'five';");
    expect(stats.hadError).toBe(false);
    expect(stdout.text()).toMatch(/five/);
    expect(stdout.text()).not.toMatch(/four/);
  });

  test('off (off literal): only the LAST result is printed', async () => {
    const { ctx, stdout } = buildCtxWithBuffers({
      canned: twoResults,
      settingsOverride: (s) => {
        s.vars.set('SHOW_ALL_RESULTS', 'off');
      },
    });
    await sendQuery(ctx, "SELECT 'four' ; SELECT 'five';");
    expect(stdout.text()).toMatch(/five/);
    expect(stdout.text()).not.toMatch(/four/);
  });

  test('off with a single result still prints that result', async () => {
    const { ctx, stdout } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.vars.set('SHOW_ALL_RESULTS', '0');
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    // Stdout should contain the mock SELECT output (default ?column? = 1).
    expect(stdout.text()).toMatch(/1/);
  });
});

describe('psqlExec', () => {
  test('returns the last ResultSet on success', async () => {
    const db = makeMockConn();
    const rs = await psqlExec(db, 'SELECT 1');
    expect(rs).not.toBeNull();
    expect(rs?.command).toBe('SELECT');
  });

  test('returns null when ignoreError is true and the call throws', async () => {
    const canned = new Map<string, Canned>([['SELECT bad', new Error('boom')]]);
    const db = makeMockConn(canned);
    const rs = await psqlExec(db, 'SELECT bad', true);
    expect(rs).toBeNull();
  });

  test('throws when ignoreError is false', async () => {
    const canned = new Map<string, Canned>([['SELECT bad', new Error('boom')]]);
    const db = makeMockConn(canned);
    await expect(psqlExec(db, 'SELECT bad', false)).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// Pager integration. We don't fork an actual pager here — the routing into
// `shouldPage` / `openPager` lives in `renderResultSets`. Instead these tests
// verify the WIRED-IN decision logic by inspecting whether the printer
// touched the configured output stream:
//
//   - `popt.pager = 'off'`         → printer writes to `stdout`.
//   - `popt.pager = 'on'` on a non-TTY stream → printer writes to `stdout`
//     (auto-mode pager skips because of the TTY guard).
//   - `\o FILE` redirect → output never reaches stdout, regardless of pager.
//
// The "spawn an actual pager" path is exercised by `print/pager.test.ts`
// against the real PAGER=cat plumbing. NOTE: we intentionally do NOT test
// `pager: 'always'` here because it is now a force-on override that bypasses
// the TTY guard and would actually spawn a pager subprocess (verified in
// the integration spec tests/psql-conformance/tap/030_pager.spec.ts).
// ---------------------------------------------------------------------------

describe('sendQuery — pager wiring', () => {
  test("pager: 'off' lets output reach stdout unchanged", async () => {
    const { ctx, stdout } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.popt.topt.pager = 'off';
      },
    });
    await sendQuery(ctx, 'SELECT 1;');
    expect(stdout.text()).toContain('?column?');
  });

  test("pager: 'on' (auto) on a non-TTY stream falls back to stdout (no pager spawn)", async () => {
    const { ctx, stdout } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.popt.topt.pager = 'on';
      },
    });
    // The buffer isn't a TTY; shouldPage should bail under auto mode and the
    // printer should write directly to it.
    await sendQuery(ctx, 'SELECT 1;');
    expect(stdout.text()).toContain('?column?');
  });

  test('\\o-redirected output bypasses the pager regardless of pager setting', async () => {
    const { ctx, stdout } = buildCtxWithBuffers({
      settingsOverride: (s) => {
        s.popt.topt.pager = 'always';
      },
    });
    // Simulate `\o FILE` by stashing a queryFout sink — pickPagerDecision
    // must see this and refuse to page.
    const redirected = makeBuffer();
    const QUERY_FOUT_KEY = Symbol.for('neonctl.psql.queryFout');
    (ctx.settings as unknown as Record<symbol, unknown>)[QUERY_FOUT_KEY] = {
      stream: redirected,
      kind: 'pipe',
    };
    await sendQuery(ctx, 'SELECT 1;');
    // The redirect stream got the output; the main stdout did not.
    expect(redirected.text()).toContain('?column?');
    expect(stdout.text()).not.toContain('?column?');
  });
});
