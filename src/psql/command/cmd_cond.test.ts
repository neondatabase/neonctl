import { describe, expect, test } from 'vitest';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeSettings = (): PsqlSettings => defaultSettings(createVarStore());

const makeCtx = (
  settings: PsqlSettings,
  cmdName: string,
  args: string[],
): BackslashContext => {
  // Use a per-mode cursor list shared between calls so nextArg behaves
  // consistently. The cond commands only ask for 'normal'.
  let cursor = 0;
  const ctx: BackslashContext = {
    settings,
    cmdName,
    queryBuf: '',
    rawArgs: args.join(' '),
    nextArg(): string | null {
      if (cursor >= args.length) return null;
      const v = args[cursor];
      cursor += 1;
      return v;
    },
    restOfLine(): string {
      return args.slice(cursor).join(' ');
    },
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
