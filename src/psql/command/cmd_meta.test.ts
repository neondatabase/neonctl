import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BackslashContext, BackslashCmdSpec } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  cmdCd,
  cmdEcho,
  cmdErrverbose,
  cmdGetenv,
  cmdQecho,
  cmdQuit,
  cmdSet,
  cmdSetenv,
  cmdShell,
  cmdTiming,
  cmdUnset,
  cmdWarn,
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

  test('invalid name errors', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('set', '1bad value', settings);
    const r = await run(cmdSet, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/error while setting/);
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

  test('prints stored error', async () => {
    const settings = defaultSettings(createVarStore());
    settings.lastErrorResult = { sqlstate: '42P01', message: 'oops' };
    const ctx = makeMockCtx('errverbose', '', settings);
    await run(cmdErrverbose, ctx);
    expect(stdout()).toMatch(/oops/);
    expect(stdout()).toMatch(/42P01/);
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

  // Note: full stdio capture would require mocking `child_process.spawnSync`,
  // which is doable but fragile. Documenting that gap here.
  test.skip('captures stdout (skipped: requires child_process mock)', () => {
    void vi;
  });
});
