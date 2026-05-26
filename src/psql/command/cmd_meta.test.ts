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

  test('multiple args join with space', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'X Y Z W', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.get('X')).toBe('Y Z W');
  });

  test('invalid name errors with upstream "invalid variable name" wording', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', '1bad value', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    // Upstream `exec_command_set` emits `invalid variable name: "<name>"`
    // via `pg_log_error`, which prepends the `psql:` diagnostic prefix.
    expect(stderr()).toMatch(/^psql: invalid variable name: "1bad"\n$/);
  });

  test('invalid characters in name (e.g. "/" — regress/psql line 9)', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', 'invalid/name foo', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toBe('psql: invalid variable name: "invalid/name"\n');
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

  test('unsets when env undefined', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set('X', 'old');
    delete process.env.DEFINITELY_NOT_SET_VAR_XYZ;
    const ctx = makeMockCtx('getenv', 'X DEFINITELY_NOT_SET_VAR_XYZ', settings);
    await run(cmdGetenv, ctx);
    expect(settings.vars.has('X')).toBe(false);
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

  test('prints stored error to stderr with psql: prefix', async () => {
    const settings = defaultSettings(createVarStore());
    settings.lastErrorResult = { sqlstate: '42P01', message: 'oops' };
    const ctx = makeMockCtx('errverbose', '', settings);
    await run(cmdErrverbose, ctx);
    // Upstream `exec_command_errverbose` writes the verbose re-render to
    // stderr (via `pg_log_error`), with the `psql: ` diagnostic prefix on
    // the leading severity line.
    expect(stderr()).toMatch(/^psql: /m);
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
