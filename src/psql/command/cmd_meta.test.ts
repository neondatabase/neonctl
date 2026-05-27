import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BackslashContext, BackslashCmdSpec } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  cmdCd,
  cmdCopyright,
  cmdEcho,
  cmdErrverbose,
  cmdGetenv,
  cmdHelpSQL,
  cmdQecho,
  cmdQuit,
  cmdSet,
  cmdSetenv,
  cmdShell,
  cmdTiming,
  cmdUnset,
  cmdWarn,
  formatErrorReport,
} from './cmd_meta.js';

// Mock context factory — each call yields a one-shot scanner over the
// given rawArgs string. Args are parsed naively by whitespace splitting,
// which is sufficient for the meta-command suite (no quoted-arg scenarios).
const makeMockCtx = (
  cmdName: string,
  rawArgs: string,
  settings?: PsqlSettings,
): BackslashContext => {
  const s = settings ?? defaultSettings(createVarStore());
  let cursor = 0;
  return {
    settings: s,
    cmdName,
    queryBuf: '',
    rawArgs,
    nextArg: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      if (cursor >= rawArgs.length) return null;
      const start = cursor;
      if (rawArgs[cursor] === "'") {
        cursor++;
        let out = '';
        while (cursor < rawArgs.length && rawArgs[cursor] !== "'") {
          out += rawArgs[cursor++];
        }
        if (cursor < rawArgs.length) cursor++;
        return out;
      }
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

// Stdout/stderr capture. vitest's process.stdout/stderr are inherited from
// Node, so we monkey-patch `write` for the duration of each test.
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

describe('\\q / \\quit', () => {
  test('returns exit status', async () => {
    const ctx = makeMockCtx('q', '');
    const r = await run(cmdQuit, ctx);
    expect(r.status).toBe('exit');
  });
});

describe('\\cd', () => {
  // process.chdir() throws in vitest's worker thread, so we stub it. The
  // tests verify that `\cd` invokes chdir with the right argument and
  // reports errors on bad input — no need for the real fs effect.
  let chdirOrig: typeof process.chdir;
  let chdirCalls: string[];
  let chdirThrowOn: string | null;
  beforeEach(() => {
    chdirOrig = process.chdir.bind(process);
    chdirCalls = [];
    chdirThrowOn = null;
    process.chdir = ((dir: string) => {
      chdirCalls.push(dir);
      if (chdirThrowOn !== null && dir === chdirThrowOn) {
        throw new Error(`ENOENT: no such file or directory, chdir '${dir}'`);
      }
    }) as typeof process.chdir;
  });
  afterEach(() => {
    process.chdir = chdirOrig;
  });

  test('no arg uses $HOME', async () => {
    const home = process.env.HOME ?? '/';
    const ctx = makeMockCtx('cd', '');
    const r = await run(cmdCd, ctx);
    expect(r.status).toBe('ok');
    expect(chdirCalls).toEqual([home]);
  });

  test('with arg changes cwd', async () => {
    const ctx = makeMockCtx('cd', '/tmp');
    const r = await run(cmdCd, ctx);
    expect(r.status).toBe('ok');
    expect(chdirCalls).toEqual(['/tmp']);
  });

  test('missing dir errors', async () => {
    chdirThrowOn = '/nonexistent-path-xyz-123';
    const ctx = makeMockCtx('cd', '/nonexistent-path-xyz-123');
    const r = await run(cmdCd, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/\\cd:/);
  });

  test('errors when HOME is unset and no arg', async () => {
    const settings = defaultSettings(createVarStore());
    const oldHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const ctx = makeMockCtx('cd', '', settings);
      const r = await run(cmdCd, ctx);
      expect(r.status).toBe('error');
      expect(stderr()).toMatch(/home directory/);
    } finally {
      if (oldHome !== undefined) process.env.HOME = oldHome;
    }
  });
});

describe('\\echo', () => {
  test('writes args joined with spaces and trailing newline', async () => {
    const ctx = makeMockCtx('echo', 'hello world');
    const r = await run(cmdEcho, ctx);
    expect(r.status).toBe('ok');
    expect(stdout()).toBe('hello world\n');
  });

  test('-n suppresses trailing newline', async () => {
    const ctx = makeMockCtx('echo', '-n hello');
    await run(cmdEcho, ctx);
    expect(stdout()).toBe('hello');
  });

  test('no args writes empty line', async () => {
    const ctx = makeMockCtx('echo', '');
    await run(cmdEcho, ctx);
    expect(stdout()).toBe('\n');
  });
});

describe('\\warn', () => {
  test('writes to stderr', async () => {
    const ctx = makeMockCtx('warn', 'watch out');
    await run(cmdWarn, ctx);
    expect(stderr()).toBe('watch out\n');
  });
});

describe('\\qecho', () => {
  test('writes to stdout when logfile is null', async () => {
    const ctx = makeMockCtx('qecho', 'q out');
    await run(cmdQecho, ctx);
    expect(stdout()).toBe('q out\n');
  });

  test('writes to logfile when set', async () => {
    const settings = defaultSettings(createVarStore());
    const chunks: string[] = [];
    settings.logfile = {
      write: (chunk: string | Buffer) => {
        chunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const ctx = makeMockCtx('qecho', 'log me', settings);
    await run(cmdQecho, ctx);
    expect(chunks.join('')).toBe('log me\n');
    expect(stdout()).toBe('');
  });
});

describe('\\set', () => {
  test('no args lists vars sorted', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set('ZZZ', 'last');
    settings.vars.set('AAA', 'first');
    const ctx = makeMockCtx('set', '', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('ok');
    const out = stdout();
    // AAA should appear before ZZZ in the sorted listing.
    expect(out.indexOf("AAA = 'first'")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("ZZZ = 'last'")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("AAA = 'first'")).toBeLessThan(
      out.indexOf("ZZZ = 'last'"),
    );
  });

  test('single arg sets to empty', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'X', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.get('X')).toBe('');
  });

  test('multiple args concatenate with no separator (upstream parity)', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'X Y Z W', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.get('X')).toBe('YZW');
  });

  test('invalid name errors with upstream "invalid variable name" wording', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', '1bad value', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    // Upstream `exec_command_set` emits `invalid variable name: "<name>"`
    // via `pg_log_error`. With the default `curCmdSource === 'stdin'`,
    // `psql_log_pre_callback` adds no prefix — only `-f FILE` / `\i` paths
    // get the `psql:<file>:<line>: ` prefix.
    expect(stderr()).toMatch(/^invalid variable name: "1bad"\n$/);
  });

  test('invalid characters in name (e.g. "/" — regress/psql line 9)', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'invalid/name foo', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe('invalid variable name: "invalid/name"\n');
  });

  test('AUTOCOMMIT non-boolean errors with upstream wording', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'AUTOCOMMIT foo', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe(
      'unrecognized value "foo" for "AUTOCOMMIT": Boolean expected\n',
    );
  });

  test('FETCH_COUNT non-integer errors with upstream wording', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'FETCH_COUNT foo', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe(
      'invalid value "foo" for "FETCH_COUNT": integer expected\n',
    );
  });

  test('ON_ERROR_ROLLBACK invalid value errors with upstream multi-line wording', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'ON_ERROR_ROLLBACK foo', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe(
      'unrecognized value "foo" for "ON_ERROR_ROLLBACK"\n' +
        'Available values are: on, off, interactive.\n',
    );
  });
});

describe('\\unset', () => {
  test('removes var', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set('X', 'y');
    const ctx = makeMockCtx('unset', 'X', settings);
    const r = await run(cmdUnset, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.has('X')).toBe(false);
  });

  test('no arg errors', async () => {
    const ctx = makeMockCtx('unset', '');
    const r = await run(cmdUnset, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/missing required argument/);
  });
});

describe('\\getenv', () => {
  test('copies env var into psql var', async () => {
    process.env.NEONCTL_TEST_VAR_GETENV = 'hello';
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('getenv', 'X NEONCTL_TEST_VAR_GETENV', settings);
    const r = await run(cmdGetenv, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.get('X')).toBe('hello');
    delete process.env.NEONCTL_TEST_VAR_GETENV;
  });

  test('missing args errors', async () => {
    const ctx = makeMockCtx('getenv', 'X');
    const r = await run(cmdGetenv, ctx);
    expect(r.status).toBe('error');
  });

  test('preserves prior value when env undefined (upstream parity)', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set('X', 'old');
    delete process.env.DEFINITELY_NOT_SET_VAR_XYZ;
    const ctx = makeMockCtx('getenv', 'X DEFINITELY_NOT_SET_VAR_XYZ', settings);
    const r = await run(cmdGetenv, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.get('X')).toBe('old');
  });
});

describe('\\setenv', () => {
  test('sets process.env', async () => {
    const ctx = makeMockCtx('setenv', 'NEONCTL_TEST_SETENV hello');
    const r = await run(cmdSetenv, ctx);
    expect(r.status).toBe('ok');
    expect(process.env.NEONCTL_TEST_SETENV).toBe('hello');
    delete process.env.NEONCTL_TEST_SETENV;
  });

  test('deletes process.env when no value', async () => {
    process.env.NEONCTL_TEST_DEL = 'present';
    const ctx = makeMockCtx('setenv', 'NEONCTL_TEST_DEL');
    const r = await run(cmdSetenv, ctx);
    expect(r.status).toBe('ok');
    expect(process.env.NEONCTL_TEST_DEL).toBeUndefined();
  });

  test('rejects name containing =', async () => {
    const ctx = makeMockCtx('setenv', 'BAD=NAME value');
    const r = await run(cmdSetenv, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/must not contain "="/);
  });
});

describe('\\timing', () => {
  test('no arg toggles', async () => {
    const settings = defaultSettings(createVarStore());
    expect(settings.timing).toBe(false);
    const ctx = makeMockCtx('timing', '', settings);
    await run(cmdTiming, ctx);
    expect(settings.timing).toBe(true);
    expect(stdout()).toMatch(/Timing is on\./);
  });

  test('explicit on/off', async () => {
    const settings = defaultSettings(createVarStore());
    settings.timing = true;
    const ctx = makeMockCtx('timing', 'off', settings);
    await run(cmdTiming, ctx);
    expect(settings.timing).toBe(false);
    expect(stdout()).toMatch(/Timing is off\./);
  });

  test('unknown value errors', async () => {
    const ctx = makeMockCtx('timing', 'maybe');
    const r = await run(cmdTiming, ctx);
    expect(r.status).toBe('error');
  });
});

describe('\\errverbose', () => {
  test('reports no previous error', async () => {
    const ctx = makeMockCtx('errverbose', '');
    const r = await run(cmdErrverbose, ctx);
    expect(r.status).toBe('ok');
    expect(stdout()).toMatch(/no previous error/);
  });

  test('prints stored error to stderr (no prefix in stdin/interactive)', async () => {
    const settings = defaultSettings(createVarStore());
    settings.lastErrorResult = { sqlstate: '42P01', message: 'oops' };
    const ctx = makeMockCtx('errverbose', '', settings);
    await run(cmdErrverbose, ctx);
    // Upstream `exec_command_errverbose` writes the verbose re-render to
    // stderr. The `psql:<file>:<n>: ` prefix only fires when
    // `curCmdSource === 'file'` — the default 'stdin' source emits no
    // prefix.
    expect(stderr()).not.toMatch(/^psql: /m);
    expect(stderr()).toMatch(/oops/);
    expect(stderr()).toMatch(/42P01/);
  });
});

describe('formatErrorReport', () => {
  test('default verbosity omits the SQLSTATE but keeps LINE / DETAIL / HINT', () => {
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        code: '42601',
        message: 'syntax error at or near "FOO"',
        detail: 'parse failed',
        hint: 'check spelling',
        position: '8',
        sqlText: 'SELECT FOO FROM bar;',
      },
      'default',
      'errors',
    );
    expect(lines[0]).toBe('ERROR:  syntax error at or near "FOO"');
    // No SQLSTATE prefix on the leading line under default.
    expect(lines[0]).not.toMatch(/42601/);
    expect(lines).toContain('LINE 1: SELECT FOO FROM bar;');
    expect(lines.some((l) => /^\s+\^$/.test(l))).toBe(true);
    expect(lines).toContain('DETAIL:  parse failed');
    expect(lines).toContain('HINT:  check spelling');
  });

  test('verbose verbosity prepends SQLSTATE and adds CONTEXT / LOCATION', () => {
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        code: '42601',
        message: 'boom',
        where: 'PL/pgSQL function foo()',
        routine: 'exec_stmt',
        file: 'pl_exec.c',
        line: '123',
      },
      'verbose',
      'errors',
    );
    expect(lines[0]).toBe('ERROR:  42601: boom');
    expect(lines).toContain('CONTEXT:  PL/pgSQL function foo()');
    expect(lines).toContain('LOCATION:  exec_stmt, pl_exec.c:123');
  });

  test('terse verbosity stops after the severity line', () => {
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        code: '42601',
        message: 'boom',
        detail: 'should NOT appear',
        hint: 'should NOT appear',
      },
      'terse',
      'errors',
    );
    expect(lines).toEqual(['ERROR:  boom']);
  });

  test('SHOW_CONTEXT=never suppresses CONTEXT under default verbosity', () => {
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'boom',
        where: 'somewhere',
      },
      'default',
      'never',
    );
    expect(lines).toEqual(['ERROR:  boom']);
  });

  test('uses two spaces after every label (vanilla parity)', () => {
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        code: '42P01',
        message: 'no such table',
        detail: 'd',
        hint: 'h',
        where: 'w',
        routine: 'r',
        file: 'f.c',
        line: '1',
      },
      'verbose',
      'errors',
    );
    for (const l of lines) {
      // Skip the LINE/caret pair which doesn't follow the "LABEL:  body"
      // shape.
      if (l.startsWith('LINE ') || /^\s+\^$/.test(l)) continue;
      expect(l).toMatch(/^[A-Z]+: {2}/);
    }
  });

  test('leading -- line comments do not inflate LINE N (regress/psql parity)', () => {
    // SQL like `-- subject command should not have executed\nTABLE bububu;`
    // would naively count to LINE 2. Vanilla psql strips the leading
    // comment + whitespace before `PQexec`, and the server's position is
    // 1-based relative to the trimmed buffer — so LINE 1 is the right
    // anchor for the SELECT. Verified against psql.sql line 167.
    const sqlText =
      '-- subject command should not have executed\nTABLE bububu;';
    // Server position is into the BYTES PASSED TO PQexec. Vanilla strips
    // leading whitespace before sending, leaving the `-- comment\n` in
    // place — so position 45 points at `TABLE`, the failing token.
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'relation "bububu" does not exist',
        position: '45',
        sqlText,
      },
      'default',
      'errors',
    );
    expect(lines).toContain('LINE 1: TABLE bububu;');
  });

  test('leading slash-star block comments are skipped too', () => {
    const sqlText = '/* leading\n   block */\nTABLE bububu;';
    // Position 24 is the 1-based byte index of `T` in `TABLE` (after
    // the comment + newline).
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'relation "bububu" does not exist',
        position: '24',
        sqlText,
      },
      'default',
      'errors',
    );
    expect(lines).toContain('LINE 1: TABLE bububu;');
  });

  test('nested block comments are tracked', () => {
    const sqlText = '/* outer /* inner */ closing */ TABLE bububu;';
    // Pre-strip prelude leaves `TABLE bububu;`; position 33 points at `T`.
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'relation "bububu" does not exist',
        position: '33',
        sqlText,
      },
      'default',
      'errors',
    );
    expect(lines).toContain('LINE 1: TABLE bububu;');
  });

  test('intermediate comments still bump the LINE count', () => {
    // The fix only strips LEADING prelude. A `-- comment` on a line
    // before the failing statement (with non-comment content elsewhere)
    // should still bump LINE because it's part of the executed statement.
    const sqlText = 'SELECT 1\n-- middle comment\nWHERE foo;';
    // Position 28 points just inside the WHERE — server-reported line 3.
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'syntax error at or near "WHERE"',
        position: '28',
        sqlText,
      },
      'default',
      'errors',
    );
    expect(lines).toContain('LINE 3: WHERE foo;');
  });

  test('caret snaps past trailing whitespace when position lands in it', () => {
    // `cmd_io.ts` `\g`/`\gdesc`/etc strip trailing whitespace from the
    // buffer before sending, so the server's "syntax error at end of
    // input" position is relative to the trimmed SQL while sqlText still
    // carries the trailing space. Vanilla psql sends the trailing space
    // verbatim and the server reports position = full_len + 1, so the
    // caret sits one column past the last visible char. We re-create
    // that column by snapping past the trailing whitespace whenever
    // position would otherwise land inside it.
    const sqlText = 'SELECT 1 + '; // 11 chars including trailing space
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'syntax error at end of input',
        // 11 == trimmed length + 1; idx would naively land on the space.
        position: '11',
        sqlText,
      },
      'default',
      'errors',
    );
    // Vanilla shape: `LINE 1: SELECT 1 + \n                   ^`
    // 'LINE 1: ' = 8 chars, sqlText length = 11, so caret column = 19.
    expect(lines).toContain('LINE 1: SELECT 1 + ');
    const caret = lines.find((l) => /^\s+\^$/.test(l));
    expect(caret).toBeDefined();
    expect(caret).toBe(`${' '.repeat(19)}^`);
  });

  test('caret snaps past multiple trailing spaces (still at end-of-line)', () => {
    // Same trim-on-send delta but with three trailing spaces — caret
    // should still land one column past the last space, matching vanilla.
    const sqlText = 'SELECT 1 +   '; // 13 chars including 3 trailing spaces
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'syntax error at end of input',
        position: '13', // trimmed length + 1 = 10 + 1 = 11 — but server's
        // actual report is 11 here. The snap should still push the caret
        // to the end of the unstripped lineText.
        sqlText,
      },
      'default',
      'errors',
    );
    const caret = lines.find((l) => /^\s+\^$/.test(l));
    expect(caret).toBeDefined();
    // 'LINE 1: ' = 8, sqlText length = 13 -> caret at column 21.
    expect(caret).toBe(`${' '.repeat(21)}^`);
  });

  test('multi-line trailing whitespace on the error line snaps to end-of-line', () => {
    // sqlText carries `+ \n` on line 2; server sends position relative
    // to the trimmed buffer (`SELECT 1\n+`). Trim-snap pushes the caret
    // past the trailing space so the column matches vanilla.
    const sqlText = 'SELECT 1\n+ \n';
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'syntax error at end of input',
        // 11 == trimmed length + 1 for "SELECT 1\n+" (10 chars).
        position: '11',
        sqlText,
      },
      'default',
      'errors',
    );
    expect(lines).toContain('LINE 2: + ');
    const caret = lines.find((l) => /^\s+\^$/.test(l));
    expect(caret).toBeDefined();
    // 'LINE 2: ' = 8, line 2 length = 2 ("+ ") -> caret at column 10.
    expect(caret).toBe(`${' '.repeat(10)}^`);
  });

  test('caret on whitespace-free SQL still works (in-token errors unaffected)', () => {
    // Sanity: when the SQL has no trailing whitespace, the trim-snap is
    // a no-op and the standard column math still produces the right
    // caret. Position 8 points at `f` of `foo`.
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'column "foo" does not exist',
        position: '8',
        sqlText: 'SELECT foo',
      },
      'default',
      'errors',
    );
    expect(lines).toContain('LINE 1: SELECT foo');
    const caret = lines.find((l) => /^\s+\^$/.test(l));
    expect(caret).toBe(`${' '.repeat(15)}^`);
  });

  test('caret on trailing-space line points at mid-line token, not end (no false snap)', () => {
    // Same sqlText with trailing space, but position points INSIDE a
    // token (not at end-of-input). The snap heuristic must not fire.
    // Position 8 -> `f` of `foo`, which is at column 7 within the
    // unstripped lineText.
    const lines = formatErrorReport(
      {
        severity: 'ERROR',
        message: 'column "foo" does not exist',
        position: '8',
        sqlText: 'SELECT foo ', // trailing space
      },
      'default',
      'errors',
    );
    expect(lines).toContain('LINE 1: SELECT foo ');
    const caret = lines.find((l) => /^\s+\^$/.test(l));
    // 'LINE 1: ' = 8 + col 7 = 15.
    expect(caret).toBe(`${' '.repeat(15)}^`);
  });
});

describe('\\!', () => {
  test('runs echo via shell (smoke)', async () => {
    // We can't easily capture child-stdio because spawnSync inherits.
    // Best we can do without a heavy mock: confirm the call returns ok.
    const ctx = makeMockCtx('!', 'true');
    const r = await run(cmdShell, ctx);
    expect(r.status).toBe('ok');
  });

  test('non-zero-exit command still returns ok (REPL keeps running)', async () => {
    // `false` always exits 1. Upstream `do_shell` swallows the failure so the
    // REPL stays alive — make sure we do the same.
    const ctx = makeMockCtx('!', 'false');
    const r = await run(cmdShell, ctx);
    expect(r.status).toBe('ok');
  });

  test('command that does not exist still returns ok', async () => {
    // Run a command that's guaranteed to fail to spawn through `sh -c`. The
    // shell returns 127, which we ignore — the REPL must not crash.
    const ctx = makeMockCtx('!', '/definitely/does/not/exist/binary-xyz');
    const r = await run(cmdShell, ctx);
    expect(r.status).toBe('ok');
  });

  // Note: full stdio capture would require mocking `child_process.spawnSync`,
  // which is doable but fragile. Documenting that gap here.
  test.skip('captures stdout (skipped: requires child_process mock)', () => {
    void vi;
  });
});

describe('\\copyright', () => {
  test('prints PostgreSQL copyright notice to stdout', async () => {
    const ctx = makeMockCtx('copyright', '');
    const r = await run(cmdCopyright, ctx);
    expect(r.status).toBe('ok');
    const out = stdout();
    // Upstream `psql_like($node, '\copyright', qr/Copyright/, ...)`.
    expect(out).toMatch(/Copyright/);
    expect(out).toContain('PostgreSQL Database Management System');
    expect(out).toContain('PostgreSQL Global Development Group');
  });

  test('ignores extra arguments', async () => {
    const ctx = makeMockCtx('copyright', 'these are ignored');
    const r = await run(cmdCopyright, ctx);
    expect(r.status).toBe('ok');
    expect(stdout()).toMatch(/Copyright/);
  });
});

describe('\\h / \\help (SQL command help)', () => {
  test('no topic lists every command (matches /ALTER/)', async () => {
    const ctx = makeMockCtx('h', '');
    const r = await run(cmdHelpSQL, ctx);
    expect(r.status).toBe('ok');
    const out = stdout();
    expect(out).toMatch(/Available help/);
    // Upstream `\help` matcher in 001_basic.pl line 76: `qr/ALTER/`.
    expect(out).toMatch(/ALTER/);
  });

  test('SELECT topic prints the SELECT synopsis', async () => {
    const ctx = makeMockCtx('h', 'SELECT');
    const r = await run(cmdHelpSQL, ctx);
    expect(r.status).toBe('ok');
    const out = stdout();
    expect(out).toMatch(/SELECT/);
  });

  test('unknown topic emits "No help available" hint', async () => {
    const ctx = makeMockCtx('h', 'definitely-not-a-real-command');
    const r = await run(cmdHelpSQL, ctx);
    expect(r.status).toBe('ok');
    expect(stdout()).toMatch(/No help available/);
  });

  test('aliases include `help` so `\\help` resolves to the same spec', () => {
    // The alias is a config-level fact; just assert it's on the spec so a
    // future refactor that drops it would break this test.
    expect(cmdHelpSQL.aliases).toContain('help');
  });
});
