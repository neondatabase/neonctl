import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { BackslashContext, BackslashCmdSpec } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  cmdRestrict,
  cmdUnrestrict,
  isCommandRestricted,
  isRestricted,
  registerRestrictCommands,
  RESTRICTED_COMMANDS,
  RESTRICTED_VAR,
  restrictedName,
} from './cmd_restrict.js';
import {
  createBackslashRegistry,
  defaultRegistry,
  dispatchBackslash,
} from './dispatch.js';
import { cmdQuit } from './cmd_meta.js';

// ---------------------------------------------------------------------------
// Lightweight mock context — same shape as cmd_meta.test.ts, scoped down to
// what `\restrict` and `\unrestrict` need (one positional arg, no quoting).
// ---------------------------------------------------------------------------

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

// stderr capture (the commands emit error diagnostics to stderr).
let stderrChunks: string[];
let stderrOrig: typeof process.stderr.write;

beforeEach(() => {
  stderrChunks = [];
  stderrOrig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = stderrOrig;
});

const stderr = (): string => stderrChunks.join('');
const run = (spec: BackslashCmdSpec, ctx: BackslashContext) => spec.run(ctx);

// ---------------------------------------------------------------------------
// `\restrict` — enter restricted mode
// ---------------------------------------------------------------------------

describe('\\restrict', () => {
  test('sets RESTRICTED psql variable on success', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('restrict', 'mykey', settings);
    const r = await run(cmdRestrict, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.get(RESTRICTED_VAR)).toBe('mykey');
    expect(isRestricted(settings)).toBe(true);
    expect(restrictedName(settings)).toBe('mykey');
  });

  test('errors when no key is provided', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('restrict', '', settings);
    const r = await run(cmdRestrict, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/missing required argument/);
    expect(settings.vars.get(RESTRICTED_VAR)).toBeUndefined();
  });

  test('errors when already restricted', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'first');
    const ctx = makeMockCtx('restrict', 'second', settings);
    const r = await run(cmdRestrict, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/already in restricted mode/);
    // Original key is preserved.
    expect(settings.vars.get(RESTRICTED_VAR)).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// `\unrestrict` — leave restricted mode
// ---------------------------------------------------------------------------

describe('\\unrestrict', () => {
  test('clears RESTRICTED when key matches', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'mykey');
    const ctx = makeMockCtx('unrestrict', 'mykey', settings);
    const r = await run(cmdUnrestrict, ctx);
    expect(r.status).toBe('ok');
    expect(settings.vars.get(RESTRICTED_VAR)).toBeUndefined();
    expect(isRestricted(settings)).toBe(false);
  });

  test('errors when not currently restricted', async () => {
    const settings = defaultSettings(createVarStore());
    const ctx = makeMockCtx('unrestrict', 'mykey', settings);
    const r = await run(cmdUnrestrict, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/not currently in restricted mode/);
  });

  test('errors on mismatched key and stays restricted', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'realkey');
    const ctx = makeMockCtx('unrestrict', 'wrongkey', settings);
    const r = await run(cmdUnrestrict, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/wrong key/);
    expect(settings.vars.get(RESTRICTED_VAR)).toBe('realkey');
    expect(isRestricted(settings)).toBe(true);
  });

  test('errors when no key is provided', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'mykey');
    const ctx = makeMockCtx('unrestrict', '', settings);
    const r = await run(cmdUnrestrict, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/missing required argument/);
    // Still restricted because we never consumed a key.
    expect(isRestricted(settings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

describe('isRestricted / restrictedName / isCommandRestricted', () => {
  test('unset variable means not restricted', () => {
    const settings = defaultSettings(createVarStore());
    expect(isRestricted(settings)).toBe(false);
    expect(restrictedName(settings)).toBeNull();
    expect(isCommandRestricted(settings, '!')).toBe(false);
    expect(isCommandRestricted(settings, 'cd')).toBe(false);
  });

  test('empty-string variable means not restricted', () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, '');
    expect(isRestricted(settings)).toBe(false);
    expect(restrictedName(settings)).toBeNull();
  });

  test('non-empty variable means restricted', () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'k');
    expect(isRestricted(settings)).toBe(true);
    expect(restrictedName(settings)).toBe('k');
  });

  test('isCommandRestricted gates the documented set', () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'k');
    for (const name of RESTRICTED_COMMANDS) {
      expect(isCommandRestricted(settings, name)).toBe(true);
    }
    // Sanity: a handful of commands NOT in the set are allowed.
    expect(isCommandRestricted(settings, 'q')).toBe(false);
    expect(isCommandRestricted(settings, 'echo')).toBe(false);
    expect(isCommandRestricted(settings, 'set')).toBe(false);
    expect(isCommandRestricted(settings, 'unrestrict')).toBe(false);
  });

  test('RESTRICTED_COMMANDS set covers the documented commands', () => {
    // Mirrors the WP brief.
    expect(RESTRICTED_COMMANDS.has('!')).toBe(true);
    expect(RESTRICTED_COMMANDS.has('cd')).toBe(true);
    expect(RESTRICTED_COMMANDS.has('copy')).toBe(true);
    expect(RESTRICTED_COMMANDS.has('setenv')).toBe(true);
    expect(RESTRICTED_COMMANDS.has('w')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry integration: dispatchBackslash gate
// ---------------------------------------------------------------------------

describe('dispatchBackslash restriction gate', () => {
  test('forbidden command refused while restricted', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'k');
    const r = createBackslashRegistry();
    registerRestrictCommands(r);
    // Stub `\!` so we can prove it's not invoked.
    let shellRan = false;
    r.register({
      name: '!',
      argMode: 'whole-line',
      run: () => {
        shellRan = true;
        return Promise.resolve({ status: 'ok' });
      },
    });
    const ctx = makeMockCtx('!', 'echo hi', settings);
    const result = await dispatchBackslash(r, '!', ctx);
    expect(result.status).toBe('error');
    expect(shellRan).toBe(false);
    expect(stderr()).toMatch(/not allowed in restricted mode/);
  });

  test('alias for forbidden command (\\write → \\w) is refused', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'k');
    const r = createBackslashRegistry();
    registerRestrictCommands(r);
    let ran = false;
    r.register({
      name: 'w',
      aliases: ['write'],
      run: () => {
        ran = true;
        return Promise.resolve({ status: 'ok' });
      },
    });
    const ctx = makeMockCtx('write', '/tmp/q.sql', settings);
    const result = await dispatchBackslash(r, 'write', ctx);
    expect(result.status).toBe('error');
    expect(ran).toBe(false);
  });

  test('neutral command runs while restricted', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'k');
    const r = createBackslashRegistry();
    registerRestrictCommands(r);
    r.register(cmdQuit);
    const ctx = makeMockCtx('q', '', settings);
    const result = await dispatchBackslash(r, 'q', ctx);
    expect(result.status).toBe('exit');
  });

  test('\\unrestrict runs while restricted', async () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set(RESTRICTED_VAR, 'k');
    const r = defaultRegistry();
    const ctx = makeMockCtx('unrestrict', 'k', settings);
    const result = await dispatchBackslash(r, 'unrestrict', ctx);
    expect(result.status).toBe('ok');
    expect(isRestricted(settings)).toBe(false);
  });

  test('round-trip \\restrict → forbidden refused → \\unrestrict → forbidden allowed', async () => {
    const settings = defaultSettings(createVarStore());
    const r = createBackslashRegistry();
    registerRestrictCommands(r);
    let shellInvocations = 0;
    r.register({
      name: '!',
      argMode: 'whole-line',
      run: () => {
        shellInvocations += 1;
        return Promise.resolve({ status: 'ok' });
      },
    });

    // Initially unrestricted: `\!` runs.
    let result = await dispatchBackslash(
      r,
      '!',
      makeMockCtx('!', 'echo hi', settings),
    );
    expect(result.status).toBe('ok');
    expect(shellInvocations).toBe(1);

    // Enter restricted mode.
    result = await dispatchBackslash(
      r,
      'restrict',
      makeMockCtx('restrict', 'mykey', settings),
    );
    expect(result.status).toBe('ok');

    // `\!` now refused.
    result = await dispatchBackslash(
      r,
      '!',
      makeMockCtx('!', 'echo hi', settings),
    );
    expect(result.status).toBe('error');
    expect(shellInvocations).toBe(1);

    // `\unrestrict` with wrong key keeps us locked.
    result = await dispatchBackslash(
      r,
      'unrestrict',
      makeMockCtx('unrestrict', 'wrong', settings),
    );
    expect(result.status).toBe('error');
    expect(isRestricted(settings)).toBe(true);

    // Correct key leaves restricted mode.
    result = await dispatchBackslash(
      r,
      'unrestrict',
      makeMockCtx('unrestrict', 'mykey', settings),
    );
    expect(result.status).toBe('ok');

    // `\!` runs again.
    result = await dispatchBackslash(
      r,
      '!',
      makeMockCtx('!', 'echo hi', settings),
    );
    expect(result.status).toBe('ok');
    expect(shellInvocations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// defaultRegistry ships the two commands
// ---------------------------------------------------------------------------

describe('defaultRegistry includes restrict commands', () => {
  test('lookup finds \\restrict', () => {
    const r = defaultRegistry();
    expect(r.lookup('restrict')?.name).toBe('restrict');
  });
  test('lookup finds \\unrestrict', () => {
    const r = defaultRegistry();
    expect(r.lookup('unrestrict')?.name).toBe('unrestrict');
  });
});
