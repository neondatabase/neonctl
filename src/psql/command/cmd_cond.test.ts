import { describe, expect, test, vi } from 'vitest';

import type { BackslashContext, BackslashResult } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';
import {
  COND_COMMAND_NAMES,
  attachCondStack,
  cmdElif,
  cmdElse,
  cmdEndif,
  cmdIf,
  createCondStack,
  parseBool,
} from './cmd_cond.js';

/**
 * Capture writes to `process.stderr.write` for the lifetime of `fn`. Returns
 * the concatenated text. Used to assert cond commands emit their
 * `unrecognized value` / `\<cmd>: <msg>` diagnostics BARE (no `psql: ERROR:`
 * prefix — that fallback is the mainloop's job and is suppressed via
 * `errorWritten: true`).
 */
const captureStderr = async (fn: () => Promise<void>): Promise<string> => {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((data: string | Uint8Array): boolean => {
      chunks.push(
        typeof data === 'string' ? data : Buffer.from(data).toString(),
      );
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeSettings = (): PsqlSettings => defaultSettings(createVarStore());

/**
 * `BackslashContext` exposes `nextArg` as a non-recordable method, so unit
 * tests need a wrapper that lets us count calls (to verify upstream's
 * `ignore_boolean_expression` semantics — when the cond is inactive, `\if` /
 * `\elif` MUST NOT call `nextArg` because the slash scanner would expand
 * backticks and `:vars` eagerly). The extra `__nextArgCalls` field is for
 * tests only.
 */
type TestBackslashContext = BackslashContext & {
  __nextArgCalls: { count: number };
};

const makeCtx = (
  settings: PsqlSettings,
  cmdName: string,
  args: string[],
): TestBackslashContext => {
  // Use a per-mode cursor list shared between calls so nextArg behaves
  // consistently. The cond commands only ask for 'normal'.
  let cursor = 0;
  const calls = { count: 0 };
  const ctx: TestBackslashContext = {
    settings,
    cmdName,
    queryBuf: '',
    rawArgs: args.join(' '),
    nextArg(): string | null {
      calls.count += 1;
      if (cursor >= args.length) return null;
      const v = args[cursor];
      cursor += 1;
      return v;
    },
    restOfLine(): string {
      return args.slice(cursor).join(' ');
    },
    __nextArgCalls: calls,
  };
  return ctx;
};

const run = async (
  spec: { run: (ctx: BackslashContext) => Promise<BackslashResult> },
  ctx: BackslashContext,
): Promise<BackslashResult> => spec.run(ctx);

// ---------------------------------------------------------------------------
// parseBool — mirrors psql's ParseVariableBool semantics
// ---------------------------------------------------------------------------

describe('parseBool', () => {
  test('explicit true tokens', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool('TRUE')).toBe(true);
    expect(parseBool('t')).toBe(true);
    expect(parseBool('yes')).toBe(true);
    expect(parseBool('y')).toBe(true);
    expect(parseBool('on')).toBe(true);
    expect(parseBool('1')).toBe(true);
  });

  test('explicit false tokens', () => {
    expect(parseBool('false')).toBe(false);
    expect(parseBool('FALSE')).toBe(false);
    expect(parseBool('f')).toBe(false);
    expect(parseBool('no')).toBe(false);
    expect(parseBool('n')).toBe(false);
    expect(parseBool('off')).toBe(false);
    expect(parseBool('0')).toBe(false);
  });

  test('bare "o" is ambiguous and rejected', () => {
    expect(parseBool('o')).toBe(null);
  });

  test('empty string is rejected', () => {
    expect(parseBool('')).toBe(null);
  });

  test('garbage tokens are rejected', () => {
    expect(parseBool('garbage')).toBe(null);
    expect(parseBool('42')).toBe(null);
    expect(parseBool('-1')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// CondStack state machine
// ---------------------------------------------------------------------------

describe('createCondStack', () => {
  test('empty stack reports active and depth 0', () => {
    const c = createCondStack();
    expect(c.depth()).toBe(0);
    expect(c.isActive()).toBe(true);
    expect(c.top()).toBeUndefined();
  });

  test('push / pop / top', () => {
    const c = createCondStack();
    c.push('true');
    expect(c.depth()).toBe(1);
    expect(c.top()?.state).toBe('true');
    c.push('false');
    expect(c.depth()).toBe(2);
    expect(c.top()?.state).toBe('false');
    expect(c.pop()?.state).toBe('false');
    expect(c.top()?.state).toBe('true');
    c.pop();
    expect(c.depth()).toBe(0);
  });

  test('isActive matches upstream conditional_active for each state', () => {
    const c = createCondStack();

    c.push('true');
    expect(c.isActive()).toBe(true);
    c.pop();

    c.push('false');
    expect(c.isActive()).toBe(false);
    c.pop();

    c.push('ignored');
    expect(c.isActive()).toBe(false);
    c.pop();

    c.push('else-true');
    expect(c.isActive()).toBe(true);
    c.pop();

    c.push('else-false');
    expect(c.isActive()).toBe(false);
    c.pop();
  });

  test('setState mutates the top frame', () => {
    const c = createCondStack();
    c.push('false');
    expect(c.top()?.state).toBe('false');
    c.setState('true');
    expect(c.top()?.state).toBe('true');
    expect(c.top()?.branchTaken).toBe(true);
  });

  test('setState on empty stack is a no-op', () => {
    const c = createCondStack();
    expect(() => {
      c.setState('true');
    }).not.toThrow();
    expect(c.depth()).toBe(0);
  });

  test('transitive suppression: \\if inside inactive outer pushes IGNORED', () => {
    // Simulates: outer \if false { inner \if true { ... } \endif }
    // The mainloop pushes IGNORED when the outer is inactive (matches upstream).
    const c = createCondStack();
    c.push('false'); // outer
    // Outer is inactive — emulate cmdIf checking isActive() first.
    const outerActive = c.isActive();
    expect(outerActive).toBe(false);
    if (!outerActive) c.push('ignored');
    expect(c.isActive()).toBe(false);
    c.pop();
    c.pop();
    expect(c.depth()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cmdIf
// ---------------------------------------------------------------------------

describe('cmdIf', () => {
  test('truthy arg pushes TRUE frame and activates branch', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.depth()).toBe(1);
    expect(cond.top()?.state).toBe('true');
    expect(cond.isActive()).toBe(true);
  });

  test('falsy arg pushes FALSE frame and deactivates', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', ['off']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('false');
    expect(cond.isActive()).toBe(false);
  });

  test('garbage arg falls back to false (unrecognised expression)', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', ['banana']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('false');
    expect(settings.lastErrorResult?.message).toMatch(
      /unrecognized value "banana"/,
    );
  });

  test('missing arg evaluates to false', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('false');
  });

  test('inside inactive outer, pushes IGNORED regardless of arg', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false'); // outer
    const ctx = makeCtx(settings, 'if', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.depth()).toBe(2);
    expect(cond.top()?.state).toBe('ignored');
    expect(cond.isActive()).toBe(false);
  });

  test('various bool input encodings', async () => {
    for (const [value, expected] of [
      ['true', 'true'],
      ['false', 'false'],
      ['yes', 'true'],
      ['no', 'false'],
      ['on', 'true'],
      ['off', 'false'],
      ['1', 'true'],
      ['0', 'false'],
    ] as const) {
      const settings = makeSettings();
      const cond = createCondStack();
      const ctx = makeCtx(settings, 'if', [value]);
      attachCondStack(ctx, cond);
      await run(cmdIf, ctx);
      expect(cond.top()?.state).toBe(expected);
    }
  });

  // Upstream's slash lexer recognises `:{?name}` directly and substitutes
  // `TRUE` / `FALSE` based on whether the named variable is defined. Our
  // scanner only handles plain `:name`, `:'name'`, `:"name"`, so the cond
  // expression evaluator does the `:{?name}` substitution after joining
  // args. See regress/psql.sql ~line 1104.
  test(':{?name} substitutes to TRUE when variable is defined', async () => {
    const settings = makeSettings();
    settings.vars.set('i', '1');
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', [':{?i}']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('true');
  });

  test(':{?name} substitutes to FALSE when variable is undefined', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', [':{?no_such_variable}']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// cmdElif
// ---------------------------------------------------------------------------

describe('cmdElif', () => {
  test('\\elif: no matching \\if when stack empty', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'elif', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('error');
    expect(settings.lastErrorResult?.message).toBe('\\elif: no matching \\if');
  });

  test('top TRUE: branch already taken; flips to IGNORED', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('true');
    const ctx = makeCtx(settings, 'elif', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('ignored');
  });

  test('top FALSE with truthy arg: flips to TRUE', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false');
    const ctx = makeCtx(settings, 'elif', ['1']);
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('true');
  });

  test('top FALSE with falsy arg: stays FALSE', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false');
    const ctx = makeCtx(settings, 'elif', ['0']);
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('false');
  });

  test('top IGNORED: stays IGNORED', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('ignored');
    const ctx = makeCtx(settings, 'elif', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('ignored');
  });

  test('top ELSE_TRUE: cannot occur after \\else', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('else-true');
    const ctx = makeCtx(settings, 'elif', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('error');
    expect(settings.lastErrorResult?.message).toBe(
      '\\elif: cannot occur after \\else',
    );
  });

  test('top ELSE_FALSE: cannot occur after \\else', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('else-false');
    const ctx = makeCtx(settings, 'elif', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// cmdElse
// ---------------------------------------------------------------------------

describe('cmdElse', () => {
  test('no matching \\if', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'else', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdElse, ctx);
    expect(r.status).toBe('error');
    expect(settings.lastErrorResult?.message).toBe('\\else: no matching \\if');
  });

  test('top TRUE → ELSE_FALSE', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('true');
    const ctx = makeCtx(settings, 'else', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdElse, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('else-false');
  });

  test('top FALSE → ELSE_TRUE', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false');
    const ctx = makeCtx(settings, 'else', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdElse, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('else-true');
  });

  test('top IGNORED → ELSE_FALSE', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('ignored');
    const ctx = makeCtx(settings, 'else', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdElse, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('else-false');
  });

  test('top ELSE_TRUE: cannot occur after \\else', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('else-true');
    const ctx = makeCtx(settings, 'else', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdElse, ctx);
    expect(r.status).toBe('error');
    expect(settings.lastErrorResult?.message).toBe(
      '\\else: cannot occur after \\else',
    );
  });
});

// ---------------------------------------------------------------------------
// cmdEndif
// ---------------------------------------------------------------------------

describe('cmdEndif', () => {
  test('no matching \\if', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'endif', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdEndif, ctx);
    expect(r.status).toBe('error');
    expect(settings.lastErrorResult?.message).toBe('\\endif: no matching \\if');
  });

  test('pops the top frame', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('true');
    cond.push('false');
    const ctx = makeCtx(settings, 'endif', []);
    attachCondStack(ctx, cond);
    const r = await run(cmdEndif, ctx);
    expect(r.status).toBe('ok');
    expect(cond.depth()).toBe(1);
    expect(cond.top()?.state).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe('COND_COMMAND_NAMES', () => {
  test('contains all four conditional commands', () => {
    expect(COND_COMMAND_NAMES.has('if')).toBe(true);
    expect(COND_COMMAND_NAMES.has('elif')).toBe(true);
    expect(COND_COMMAND_NAMES.has('else')).toBe(true);
    expect(COND_COMMAND_NAMES.has('endif')).toBe(true);
    expect(COND_COMMAND_NAMES.has('echo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Upstream-parity scenarios (psql.sql:899-1118). Each test mirrors a
// canonical script from the regress suite or the task brief, and asserts the
// exact stack transitions + stderr shape vanilla psql produces.
// ---------------------------------------------------------------------------

describe('upstream parity: \\if family', () => {
  // ─── Scenario 1: :VAR interpolation in \if condition ────────────────────
  //
  // Upstream feeds `\if :MYFLAG` through the slash scanner with `OT_NORMAL`,
  // which expands `:MYFLAG` *before* the cond cmd sees the token. The fake
  // makeCtx wrapper here passes the pre-substituted value (`'on'`) directly
  // — mirroring what `scanSlashArgs('normal', varLookup)` would return for
  // a `:MYFLAG` reference. The cond cmd then parses `'on'` → true.
  test('scenario 1: :VAR interp resolves to "on" → branch active', async () => {
    const settings = makeSettings();
    settings.vars.set('MYFLAG', 'on');
    const cond = createCondStack();
    // The slash scanner expands `:MYFLAG` to `on` before nextArg returns it
    // — we simulate that by passing the resolved value directly.
    const ctx = makeCtx(settings, 'if', ['on']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('true');
    expect(cond.isActive()).toBe(true);
  });

  // ─── Scenario 2: integer truthiness ──────────────────────────────────────
  //
  // ParseVariableBool maps 1→true, 0→false (variables.c). The full chain
  // `\if 0 \elif 1` exercises the "false branch falls through to elif"
  // transition: FALSE → TRUE on the elif.
  test('scenario 2: \\if 0 → false; \\elif 1 → true (full elif transition)', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    // \if 0
    {
      const ctx = makeCtx(settings, 'if', ['0']);
      attachCondStack(ctx, cond);
      const r = await run(cmdIf, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('false');
    }
    // \elif 1
    {
      const ctx = makeCtx(settings, 'elif', ['1']);
      attachCondStack(ctx, cond);
      const r = await run(cmdElif, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('true');
      expect(cond.isActive()).toBe(true);
    }
  });

  // ─── Scenario 3: backtick condition ──────────────────────────────────────
  //
  // The slash scanner runs the backtick *before* cmdIf sees the arg —
  // i.e. by the time `nextArg('normal')` returns, the arg is already the
  // backtick stdout (`'true'` or `'false'`). We simulate that here.
  test('scenario 3: backtick output "true" → branch active', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    // Backtick has already been executed; nextArg returns its stdout.
    const ctx = makeCtx(settings, 'if', ['true']);
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('true');
  });

  test('scenario 3b: backtick output with whitespace → unrecognized → false', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    // `echo "true false"` would expand to "true false" — multi-token, fails
    // parseBool. Upstream emits the unrecognized message and pushes false.
    const ctx = makeCtx(settings, 'if', ['true', 'false']);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdIf, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('false');
    });
    expect(stderr).toBe(
      'unrecognized value "true false" for "\\if expression": Boolean expected\n',
    );
  });

  // ─── Scenario 4: skip-mode preserves nesting ────────────────────────────
  //
  // `\if 0 { \if 1 ... \endif }` → outer pushes FALSE, inner is suppressed
  // by isActive() returning false, pushes IGNORED. \endif pops IGNORED, the
  // outer FALSE survives. The deeply-nested \echo MUST NOT print (active
  // branch tracking is the mainloop's job; the cond stack just bookkeeps).
  test('scenario 4: nested \\if inside skip mode pushes IGNORED, depth tracked', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    // outer: \if 0
    {
      const ctx = makeCtx(settings, 'if', ['0']);
      attachCondStack(ctx, cond);
      await run(cmdIf, ctx);
      expect(cond.depth()).toBe(1);
      expect(cond.top()?.state).toBe('false');
    }
    // inner: \if 1 — outer is inactive, so we push IGNORED regardless of arg
    {
      const ctx = makeCtx(settings, 'if', ['1']);
      attachCondStack(ctx, cond);
      await run(cmdIf, ctx);
      expect(cond.depth()).toBe(2);
      expect(cond.top()?.state).toBe('ignored');
      // Critical: ignore_boolean_expression must NOT call nextArg, otherwise
      // upstream's "backticks not run when ignoring extra args" semantics
      // break (psql.sql:1028).
      expect(ctx.__nextArgCalls.count).toBe(0);
    }
    // inner \endif: pops IGNORED
    {
      const ctx = makeCtx(settings, 'endif', []);
      attachCondStack(ctx, cond);
      await run(cmdEndif, ctx);
      expect(cond.depth()).toBe(1);
      expect(cond.top()?.state).toBe('false');
    }
    // outer \endif
    {
      const ctx = makeCtx(settings, 'endif', []);
      attachCondStack(ctx, cond);
      await run(cmdEndif, ctx);
      expect(cond.depth()).toBe(0);
    }
  });

  // ─── Scenario 5: \elif after \else errors with bare diagnostic ──────────
  test('scenario 5: \\elif after \\else emits bare error (no "psql: ERROR:")', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('else-false');
    const ctx = makeCtx(settings, 'elif', ['1']);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdElif, ctx);
      expect(r.status).toBe('error');
      // errorWritten must be true so the mainloop suppresses its
      // `psql: ERROR:  <msg>` fallback.
      expect(r.errorWritten).toBe(true);
      // We MUST NOT have consumed args — `\elif` after `\else` discards
      // tokens via ignore_boolean_expression.
      expect(ctx.__nextArgCalls.count).toBe(0);
    });
    expect(stderr).toBe('\\elif: cannot occur after \\else\n');
    // Sanity: no `psql:` / `ERROR:` prefix.
    expect(stderr).not.toMatch(/psql/);
    expect(stderr).not.toMatch(/ERROR/);
  });

  // ─── Scenario 6: unmatched \endif at top level ──────────────────────────
  test('scenario 6: bare \\endif on empty stack emits bare error', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'endif', []);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdEndif, ctx);
      expect(r.status).toBe('error');
      expect(r.errorWritten).toBe(true);
    });
    expect(stderr).toBe('\\endif: no matching \\if\n');
    expect(stderr).not.toMatch(/psql/);
  });

  // ─── Scenario 7: empty \if expression ───────────────────────────────────
  //
  // Vanilla emits `unrecognized value "" for "\if expression": Boolean
  // expected` (not "missing required argument" — confirmed by direct
  // experiment against PG 18.0). The frame still gets pushed as `false`
  // so the else branch runs.
  test('scenario 7: \\if with no args emits unrecognized "" → pushes false', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', []);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdIf, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('false');
    });
    expect(stderr).toBe(
      'unrecognized value "" for "\\if expression": Boolean expected\n',
    );
    expect(settings.lastErrorResult?.message).toBe(
      'unrecognized value "" for "\\if expression": Boolean expected',
    );
  });

  // ─── Coverage: multi-token \if arg joined with single space ─────────────
  //
  // Upstream `read_boolean_expression` calls the lexer in a loop, joining
  // tokens with `" "`. Our `collectExpr` does the same. Without this the
  // shell-style `\if abc def ghi` would spill the trailing tokens into the
  // query buffer (catastrophic — they get executed as SQL).
  test('multi-token expression: \\if abc def ghi → joined → unrecognized', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', ['abc', 'def', 'ghi']);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdIf, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('false');
    });
    expect(stderr).toBe(
      'unrecognized value "abc def ghi" for "\\if expression": Boolean expected\n',
    );
  });

  test('multi-token \\if true extra → unrecognized (trailing junk poisons)', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', ['true', 'extra']);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdIf, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('false');
    });
    expect(stderr).toBe(
      'unrecognized value "true extra" for "\\if expression": Boolean expected\n',
    );
  });

  // ─── Coverage: \elif evalExpr emits "\elif expression" key ──────────────
  test('elif: unrecognized arg emits "\\elif expression" diagnostic', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false');
    const ctx = makeCtx(settings, 'elif', ['invalid', 'expr']);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdElif, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('false');
    });
    expect(stderr).toBe(
      'unrecognized value "invalid expr" for "\\elif expression": Boolean expected\n',
    );
  });

  test('elif: empty arg emits unrecognized "" with elif expression key', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false');
    const ctx = makeCtx(settings, 'elif', []);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdElif, ctx);
      expect(r.status).toBe('ok');
      expect(cond.top()?.state).toBe('false');
    });
    expect(stderr).toBe(
      'unrecognized value "" for "\\elif expression": Boolean expected\n',
    );
  });

  // ─── Coverage: cmdIf in inactive branch SKIPS arg expansion ─────────────
  //
  // Direct unit-level proof that the upstream `ignore_boolean_expression`
  // contract holds: when the outer is inactive, cmdIf never calls
  // `nextArg`, so the slash scanner never expands backticks.
  test('cmdIf in inactive branch never calls nextArg (backticks/vars suppressed)', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false'); // outer inactive
    const ctx = makeCtx(settings, 'if', ['anything']);
    attachCondStack(ctx, cond);
    await run(cmdIf, ctx);
    expect(ctx.__nextArgCalls.count).toBe(0);
    expect(cond.top()?.state).toBe('ignored');
  });

  test('cmdElif in TRUE branch never calls nextArg (already-taken → IGNORED)', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('true');
    const ctx = makeCtx(settings, 'elif', ['anything']);
    attachCondStack(ctx, cond);
    await run(cmdElif, ctx);
    expect(ctx.__nextArgCalls.count).toBe(0);
    expect(cond.top()?.state).toBe('ignored');
  });

  test('cmdElif in IGNORED branch never calls nextArg', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('ignored');
    const ctx = makeCtx(settings, 'elif', ['anything']);
    attachCondStack(ctx, cond);
    await run(cmdElif, ctx);
    expect(ctx.__nextArgCalls.count).toBe(0);
    expect(cond.top()?.state).toBe('ignored');
  });

  // ─── Coverage: all error paths are bare ─────────────────────────────────
  test('\\else: cannot occur after \\else emits bare error', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('else-true');
    const ctx = makeCtx(settings, 'else', []);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdElse, ctx);
      expect(r.status).toBe('error');
      expect(r.errorWritten).toBe(true);
    });
    expect(stderr).toBe('\\else: cannot occur after \\else\n');
  });

  test('\\else: no matching \\if (empty stack) emits bare error', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'else', []);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdElse, ctx);
      expect(r.status).toBe('error');
      expect(r.errorWritten).toBe(true);
    });
    expect(stderr).toBe('\\else: no matching \\if\n');
  });

  test('\\elif: no matching \\if (empty stack) emits bare error', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'elif', ['true']);
    attachCondStack(ctx, cond);
    const stderr = await captureStderr(async () => {
      const r = await run(cmdElif, ctx);
      expect(r.status).toBe('error');
      expect(r.errorWritten).toBe(true);
      // Even on the error path, we don't consume args (ignore_boolean_expression).
      expect(ctx.__nextArgCalls.count).toBe(0);
    });
    expect(stderr).toBe('\\elif: no matching \\if\n');
  });
});

// ---------------------------------------------------------------------------
// save_query_text_state / discard_query_text — buffer rollback on
// transition out of an INACTIVE branch.
//
// Upstream `exec_command_if` captures `query_buf->len` (and the scanner
// state) on push; `exec_command_elif`/`_else`/`_endif` invoke
// `discard_query_text` when the just-completed branch was INACTIVE, so SQL
// text the skipped branch accumulated doesn't bleed into the surrounding
// statement. Our port plumbs this via `savedQueryBufLen` on the frame +
// the `truncateBufTo` field on the BackslashResult (applied by mainloop).
// ---------------------------------------------------------------------------

describe('cond buffer save/discard (savedQueryBufLen / truncateBufTo)', () => {
  test('\\if captures ctx.queryBuf.length on push', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    const ctx = makeCtx(settings, 'if', ['true']);
    ctx.queryBuf = 'select\n  ';
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.savedQueryBufLen).toBe('select\n  '.length);
  });

  test('\\if while inactive (push IGNORED) still captures savedLen', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false'); // outer inactive
    const ctx = makeCtx(settings, 'if', ['true']);
    ctx.queryBuf = 'select foo, ';
    attachCondStack(ctx, cond);
    const r = await run(cmdIf, ctx);
    expect(r.status).toBe('ok');
    expect(cond.top()?.state).toBe('ignored');
    expect(cond.top()?.savedQueryBufLen).toBe('select foo, '.length);
  });

  test('\\endif leaving INACTIVE branch sets truncateBufTo to savedLen', async () => {
    // Simulates: select \if true 42 \else (bogus \endif
    //   - \if push saves len=7 (length of "select ")
    //   - \else flips to else-false (inactive); savedLen re-anchored
    //   - \endif pops; the just-completed (else-false) was INACTIVE so
    //     the result should ask the mainloop to truncate.
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('else-false', 18); // emulate state after \else flipped from true
    const ctx = makeCtx(settings, 'endif', []);
    ctx.queryBuf = 'select\n      42\n      (bogus\n';
    attachCondStack(ctx, cond);
    const r = await run(cmdEndif, ctx);
    expect(r.status).toBe('ok');
    expect(r.truncateBufTo).toBe(18);
    expect(cond.depth()).toBe(0);
  });

  test('\\endif leaving ACTIVE branch does NOT request truncate', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('true', 7); // just-completed branch was active
    const ctx = makeCtx(settings, 'endif', []);
    ctx.queryBuf = 'select  42';
    attachCondStack(ctx, cond);
    const r = await run(cmdEndif, ctx);
    expect(r.status).toBe('ok');
    expect(r.truncateBufTo).toBeUndefined();
    expect(cond.depth()).toBe(0);
  });

  test('\\else from FALSE truncates and re-anchors at saved len', async () => {
    // \if false / (bogus / \else / ...
    //   - \if push, savedLen=0 (queryBuf empty), state=false
    //   - "(bogus " accumulates: queryBuf = "(bogus "
    //   - \else: just-completed was INACTIVE → request truncate to 0,
    //     re-anchor savedQueryBufLen to 0 so the new (active) branch's
    //     text is kept (no further discard until matching \endif).
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false', 0);
    const ctx = makeCtx(settings, 'else', []);
    ctx.queryBuf = '(bogus ';
    attachCondStack(ctx, cond);
    const r = await run(cmdElse, ctx);
    expect(r.status).toBe('ok');
    expect(r.truncateBufTo).toBe(0);
    expect(cond.top()?.state).toBe('else-true');
    expect(cond.top()?.savedQueryBufLen).toBe(0);
  });

  test('\\else from TRUE keeps buffer and re-anchors at current len', async () => {
    // \if true / 42 / \else / ...
    //   - \if push, savedLen=0, state=true
    //   - "42 " accumulates
    //   - \else: just-completed was ACTIVE → no truncate, re-anchor
    //     savedQueryBufLen to current length (3) so a later \endif
    //     after the inactive else-false branch can discard back to
    //     just the active branch's contribution.
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('true', 0);
    const ctx = makeCtx(settings, 'else', []);
    ctx.queryBuf = '42 ';
    attachCondStack(ctx, cond);
    const r = await run(cmdElse, ctx);
    expect(r.status).toBe('ok');
    expect(r.truncateBufTo).toBeUndefined();
    expect(cond.top()?.state).toBe('else-false');
    expect(cond.top()?.savedQueryBufLen).toBe('42 '.length);
  });

  test('\\elif from FALSE truncates and re-anchors', async () => {
    // \if false / (bad / \elif true / ...
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('false', 4); // queryBuf had 4 chars before \if
    const ctx = makeCtx(settings, 'elif', ['true']);
    ctx.queryBuf = 'abcd(bad';
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('ok');
    expect(r.truncateBufTo).toBe(4);
    expect(cond.top()?.state).toBe('true');
    expect(cond.top()?.savedQueryBufLen).toBe(4);
  });

  test('\\elif from TRUE flips to IGNORED, no truncate, re-anchors at current', async () => {
    const settings = makeSettings();
    const cond = createCondStack();
    cond.push('true', 0);
    const ctx = makeCtx(settings, 'elif', ['true']);
    ctx.queryBuf = 'keep me';
    attachCondStack(ctx, cond);
    const r = await run(cmdElif, ctx);
    expect(r.status).toBe('ok');
    expect(r.truncateBufTo).toBeUndefined();
    expect(cond.top()?.state).toBe('ignored');
    expect(cond.top()?.savedQueryBufLen).toBe('keep me'.length);
  });

  test('setSavedQueryBufLen on empty stack is a no-op', () => {
    const c = createCondStack();
    expect(() => {
      c.setSavedQueryBufLen(42);
    }).not.toThrow();
    expect(c.depth()).toBe(0);
  });
});
