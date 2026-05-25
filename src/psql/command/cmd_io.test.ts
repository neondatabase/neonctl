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

  test('pipe form propagates a non-zero program exit code', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['a'], [[1]])];
    const s = makeSettings(conn);
    // `false` always exits 1 — \g must surface this as an error.
    const ctx = makeMockCtx('g', `'|false'`, s, 'select 1');
    const r = await run(cmdG, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/program exited with status 1/);
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

  test('errors when the result has zero rows', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['x'], [])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', '', s, 'select x where false');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/expected one row/);
  });

  test('errors when more than one row returned', async () => {
    const conn = makeMockConn();
    conn.reply = () => [rs(['x'], [[1], [2]])];
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gset', '', s, 'select x');
    const r = await run(cmdGset, ctx);
    expect(r.status).toBe('error');
    // Match upstream wording — `more than one row returned for \gset`.
    expect(stderr()).toMatch(/more than one row returned for \\gset/);
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
    // Always return enough rows so the watch loop stops on iteration 1.
    conn.reply = () => [rs(['n'], [[1], [2], [3]])];
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

  test('`min_rows` keeps polling until threshold reached', async () => {
    const conn = makeMockConn();
    let count = 0;
    // First call returns 1 row; subsequent calls return 5 rows. With
    // min_rows=3 the loop must poll twice.
    conn.reply = () => {
      count += 1;
      if (count === 1) return [rs(['n'], [[1]])];
      return [rs(['n'], [[1], [2], [3], [4], [5]])];
    };
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', 'min_rows=3 i=0.001', s, 'select 1');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('reset-buf');
    expect(count).toBe(2);
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
  test('accepts a valid numeric value', () => {
    const s = makeSettings();
    expect(s.vars.set('WATCH_INTERVAL', '10')).toBe(true);
    expect(s.vars.get('WATCH_INTERVAL')).toBe('10');
  });

  test('rejects 1e500 (overflows to Infinity)', () => {
    const s = makeSettings();
    expect(s.vars.set('WATCH_INTERVAL', '1e500')).toBe(false);
    expect(s.vars.get('WATCH_INTERVAL')).toBeUndefined();
    expect(stderr()).toMatch(/WATCH_INTERVAL "1e500" is out of range/);
  });

  test('rejects a non-numeric value', () => {
    const s = makeSettings();
    expect(s.vars.set('WATCH_INTERVAL', 'banana')).toBe(false);
    expect(stderr()).toMatch(/WATCH_INTERVAL "banana" is out of range/);
  });

  test('rejects a negative value', () => {
    const s = makeSettings();
    expect(s.vars.set('WATCH_INTERVAL', '-5')).toBe(false);
    expect(stderr()).toMatch(/WATCH_INTERVAL "-5" is out of range/);
  });

  test('allows unsetting (null) without producing an error', () => {
    const s = makeSettings();
    s.vars.set('WATCH_INTERVAL', '5');
    stderrChunks.length = 0;
    s.vars.unset('WATCH_INTERVAL');
    expect(stderr()).toBe('');
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

  test('errors when the query buffer is empty', async () => {
    const s = makeSettings(makeMockConn());
    const ctx = makeMockCtx('gdesc', '', s, '');
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/no query buffer/);
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
});
