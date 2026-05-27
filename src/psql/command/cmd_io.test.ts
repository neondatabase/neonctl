import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { BackslashCmdSpec, BackslashContext } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import type {
  Connection,
  FieldDescription,
  ResultSet,
} from '../types/connection.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  WATCH_TEST_CONTROLLER,
  cmdG,
  cmdGdesc,
  cmdGexec,
  cmdGset,
  cmdGx,
  cmdInclude,
  cmdOut,
  cmdWatch,
  cmdWrite,
  getQueryFout,
} from './cmd_io.js';
import {
  reset as resetInputQueue,
  size as inputQueueSize,
} from './inputQueue.js';

// ---------------------------------------------------------------------------
// Mock context factory — naive whitespace tokenisation with single-quote
// support, identical in spirit to the cmd_format/cmd_meta test factories.
// ---------------------------------------------------------------------------

const makeMockCtx = (
  cmdName: string,
  rawArgs: string,
  settings: PsqlSettings,
  queryBuf = '',
): BackslashContext => {
  let cursor = 0;
  return {
    settings,
    cmdName,
    queryBuf,
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

// ---------------------------------------------------------------------------
// stdout/stderr capture (the meta/format suites use the same pattern).
// ---------------------------------------------------------------------------

let stdoutChunks: string[];
let stderrChunks: string[];
let stdoutOrig: typeof process.stdout.write;
let stderrOrig: typeof process.stderr.write;

// Capture the host PAGER / PSQL_WATCH_PAGER values once so we can restore
// them after each test. The `\watch` pager hook reads those env vars
// directly; if the user runs the suite with `PAGER=less` (the typical
// shell default) the watch loop would otherwise hijack stdout into a
// subprocess and the captured-stdout assertions would see an empty
// string. We unset both per-test so tests that want pager behaviour
// must opt in explicitly.
let priorPager: string | undefined;
let priorWatchPager: string | undefined;

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
  priorPager = process.env.PAGER;
  priorWatchPager = process.env.PSQL_WATCH_PAGER;
  delete process.env.PAGER;
  delete process.env.PSQL_WATCH_PAGER;
});

afterEach(() => {
  process.stdout.write = stdoutOrig;
  process.stderr.write = stderrOrig;
  resetInputQueue();
  WATCH_TEST_CONTROLLER.ref = null;
  if (priorPager !== undefined) process.env.PAGER = priorPager;
  else delete process.env.PAGER;
  if (priorWatchPager !== undefined) {
    process.env.PSQL_WATCH_PAGER = priorWatchPager;
  } else {
    delete process.env.PSQL_WATCH_PAGER;
  }
});

const stderr = (): string => stderrChunks.join('');
const stdout = (): string => stdoutChunks.join('');
const run = (spec: BackslashCmdSpec, ctx: BackslashContext) => spec.run(ctx);

// ---------------------------------------------------------------------------
// Mock Connection. Returns canned ResultSets per script.
// ---------------------------------------------------------------------------

type MockConn = Connection & {
  /** SQL strings observed in order. */
  history: string[];
  /** Function the test sets to drive replies. */
  reply: (sql: string) => ResultSet[] | Promise<ResultSet[]>;
};

const field = (name: string): FieldDescription => ({
  name,
  tableID: 0,
  columnID: 0,
  dataTypeID: 25, // text
  dataTypeSize: -1,
  dataTypeModifier: -1,
  format: 0,
});

const rs = (
  fields: string[],
  rows: unknown[][],
  command = 'SELECT',
): ResultSet => ({
  command,
  rowCount: rows.length,
  oid: null,
  fields: fields.map(field),
  rows,
  notices: [],
});

const makeMockConn = (): MockConn => {
  const history: string[] = [];
  const conn: MockConn = {
    serverVersion: 170000,
    history,
    reply: () => [],
    parameterStatus: () => undefined,
    query: () => Promise.reject(new Error('not implemented')),
    execSimple: async (sql: string) => {
      history.push(sql);
      const reply = conn.reply(sql);
      return reply instanceof Promise ? reply : Promise.resolve(reply);
    },
    prepare: () => Promise.reject(new Error('not implemented')),
    startCopyIn: () => Promise.reject(new Error('not implemented')),
    startCopyOut: () => Promise.reject(new Error('not implemented')),
    pipeline: () => {
      throw new Error('not implemented');
    },
    cancel: () => Promise.resolve(),
    escapeIdentifier: (v: string) => `"${v}"`,
    escapeLiteral: (v: string) => `'${v}'`,
    onNotice: () => () => {
      /* no-op */
    },
    onNotification: () => () => {
      /* no-op */
    },
    close: () => Promise.resolve(),
    isClosed: () => false,
  };
  return conn;
};

const makeSettings = (conn?: Connection): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  if (conn) s.db = conn;
  return s;
};

// ---------------------------------------------------------------------------
// Temp dir + small helpers.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psql-cmd-io-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const tmpFile = (name = `f-${randomUUID()}.txt`): string =>
  path.join(tmpDir, name);

// ---------------------------------------------------------------------------
// \w / \write
// ---------------------------------------------------------------------------

describe('\\w / \\write', () => {
  test('writes the current query buffer to FILE', async () => {
    const s = makeSettings();
    const file = tmpFile();
    const ctx = makeMockCtx('w', file, s, 'select 1;\nselect 2;\n');
    const r = await run(cmdWrite, ctx);
    expect(r.status).toBe('ok');
    const written = await fs.readFile(file, 'utf8');
    expect(written).toBe('select 1;\nselect 2;\n');
  });

  test('missing arg yields an error', async () => {
    const s = makeSettings();
    const ctx = makeMockCtx('w', '', s, 'select 1');
    const r = await run(cmdWrite, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/missing required argument/);
  });

  test('pipe form `\\w |cmd` writes through sh -c', async () => {
    const s = makeSettings();
    const sink = tmpFile();
    // Quote-escape via single-quoted arg so the mock scanner reads as one
    // token; the leading `|` puts openWriter into pipe mode.
    const arg = `'|cat > ${sink}'`;
    const ctx = makeMockCtx('w', arg, s, 'hello world\n');
    const r = await run(cmdWrite, ctx);
    expect(r.status).toBe('ok');
    const written = await fs.readFile(sink, 'utf8');
    expect(written).toBe('hello world\n');
  });

  test('pipe form surfaces non-zero exit with wait_result_to_str wording', async () => {
    const s = makeSettings();
    // `false` exits 1. Upstream `exec_command_write` prints
    // `pg_log_error("%s: %s", fname, wait_result_to_str(result))`,
    // which formats wait_result==1 as
    // `child process exited with exit code 1`. The leading `|` is part
    // of `fname` in upstream — we keep it verbatim so the conformance
    // diff is empty.
    const ctx = makeMockCtx('w', `'|false'`, s, 'select 1');
    const r = await run(cmdWrite, ctx);
    expect(r.status).toBe('error');
    // The mock scanner above keeps the `|` glued to `false` because it
    // strips the surrounding quotes; vanilla psql preserves the literal
    // arg the user typed (`| false`). Match on the trailing portion to
    // stay tolerant of either spelling.
    expect(stderr()).toMatch(
      /^\|\s?false: child process exited with exit code 1\n$/,
    );
    // And no `\w:` cmd-prefix — `pg_log_error` writes the bare message
    // under terse mode (the conformance harness setup).
    expect(stderr()).not.toMatch(/\\w:/);
  });

  test('pipe form maps exit 127 to "command not found"', async () => {
    const s = makeSettings();
    // Upstream `wait_result_to_str` special-cases 127/126 to match
    // shell conventions. Our `formatChildWaitResult` mirrors that so
    // `\w | nonexistent-binary` produces the same error wording as
    // vanilla psql.
    const ctx = makeMockCtx(
      'w',
      `'|nonexistent_program_xyz_neonctl'`,
      s,
      'select 1',
    );
    const r = await run(cmdWrite, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/command not found/);
  });

  test('unopenable FILE emits `<path>: No such file or directory` and does not crash', async () => {
    // Regression: a `\w` whose path can't be opened (e.g. an
    // unresolved `:VAR` substitution leaving a literal path) used to
    // crash the whole Node process because `createWriteStream`'s
    // lazy open emitted an unhandled `'error'` event. Now we open
    // synchronously and surface the upstream `<path>: <strerror>`
    // shape so the shim continues with the next command.
    const s = makeSettings();
    const missing = path.join(tmpDir, 'missing-dir', 'no-such.txt');
    const ctx = makeMockCtx('w', missing, s, 'select 1');
    const r = await run(cmdWrite, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe(`${missing}: No such file or directory\n`);
    // No `\w:` prefix — matches vanilla's bare `pg_log_error` shape.
    expect(stderr()).not.toMatch(/\\w:/);
  });
});

// ---------------------------------------------------------------------------
// \o / \out
// ---------------------------------------------------------------------------

describe('\\o / \\out', () => {
  test('FILE: opens a stream and stashes it', async () => {
    const s = makeSettings();
    const file = tmpFile();
    const ctx = makeMockCtx('o', file, s);
    const r = await run(cmdOut, ctx);
    expect(r.status).toBe('ok');
    const stream = getQueryFout(s);
    expect(stream).not.toBeNull();
    // Write something to prove the stream is live, then close via \o.
    stream?.write('hello\n');
    const ctx2 = makeMockCtx('o', '', s);
    const r2 = await run(cmdOut, ctx2);
    expect(r2.status).toBe('ok');
    expect(getQueryFout(s)).toBeNull();
    const contents = await fs.readFile(file, 'utf8');
    expect(contents).toBe('hello\n');
  });

  test('no arg with no prior stream is a no-op', async () => {
    const s = makeSettings();
    const ctx = makeMockCtx('o', '', s);
    const r = await run(cmdOut, ctx);
    expect(r.status).toBe('ok');
    expect(getQueryFout(s)).toBeNull();
  });

  test('rebinding to a new FILE closes the prior stream', async () => {
    const s = makeSettings();
    const file1 = tmpFile('a.txt');
    const file2 = tmpFile('b.txt');
    await run(cmdOut, makeMockCtx('o', file1, s));
    getQueryFout(s)?.write('first\n');
    await run(cmdOut, makeMockCtx('o', file2, s));
    getQueryFout(s)?.write('second\n');
    // Close so flushes complete.
    await run(cmdOut, makeMockCtx('o', '', s));
    expect(await fs.readFile(file1, 'utf8')).toBe('first\n');
    expect(await fs.readFile(file2, 'utf8')).toBe('second\n');
  });

  test('unopenable FILE emits `<path>: No such file or directory` and does not crash', async () => {
    // Regression: synchronous open guard. Without it, `\o /no/such`
    // would crash the process via the WriteStream's lazy `'error'`
    // event.
    const s = makeSettings();
    const missing = path.join(tmpDir, 'missing-dir', 'no-such.txt');
    const ctx = makeMockCtx('o', missing, s);
    const r = await run(cmdOut, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe(`${missing}: No such file or directory\n`);
    // No prior stash should be left behind.
    expect(getQueryFout(s)).toBeNull();
    expect(stderr()).not.toMatch(/\\o:/);
  });
});

// ---------------------------------------------------------------------------
// \g
// ---------------------------------------------------------------------------

describe('\\g', () => {
  test('executes the current buffer against the mock Connection', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['a'], [[1]])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('g', '', s, 'select 1');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('reset-buf');
    expect(conn.history).toEqual(['select 1']);
    expect(stdout()).toMatch(/a/);
  });

  test('routes output to FILE when given', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['name'], [['neon']])];
    const s = makeSettings(conn);
    const file = tmpFile();
    const ctx = makeMockCtx('g', file, s, 'select name from t');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('reset-buf');
    const written = await fs.readFile(file, 'utf8');
    expect(written).toMatch(/neon/);
    // Per-query redirect must NOT leak to the settings stash.
    expect(getQueryFout(s)).toBeNull();
  });

  test('empty buffer is a no-op', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('g', '', s, '   ');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('reset-buf');
    expect(conn.history).toEqual([]);
  });

  test('no connection yields an error', async () => {
    const s = makeSettings();
    const ctx = makeMockCtx('g', '', s, 'select 1');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('error');
  });

  test('pipe form `\\g | cmd` runs the program with rendered output', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['name'], [['neon']])];
    const s = makeSettings(conn);
    const sink = tmpFile();
    // Quote-escape so the mock scanner reads the entire `|cat > sink` as
    // one filepipe token.
    const ctx = makeMockCtx('g', `'|cat > ${sink}'`, s, 'select 1');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('reset-buf');
    const written = await fs.readFile(sink, 'utf8');
    expect(written).toMatch(/neon/);
  });

  test('pipe form is silent when the program exits non-zero', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['a'], [[1]])];
    const s = makeSettings(conn);
    // `false` always exits 1. Upstream `CloseGOutput` only feeds the
    // wait status to SetShellResultVariables (SHELL_ERROR /
    // SHELL_EXIT_CODE) — no `pg_log_error` call — so `\g | false` is
    // expected to return success with empty stderr. Vanilla psql
    // confirms this: `printf 'SELECT 1 \\g | false\n\\echo after\n' |
    // psql` prints `after` and exits 0.
    const ctx = makeMockCtx('g', `'|false'`, s, 'select 1');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('reset-buf');
    expect(stderr()).toBe('');
  });

  test('renders server errors in upstream 3-line shape (not `\\g:`)', async () => {
    const conn = makeMockConn();
    conn.execSimple = () => {
      const err = Object.assign(new Error('there is no parameter $1'), {
        severity: 'ERROR',
        code: '42P02',
        position: '8',
      });
      return Promise.reject(err);
    };
    const s = makeSettings(conn);
    // Trailing whitespace before `\g` is preserved in the LINE re-print
    // (vanilla psql sends the buffer verbatim to the server, so the LINE
    // includes the trailing space).
    const ctx = makeMockCtx('g', '', s, 'SELECT $1, $2 ');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/^ERROR: {2}there is no parameter \$1/m);
    expect(stderr()).toMatch(/^LINE 1: SELECT \$1, \$2 /m);
    expect(stderr()).not.toMatch(/\\g:/);
    expect(s.vars.get('SQLSTATE')).toBe('42P02');
    expect(s.vars.get('LAST_ERROR_MESSAGE')).toBe('there is no parameter $1');
  });

  test('leading comments + blank lines in queryBuf still emit LINE 1', async () => {
    // Reproduces the psql.sql `SELECT foo \bind \g` case where the buffer
    // carries blank+comment lines from the gap after a previous `\g`'s
    // reset. Without stripping the prelude, queryBuf newlines would push
    // the count to LINE 3 even though only `SELECT foo` was on the wire.
    const conn = makeMockConn();
    conn.execSimple = () => {
      const err = Object.assign(new Error('column "foo" does not exist'), {
        severity: 'ERROR',
        code: '42703',
        position: '8',
      });
      return Promise.reject(err);
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx(
      'g',
      '',
      s,
      '\n\n-- errors\n-- parse error\nSELECT foo ',
    );
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/^LINE 1: SELECT foo /m);
    expect(stderr()).not.toMatch(/LINE 3:/);
  });

  test('unopenable FILE target emits `<path>: <strerror>` and does not crash', async () => {
    // Regression: a `\g :unresolved/path` (e.g. left behind by an
    // unsubstituted variable) used to crash the entire Node process
    // because the lazy `createWriteStream` open failure surfaced as
    // an unhandled `'error'` event. We now open synchronously and
    // emit the upstream `<path>: No such file or directory` shape,
    // and the connection is NEVER touched (no query is dispatched
    // when the redirect can't be set up).
    const conn = makeMockConn();
    conn.reply = () => [rs(['a'], [[1]])];
    const s = makeSettings(conn);
    const missing = path.join(tmpDir, 'missing-dir', 'no-such.txt');
    const ctx = makeMockCtx('g', missing, s, 'select 1');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe(`${missing}: No such file or directory\n`);
    expect(conn.history).toEqual([]);
    expect(stderr()).not.toMatch(/\\g:/);
  });
});

// ---------------------------------------------------------------------------
// \gx — toggles expanded for one execution
// ---------------------------------------------------------------------------

describe('\\gx', () => {
  test('toggles expanded for the one query and restores after', async () => {
    const conn = makeMockConn();
    let seenExpanded: 'on' | 'off' | 'auto' | null = null;
    conn.reply = () => {
      seenExpanded = s.popt.topt.expanded;
      return [rs(['a'], [[1]])];
    };
    const s = makeSettings(conn);
    s.popt.topt.expanded = 'off';
    const ctx = makeMockCtx('gx', '', s, 'select 1');
    const r = await run(cmdGx, ctx);
    expect(r.status).toBe('reset-buf');
    expect(seenExpanded).toBe('on');
    // Restored.
    expect(s.popt.topt.expanded).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// \gset PREFIX
// ---------------------------------------------------------------------------

describe('\\gset', () => {
  test('populates settings.vars from result columns with prefix', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['x', 'y'], [['hello', 42]])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', 'foo_', s, 'select x, y');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('reset-buf');
    expect(s.vars.get('foo_x')).toBe('hello');
    expect(s.vars.get('foo_y')).toBe('42');
  });

  test('unsets the target variable when the column value is NULL', async () => {
    // Upstream `StoreQueryTuple` calls `UnsetVariable` when PQgetisnull
    // reports the cell is NULL, so a subsequent `:var` in `\echo`
    // interpolates as the literal `:var` (via the scanner's unset-var
    // passthrough). Mirror by exercising both the unset-on-NULL path and
    // the unset-overrides-prior-value path.
    const conn = makeMockConn();
    conn.reply = () => [rs(['var2', 'var3'], [[null, 'kept']])];
    const s = makeSettings(conn);
    // Seed `var2` with a prior value to prove the NULL cell unsets it
    // (not just "leaves it absent").
    s.vars.set('var2', 'preset');
    expect(s.vars.has('var2')).toBe(true);
    const ctx = makeMockCtx(
      'gset',
      '',
      s,
      "select NULL as var2, 'kept' as var3",
    );
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('reset-buf');
    // NULL → unset (not '').
    expect(s.vars.has('var2')).toBe(false);
    expect(s.vars.get('var2')).toBeUndefined();
    // Non-NULL sibling is still set.
    expect(s.vars.get('var3')).toBe('kept');
  });

  test('errors with bare `no rows returned for \\gset` when zero rows', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['x'], [])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', '', s, 'select x where false');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('error');
    // Match upstream wording — bare `no rows returned for \gset` (no
    // `\gset:` prefix). Verified against vanilla psql 18.
    expect(stderr()).toMatch(/^no rows returned for \\gset/);
    expect(stderr()).not.toMatch(/\\gset:/);
  });

  test('non-tuples result (DDL) is a no-op, not an error', async () => {
    const conn = makeMockConn();
    // CREATE TABLE returns PGRES_COMMAND_OK with no fields.
    conn.reply = () => [rs([], [], 'CREATE TABLE')];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', '', s, 'create temp table t (x int)');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('reset-buf');
    expect(stderr()).toBe('');
  });

  test('errors when more than one row returned', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['x'], [[1], [2]])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', '', s, 'select x');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('error');
    // Match upstream wording — bare `more than one row returned for \gset`
    // (no `\gset:` prefix). Verified against vanilla psql 18.
    expect(stderr()).toMatch(/^more than one row returned for \\gset/);
    expect(stderr()).not.toMatch(/\\gset:/);
  });

  test('emits bare `invalid variable name: "X"` (no \\gset: prefix)', async () => {
    const conn = makeMockConn();
    // Column name with a space is rejected by the var name regex.
    conn.reply = () => [rs(['bad name'], [['hello']])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', '', s, 'select 10 as "bad name"');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/^invalid variable name: "bad name"/);
    expect(stderr()).not.toMatch(/\\gset:/);
  });

  test('skips specially treated variables with the upstream warning and continues', async () => {
    const conn = makeMockConn();
    // Two columns: EOF (with prefix IGNORE → IGNOREEOF, specially
    // treated) and _foo (→ IGNORE_foo, not special).
    conn.reply = () => [rs(['EOF', '_foo'], [[97, 'ok']])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx(
      'gset',
      'IGNORE',
      s,
      'select 97 as "EOF", \'ok\' as _foo',
    );
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('reset-buf');
    expect(stderr()).toMatch(
      /attempt to \\gset into specially treated variable "IGNOREEOF" ignored/,
    );
    // Non-special column was still assigned.
    expect(s.vars.get('IGNORE_foo')).toBe('ok');
  });

  test('renders server errors in upstream 3-line shape (not `\\gset:`)', async () => {
    const conn = makeMockConn();
    conn.execSimple = () => {
      // Synthesise the ErrorResponse shape our wire layer attaches to
      // thrown errors.
      const err = Object.assign(new Error('relation "nope" does not exist'), {
        severity: 'ERROR',
        code: '42P01',
        position: '15',
      });
      return Promise.reject(err);
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', '', s, 'SELECT * FROM nope');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/^ERROR: {2}relation "nope" does not exist/m);
    expect(stderr()).toMatch(/^LINE 1: SELECT \* FROM nope/m);
    expect(stderr()).not.toMatch(/\\gset:/);
    // Diagnostic vars refreshed by formatServerError.
    expect(s.vars.get('SQLSTATE')).toBe('42P01');
    expect(s.vars.get('ERROR')).toBe('true');
  });

  test('updates settings.lastQuery so a follow-on `\\g` re-runs the SELECT', async () => {
    // Vanilla `exec_command_gset` writes the dispatched SQL to
    // `pset.last_query` before sending. The psql.sql regress corpus
    // relies on this: `select 5 as x, 6 as y \gset pref01_ \\ \g`
    // expects `\g` (empty buffer) to re-execute the SELECT and print
    // its result table. Without the assignment, the variables get
    // populated but the table is missing.
    const conn = makeMockConn();
    conn.reply = () => [rs(['x'], [[5]])];
    const s = makeSettings(conn);
    expect(s.lastQuery).toBe('');
    const ctx = makeMockCtx('gset', 'pref_', s, 'select 5 as x');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('reset-buf');
    expect(s.lastQuery).toBe('select 5 as x');
  });
});

// ---------------------------------------------------------------------------
// \gexec
// ---------------------------------------------------------------------------

describe('\\gexec', () => {
  test('iterates result cells and re-executes each as SQL', async () => {
    const conn = makeMockConn();
    let phase = 0;
    conn.reply = () => {
      phase += 1;
      if (phase === 1) {
        // First call: return two cells of generated SQL.
        return [rs(['stmt'], [['create x;'], ['drop x;']])];
      }
      // Subsequent calls: harmless empty result.
      return [rs([], [], 'CREATE TABLE')];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gexec', '', s, 'select stmt from t');
    const r = await run(cmdGexec, ctx);
    expect(r.status).toBe('reset-buf');
    expect(conn.history).toEqual([
      'select stmt from t',
      'create x;',
      'drop x;',
    ]);
  });

  test('skips null and empty cells', async () => {
    const conn = makeMockConn();
    let phase = 0;
    conn.reply = () => {
      phase += 1;
      if (phase === 1) {
        return [rs(['stmt'], [[null], [''], ['select 1']])];
      }
      return [];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gexec', '', s, 'select stmt');
    const r = await run(cmdGexec, ctx);
    expect(r.status).toBe('reset-buf');
    expect(conn.history).toEqual(['select stmt', 'select 1']);
  });

  test('renders nested statement errors in upstream 3-line shape (not `\\gexec:`)', async () => {
    const conn = makeMockConn();
    let phase = 0;
    conn.execSimple = (sql) => {
      conn.history.push(sql);
      phase += 1;
      if (phase === 1) {
        return Promise.resolve([rs(['stmt'], [['BROKEN_SQL']])]);
      }
      const err = Object.assign(
        new Error('syntax error at or near "BROKEN_SQL"'),
        { severity: 'ERROR', code: '42601', position: '1' },
      );
      return Promise.reject(err);
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gexec', '', s, 'select stmt');
    const r = await run(cmdGexec, ctx);
    // Upstream `\gexec` tolerates per-row errors and continues to the
    // next row — only ON_ERROR_STOP escalates. With one failing row and
    // no further rows, we return `reset-buf` (the error was already
    // rendered to stderr via `formatServerError`).
    expect(r.status).toBe('reset-buf');
    expect(stderr()).toMatch(
      /^ERROR: {2}syntax error at or near "BROKEN_SQL"/m,
    );
    expect(stderr()).not.toMatch(/\\gexec:/);
  });

  test('tolerates per-row errors and continues to the next row', async () => {
    const conn = makeMockConn();
    let phase = 0;
    conn.execSimple = (sql) => {
      conn.history.push(sql);
      phase += 1;
      if (phase === 1) {
        // First-pass meta query: three rows of generated SQL.
        return Promise.resolve([
          rs(
            ['stmt'],
            [['drop table missing'], ['select 1 as ok'], ['select 2 as also']],
          ),
        ]);
      }
      if (phase === 2) {
        // First derived row errors.
        const err = Object.assign(new Error('table "missing" does not exist'), {
          severity: 'ERROR',
          code: '42P01',
        });
        return Promise.reject(err);
      }
      // Subsequent derived rows succeed.
      return Promise.resolve([rs(['ok'], [[1]])]);
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gexec', '', s, 'select stmt');
    const r = await run(cmdGexec, ctx);
    expect(r.status).toBe('reset-buf');
    // All three derived statements were dispatched in order — vanilla
    // does not abort the loop on the first failure when ON_ERROR_STOP
    // is unset.
    expect(conn.history).toEqual([
      'select stmt',
      'drop table missing',
      'select 1 as ok',
      'select 2 as also',
    ]);
    expect(stderr()).toMatch(/table "missing" does not exist/);
  });

  test("echoes each row's generated SQL when ECHO=all", async () => {
    const conn = makeMockConn();
    let phase = 0;
    conn.reply = () => {
      phase += 1;
      if (phase === 1) {
        return [
          rs(['stmt'], [['create index on t(a)'], ['create index on t(b)']]),
        ];
      }
      return [rs([], [], 'CREATE INDEX')];
    };
    const s = makeSettings(conn);
    s.echo = 'all';
    const ctx = makeMockCtx('gexec', '', s, 'select stmt');
    await run(cmdGexec, ctx);
    // Each row's SQL is echoed verbatim on stdout (one line per dispatch),
    // matching vanilla `do_gexec`'s SendQuery echo path under
    // `--echo-all` / `\set ECHO all`.
    expect(stdout()).toMatch(/create index on t\(a\)/);
    expect(stdout()).toMatch(/create index on t\(b\)/);
  });

  test('stops on first error when ON_ERROR_STOP is set', async () => {
    const conn = makeMockConn();
    let phase = 0;
    conn.execSimple = (sql) => {
      conn.history.push(sql);
      phase += 1;
      if (phase === 1) {
        return Promise.resolve([
          rs(['stmt'], [['fail one'], ['select 1 as never']]),
        ]);
      }
      // First derived row errors.
      const err = Object.assign(new Error('boom'), {
        severity: 'ERROR',
        code: '42000',
      });
      return Promise.reject(err);
    };
    const s = makeSettings(conn);
    s.onErrorStop = true;
    const ctx = makeMockCtx('gexec', '', s, 'select stmt');
    const r = await run(cmdGexec, ctx);
    expect(r.status).toBe('error');
    // Only the first derived row was attempted.
    expect(conn.history).toEqual(['select stmt', 'fail one']);
  });

  test('updates settings.lastQuery so a follow-on `\\g` re-runs the meta query', async () => {
    // Mirrors upstream `exec_command_gexec`'s PSQL_CMD_SEND path which bumps
    // `pset.last_query` to the meta query before dispatch. Without this, a
    // subsequent `\g` with an empty queryBuf falls back to a stale value
    // (typically the previous failing `TABLE bububu;`-style statement),
    // which is exactly the cascade that broke regress/psql lines 355+.
    const conn = makeMockConn();
    let phase = 0;
    conn.reply = () => {
      phase += 1;
      if (phase === 1) return [rs(['stmt'], [['select 1 as one']])];
      return [rs([], [], 'SELECT 1')];
    };
    const s = makeSettings(conn);
    expect(s.lastQuery).toBe('');
    const ctx = makeMockCtx('gexec', '', s, 'select stmt from t');
    await run(cmdGexec, ctx);
    expect(s.lastQuery).toBe('select stmt from t');
  });
});

// ---------------------------------------------------------------------------
// \watch
// ---------------------------------------------------------------------------

describe('\\watch', () => {
  test('runs the query repeatedly and stops on AbortController', async () => {
    const conn = makeMockConn();
    let count = 0;
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    conn.reply = () => {
      count += 1;
      if (count >= 3) controller.abort();
      return [rs(['n'], [[count]])];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '0.01', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    expect(count).toBeGreaterThanOrEqual(3);
    expect(stdout()).toMatch(/every 0\.01s/);
  });

  test('rejects a non-numeric interval', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'banana', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    // Upstream message: "incorrect interval value "<token>""
    expect(stderr()).toMatch(/incorrect interval value "banana"/);
  });

  test('rejects a negative positional interval', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '-10', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/incorrect interval value "-10"/);
  });

  test('rejects garbage trailing characters in interval', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '10ab', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/incorrect interval value "10ab"/);
  });

  test('rejects an out-of-range interval (Infinity)', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '10e400', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/incorrect interval value "10e400"/);
  });

  test('parses `i=` named interval', async () => {
    const conn = makeMockConn();
    let count = 0;
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    conn.reply = () => {
      count += 1;
      if (count >= 2) controller.abort();
      return [rs(['n'], [[count]])];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'i=0.01', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    expect(stdout()).toMatch(/every 0\.01s/);
  });

  test('`c=` iteration count caps the loop', async () => {
    const conn = makeMockConn();
    let count = 0;
    conn.reply = () => {
      count += 1;
      return [rs(['n'], [[count]])];
    };
    const s = makeSettings(conn);
    // c=3 with very-short interval — loop should self-stop after 3.
    const ctx = makeMockCtx('watch', 'c=3 i=0.001', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    expect(count).toBe(3);
  });

  test('parses `min_rows=` as a synonym for `m=`', async () => {
    const conn = makeMockConn();
    // Return FEWER than min_rows tuples so the watch loop stops on
    // iteration 1. Upstream's `min_rows` is a CONTINUE predicate: keep
    // polling while result has >= min_rows rows; stop the moment it
    // doesn't. With min_rows=2 and a 1-row result, 1 < 2 → stop.
    conn.reply = () => [rs(['n'], [[1]])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'min_rows=2 i=0.001', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    expect(conn.history.length).toBe(1);
  });

  test('rejects non-numeric `m=` value', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'm=x', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/incorrect minimum row count "x"/);
  });

  test('rejects duplicate positional interval (`\\watch 1 1`)', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '1 1', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/interval value is specified more than once/);
  });

  test('rejects duplicate `c=` (`\\watch c=1 c=1`)', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'c=1 c=1', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/iteration count is specified more than once/);
  });

  test('rejects `m=1 min_rows=2` as a duplicate', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'm=1 min_rows=2', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/minimum row count specified more than once/);
  });

  test('`min_rows` keeps polling while result has >= threshold rows', async () => {
    const conn = makeMockConn();
    let count = 0;
    // First two calls return 5 rows each (>= 3 → continue); the third
    // returns 1 row (< 3 → stop). Upstream `min_rows` is a CONTINUE
    // predicate: the loop keeps polling so long as the result has at
    // least `min_rows` tuples, and breaks the moment a result comes
    // back with fewer. See PG `common.c::ExecQueryAndProcessResults`,
    // which flips `return_early` to true exactly when
    // `PQntuples(result) < min_rows`.
    conn.reply = () => {
      count += 1;
      if (count <= 2) return [rs(['n'], [[1], [2], [3], [4], [5]])];
      return [rs(['n'], [[1]])];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'min_rows=3 i=0.001', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    expect(count).toBe(3);
  });

  test('falls back to WATCH_INTERVAL when no explicit interval is given', async () => {
    const conn = makeMockConn();
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    let count = 0;
    conn.reply = () => {
      count += 1;
      if (count >= 2) controller.abort();
      return [rs(['n'], [[count]])];
    };
    const s = makeSettings(conn);
    s.vars.set('WATCH_INTERVAL', '0.01');
    const ctx = makeMockCtx('watch', '', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    expect(stdout()).toMatch(/every 0\.01s/);
  });

  test('empty buffer errors out', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '', s, '');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/no query buffer/);
  });

  test('emits the upstream ctime-style header before each iteration', async () => {
    const conn = makeMockConn();
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    let count = 0;
    conn.reply = () => {
      count += 1;
      controller.abort();
      return [rs(['n'], [[count]])];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '0.01', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    // Upstream layout: `Day Mon DD HH:MM:SS YYYY (every Ns)`.
    expect(stdout()).toMatch(
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{2}:\d{2}:\d{2} \d{4} \(every 0\.01s\)/,
    );
  });

  test('injects a trailing newline after the loop ends (matches upstream `fprintf(stdout, "\\n")`)', async () => {
    // Upstream `do_watch` writes a final `\n` to stdout when the loop
    // exits and no pager is attached. We mirror that so the output shape
    // `...\n(N rows)\n\n\n` matches vanilla psql. Without this, the
    // conformance harness sees one fewer trailing newline than the
    // reference psql_pipe captures and the diff hunk grows by a line.
    const conn = makeMockConn();
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    conn.reply = () => {
      controller.abort();
      return [rs(['n'], [[1]])];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'c=1 i=0.001', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdout();
    // The very last character is the injected `\n`. Anything before it
    // is the per-iteration `(1 row)\n\n` footer, so we look for exactly
    // three newlines at the end.
    expect(out.endsWith('\n\n\n')).toBe(true);
  });

  test('does NOT inject a trailing newline when piping through a pager', async () => {
    // Upstream skips the trailing `\n` when a pager is in play (the
    // pager will reset the cursor on exit). Mirror that here so the
    // pager-captured output is identical to vanilla psql's.
    const conn = makeMockConn();
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    conn.reply = () => {
      controller.abort();
      return [rs(['n'], [[1]])];
    };
    const sink = tmpFile('watch-pager-trailing.out');
    const prev = process.env.PSQL_WATCH_PAGER;
    process.env.PSQL_WATCH_PAGER = `cat > ${sink}`;
    try {
      const s = makeSettings(conn);
      const ctx = makeMockCtx('watch', 'c=1 i=0.001', s, 'select 1');
      const r = await run(cmdWatch, ctx);
      expect(r.status).toBe('reset-buf');
    } finally {
      if (prev === undefined) delete process.env.PSQL_WATCH_PAGER;
      else process.env.PSQL_WATCH_PAGER = prev;
    }
    const written = await fs.readFile(sink, 'utf8');
    // Only two trailing newlines — the per-iteration `(1 row)\n\n`
    // footer, with no extra `\n` added by the watch-loop epilogue.
    expect(written.endsWith('\n\n')).toBe(true);
    expect(written.endsWith('\n\n\n')).toBe(false);
  });

  test('PSQL_WATCH_PAGER pipes the whole watch session through the pager', async () => {
    const conn = makeMockConn();
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    let count = 0;
    conn.reply = () => {
      count += 1;
      if (count >= 2) controller.abort();
      return [rs(['n'], [[count]])];
    };
    const sink = tmpFile('watch-pager.out');
    const prev = process.env.PSQL_WATCH_PAGER;
    // `cat > sink` captures the entire watch session — both header and
    // tabular output — into a file so we can assert on it.
    process.env.PSQL_WATCH_PAGER = `cat > ${sink}`;
    try {
      const s = makeSettings(conn);
      const ctx = makeMockCtx('watch', '0.01', s, 'select 1');
      const r = await run(cmdWatch, ctx);
      expect(r.status).toBe('reset-buf');
    } finally {
      if (prev === undefined) delete process.env.PSQL_WATCH_PAGER;
      else process.env.PSQL_WATCH_PAGER = prev;
    }
    const written = await fs.readFile(sink, 'utf8');
    // The pager received the header + table output, not stdout.
    expect(written).toMatch(/every 0\.01s/);
    // Nothing leaked to the captured stdout buffer.
    expect(stdout()).not.toMatch(/every 0\.01s/);
  });

  test('PSQL_WATCH_PAGER is ignored when set to whitespace-only', async () => {
    const conn = makeMockConn();
    const controller = new AbortController();
    WATCH_TEST_CONTROLLER.ref = controller;
    conn.reply = () => {
      controller.abort();
      return [rs(['n'], [[1]])];
    };
    const prev = process.env.PSQL_WATCH_PAGER;
    process.env.PSQL_WATCH_PAGER = '   ';
    try {
      const s = makeSettings(conn);
      const ctx = makeMockCtx('watch', '0.01', s, 'select 1');
      const r = await run(cmdWatch, ctx);
      expect(r.status).toBe('reset-buf');
    } finally {
      if (prev === undefined) delete process.env.PSQL_WATCH_PAGER;
      else process.env.PSQL_WATCH_PAGER = prev;
    }
    // Whitespace-only disables the pager — output goes to the
    // captured stdout exactly as it does without the env var.
    expect(stdout()).toMatch(/every 0\.01s/);
  });
});

// ---------------------------------------------------------------------------
// WATCH_INTERVAL psql variable hook
// ---------------------------------------------------------------------------

describe('WATCH_INTERVAL variable hook', () => {
  test('is initialized to the upstream default "2"', () => {
    const s = makeSettings();
    expect(s.vars.get('WATCH_INTERVAL')).toBe('2');
  });

  test('accepts a valid numeric value', () => {
    const s = makeSettings();
    expect(s.vars.set('WATCH_INTERVAL', '10')).toBe(true);
    expect(s.vars.get('WATCH_INTERVAL')).toBe('10');
  });

  test('rejects 1e500 (overflows to Infinity)', () => {
    const s = makeSettings();
    // The hook returns an upstream-shaped diagnostic string; `trySet`
    // surfaces it via the `error` field on the result. The slot keeps
    // its prior value (the documented default "2"). The exact wording
    // comes from `validateWatchInterval` in `core/settings.ts`, which
    // mirrors upstream `ParseVariableDouble`'s three error paths
    // (junk / negative / out-of-range).
    const r = s.vars.trySet('WATCH_INTERVAL', '1e500');
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'hook-veto') throw new Error('unreachable');
    expect(r.error).toMatch(
      /invalid value "1e500" for variable "WATCH_INTERVAL"/,
    );
    expect(s.vars.get('WATCH_INTERVAL')).toBe('2');
  });

  test('rejects a non-numeric value', () => {
    const s = makeSettings();
    const r = s.vars.trySet('WATCH_INTERVAL', 'banana');
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'hook-veto') throw new Error('unreachable');
    expect(r.error).toMatch(
      /invalid value "banana" for variable "WATCH_INTERVAL"/,
    );
  });

  test('rejects a negative value', () => {
    const s = makeSettings();
    const r = s.vars.trySet('WATCH_INTERVAL', '-5');
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'hook-veto') throw new Error('unreachable');
    // Upstream's third path: `must be greater than 0.00`.
    expect(r.error).toMatch(/invalid value "-5" for variable "WATCH_INTERVAL"/);
  });

  test('unset re-seeds the default "2" (upstream substitute hook)', () => {
    // Upstream `watch_interval_substitute_hook` re-seeds the variable to
    // `DEFAULT_WATCH_INTERVAL` ("2") when the user `\unset`s it. Our
    // hook returns `{ substitute: DEFAULT_WATCH_INTERVAL }` from the
    // null branch, which `VarStore.unset` honours by re-storing the
    // substituted value. The conformance test echoes `:WATCH_INTERVAL`
    // after `\unset` and expects `2` — see
    // `tests/psql-conformance/vendor/postgres-18.0/.../001_basic.pl`
    // around the `WATCH_INTERVAL variable is set and updated` block.
    const s = makeSettings();
    s.vars.set('WATCH_INTERVAL', '5');
    stderrChunks.length = 0;
    s.vars.unset('WATCH_INTERVAL');
    expect(stderr()).toBe('');
    expect(s.vars.get('WATCH_INTERVAL')).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// \i / \include
// ---------------------------------------------------------------------------

describe('\\i / \\include', () => {
  test('reads FILE and executes the SQL through execSimple', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['a'], [[1]])];
    const s = makeSettings(conn);
    const file = tmpFile('script.sql');
    await fs.writeFile(file, 'select 1;\n', 'utf8');
    const ctx = makeMockCtx('i', file, s);
    const r = await run(cmdInclude, ctx);
    expect(r.status).toBe('ok');
    expect(conn.history).toEqual(['select 1;']);
    // Also stashed on the input queue for future mainloop wiring.
    expect(inputQueueSize()).toBe(1);
  });

  test('missing FILE arg errors', async () => {
    const s = makeSettings(makeMockConn());
    const ctx = makeMockCtx('i', '', s);
    const r = await run(cmdInclude, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/missing required argument/);
  });

  test('nonexistent FILE yields ENOENT', async () => {
    const s = makeSettings(makeMockConn());
    const missing = path.join(tmpDir, 'no-such-file.sql');
    const ctx = makeMockCtx('i', missing, s);
    const r = await run(cmdInclude, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/ENOENT|no such file/i);
  });

  test('empty file is a no-op success', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const file = tmpFile('empty.sql');
    await fs.writeFile(file, '', 'utf8');
    const ctx = makeMockCtx('i', file, s);
    const r = await run(cmdInclude, ctx);
    expect(r.status).toBe('ok');
    expect(conn.history).toEqual([]);
  });

  // Known limitation: backslash commands inside the included file are NOT
  // re-dispatched. We document this in the source comment; this test
  // simply asserts the current "send as one SQL blob" behaviour.
  test('does NOT re-dispatch backslash commands embedded in the file', async () => {
    const conn = makeMockConn();
    // The connection sees the literal text including the backslash —
    // upstream would have intercepted `\d` via the scanner.
    let captured = '';
    conn.reply = (sql) => {
      captured = sql;
      return [];
    };
    const s = makeSettings(conn);
    const file = tmpFile('mixed.sql');
    await fs.writeFile(file, 'select 1;\n\\d foo\n', 'utf8');
    const ctx = makeMockCtx('i', file, s);
    await run(cmdInclude, ctx);
    expect(captured).toContain('\\d');
  });
});

// ---------------------------------------------------------------------------
// \gdesc — describes the buffered query via Parse + Describe-by-statement
// and renders the result through the active printer.
// ---------------------------------------------------------------------------

/**
 * Wire a mock Connection so that `prepare(name, sql).describe()` returns
 * the given fields and `execSimple(formatQuery)` returns a canned
 * Column / Type ResultSet so we can observe the printer-driven output.
 */
const mockGdescConn = (
  fields: FieldDescription[],
  typeNames: string[],
): MockConn => {
  const conn = makeMockConn();
  const preparedClose: string[] = [];
  conn.prepare = (name: string) => {
    return Promise.resolve({
      name,
      paramTypes: [],
      bind: () => Promise.resolve(),
      describe: () => Promise.resolve(fields),
      execute: (): Promise<ResultSet> =>
        Promise.resolve({
          command: 'SELECT',
          rowCount: 0,
          oid: null,
          fields,
          rows: [],
          notices: [],
        }),
      bindAndExecute: (): Promise<ResultSet> =>
        Promise.resolve({
          command: 'SELECT',
          rowCount: 0,
          oid: null,
          fields,
          rows: [],
          notices: [],
        }),
      close: () => {
        preparedClose.push(name);
        return Promise.resolve();
      },
    });
  };
  // Whenever the gdesc round-trip issues the `SELECT ... format_type(...)
  // FROM (VALUES ...)` query we return the supplied type names paired with
  // the field names — same order.
  conn.reply = (sql: string) => {
    if (sql.includes('format_type')) {
      return [
        rs(
          ['Column', 'Type'],
          fields.map((f, i) => [f.name, typeNames[i] ?? '???']),
        ),
      ];
    }
    return [];
  };
  return conn;
};

describe('\\gdesc', () => {
  test('renders a Column / Type listing via the active printer', async () => {
    const conn = mockGdescConn(
      [
        {
          name: 'id',
          tableID: 0,
          columnID: 0,
          dataTypeID: 23,
          dataTypeSize: 4,
          dataTypeModifier: -1,
          format: 0,
        },
        {
          name: 'note',
          tableID: 0,
          columnID: 0,
          dataTypeID: 25,
          dataTypeSize: -1,
          dataTypeModifier: -1,
          format: 0,
        },
      ],
      ['integer', 'text'],
    );
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gdesc', '', s, "SELECT 1 AS id, 'x' AS note");
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdout();
    // Header line + box separator + (2 rows) footer — same shape as a
    // real two-column SELECT in the default aligned printer.
    expect(out).toMatch(/Column\s*\|\s*Type/);
    expect(out).toMatch(/id\s*\|\s*integer/);
    expect(out).toMatch(/note\s*\|\s*text/);
    expect(out).toMatch(/\(2 rows\)/);
  });

  test('routes through the unaligned printer when format=unaligned', async () => {
    const conn = mockGdescConn(
      [
        {
          name: 'col',
          tableID: 0,
          columnID: 0,
          dataTypeID: 23,
          dataTypeSize: 4,
          dataTypeModifier: -1,
          format: 0,
        },
      ],
      ['integer'],
    );
    const s = makeSettings(conn);
    s.popt.topt.format = 'unaligned';
    const ctx = makeMockCtx('gdesc', '', s, 'select 1');
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('reset-buf');
    // Unaligned printer separates with `|` and writes `col|integer` on
    // its own line.
    expect(stdout()).toMatch(/^col\|integer$/m);
  });

  test('tuples-only mode suppresses the header and footer', async () => {
    const conn = mockGdescConn(
      [
        {
          name: 'col',
          tableID: 0,
          columnID: 0,
          dataTypeID: 23,
          dataTypeSize: 4,
          dataTypeModifier: -1,
          format: 0,
        },
      ],
      ['integer'],
    );
    const s = makeSettings(conn);
    s.popt.topt.tuplesOnly = true;
    const ctx = makeMockCtx('gdesc', '', s, 'select 1');
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdout();
    expect(out).not.toMatch(/Column/);
    expect(out).not.toMatch(/\(1 row\)/);
    expect(out).toMatch(/integer/);
  });

  test('emits upstream "no result, no columns" stdout note when buffer is empty', async () => {
    const s = makeSettings(makeMockConn());
    const ctx = makeMockCtx('gdesc', '', s, '');
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('reset-buf');
    expect(stdout()).toMatch(
      /^The command has no result, or the result has no columns/,
    );
    expect(stderr()).toBe('');
  });

  test('surfaces Parse failures', async () => {
    const conn = makeMockConn();
    // Default mock's prepare rejects with `not implemented`.
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gdesc', '', s, 'select 1');
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/not implemented/);
  });

  test('updates settings.lastQuery so a follow-on `\\g` re-runs the SELECT', async () => {
    // Mirrors the regress/psql sequence:
    //   SELECT 1 AS x, 'Hello', 2 AS y, true AS "dirty\name"
    //   \gdesc
    //   \g            -- must re-execute the SELECT
    // Without `lastQuery = sql` before dispatch, the subsequent `\g` saw an
    // empty queryBuf + stale `lastQuery` (typically the previous failing
    // statement) and the cascade rippled through the rest of psql.sql.
    const conn = mockGdescConn(
      [
        {
          name: 'x',
          tableID: 0,
          columnID: 0,
          dataTypeID: 23,
          dataTypeSize: 4,
          dataTypeModifier: -1,
          format: 0,
        },
      ],
      ['integer'],
    );
    const s = makeSettings(conn);
    expect(s.lastQuery).toBe('');
    const ctx = makeMockCtx('gdesc', '', s, 'select 5 as x');
    await run(cmdGdesc, ctx);
    expect(s.lastQuery).toBe('select 5 as x');
  });
});
