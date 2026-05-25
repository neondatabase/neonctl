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
  resetInputQueue();
  WATCH_TEST_CONTROLLER.ref = null;
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
    expect(stderr()).toMatch(/expected one row, got 2/);
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
    expect(stderr()).toMatch(/invalid watch interval/);
  });

  test('empty buffer errors out', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('watch', '', s, '');
    const r = await run(cmdWatch, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/no query buffer/);
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
// \gdesc — stubbed
// ---------------------------------------------------------------------------

describe('\\gdesc', () => {
  test('returns the extended-protocol stub error', async () => {
    const s = makeSettings(makeMockConn());
    const ctx = makeMockCtx('gdesc', '', s, 'select 1');
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/extended protocol not available/);
    expect(s.lastErrorResult?.message).toMatch(
      /extended protocol not available/,
    );
  });
});
