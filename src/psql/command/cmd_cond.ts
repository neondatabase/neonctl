/**
 * psql conditional backslash commands: `\if`, `\elif`, `\else`, `\endif`.
 *
 * TypeScript port of `exec_command_if`/`exec_command_elif`/`exec_command_else`/
 * `exec_command_endif` in `src/bin/psql/command.c`, plus the `ConditionalStack`
 * machinery from `src/fe_utils/conditional.c`.
 *
 * Semantics (mirroring upstream exactly):
 *
 *  - `\if <expr>`
 *      • If outer branch is active, push a new frame whose state is `TRUE` or
 *        `FALSE` depending on the parsed expression value.
 *      • Otherwise push `IGNORED`: every nested branch is suppressed regardless
 *        of expression. This is how upstream achieves transitive suppression
 *        without `conditional_active()` itself being transitive.
 *  - `\elif <expr>`
 *      • Top is `TRUE`         → branch already taken; skip rest until `\endif`
 *        (poke to `IGNORED`).
 *      • Top is `FALSE`        → first true branch wins; evaluate expression.
 *      • Top is `IGNORED`      → leave untouched, ignore expression.
 *      • Top is `ELSE_*`       → error: `\elif: cannot occur after \else`.
 *      • Top is `NONE` (empty) → error: `\elif: no matching \if`.
 *  - `\else`
 *      • Top is `TRUE`         → poke `ELSE_FALSE`.
 *      • Top is `FALSE`        → poke `ELSE_TRUE`.
 *      • Top is `IGNORED`      → poke `ELSE_FALSE` (still suppressed).
 *      • Top is `ELSE_*`       → error: `\else: cannot occur after \else`.
 *      • Top is `NONE`         → error: `\else: no matching \if`.
 *  - `\endif`
 *      • Pop the top frame.
 *      • Top was `NONE`        → error: `\endif: no matching \if`.
 *
 * Expression evaluation: upstream uses `ParseVariableBool` after the lexer has
 * substituted `:vars` and evaluated backticks. We don't have a full slash-arg
 * lexer wiring here (the dispatcher in WP-13 owns that); the BackslashContext
 * gives us `nextArg('normal')` which calls into the slash scanner with full
 * substitution. We mirror `ParseVariableBool` semantics in {@link parseBool}.
 *
 * Note on the "transitive suppression" requirement: upstream's
 * `conditional_active()` only inspects the top frame, but the resulting state
 * machine *is* transitive because `\if` inside an inactive outer always pushes
 * `IGNORED`, and `IGNORED` never transitions to `TRUE`. So `isActive()`
 * inspecting just the top frame produces the right answer.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashResult,
} from '../types/backslash.js';
import type { CondStack, CondStackFrame, IfState } from '../types/repl.js';

// ---------------------------------------------------------------------------
// Conditional stack
// ---------------------------------------------------------------------------

const INACTIVE_STATES: readonly IfState[] = ['false', 'else-false', 'ignored'];

/**
 * Build an empty {@link CondStack}.
 *
 * Frames are stored in an array; `top()` is the last element. `branchTaken`
 * records whether a `TRUE`/`ELSE_TRUE` branch has been seen at this level —
 * mainloop and the elif/else commands use it implicitly via the state-machine
 * transitions described above (we don't expose it through the public API, but
 * it's part of the frame shape declared in `types/repl.ts`).
 */
export const createCondStack = (): CondStack => {
  const frames: CondStackFrame[] = [];

  const branchTakenForInitial = (state: IfState): boolean =>
    state === 'true' || state === 'else-true';

  return {
    push(state: IfState): void {
      frames.push({ state, branchTaken: branchTakenForInitial(state) });
    },
    pop(): CondStackFrame | undefined {
      return frames.pop();
    },
    top(): CondStackFrame | undefined {
      return frames.length === 0 ? undefined : frames[frames.length - 1];
    },
    isActive(): boolean {
      // Upstream `conditional_active()`: top is NONE/TRUE/ELSE_TRUE → active.
      // The transitive suppression is encoded by `\if` pushing `IGNORED` when
      // its surrounding context is inactive — see cmdIf below.
      if (frames.length === 0) return true;
      return !INACTIVE_STATES.includes(frames[frames.length - 1].state);
    },
    setState(state: IfState): void {
      if (frames.length === 0) return;
      const top = frames[frames.length - 1];
      top.state = state;
      if (state === 'true' || state === 'else-true') top.branchTaken = true;
    },
    depth(): number {
      return frames.length;
    },
  };
};

// ---------------------------------------------------------------------------
// ParseVariableBool — mirrors variables.c::ParseVariableBool.
//
// We re-implement it here (rather than importing from core/variables.ts) so
// the slash-cmd modules stay decoupled from the var-store implementation;
// they just need a value-parser. Recognised forms are case-insensitive with
// unique-prefix matching for word forms:
//
//   true / false / yes / no   (unique-prefix accepted)
//   on / off                  (need at least 2 chars; bare 'o' ambiguous)
//   1 / 0                     (literal)
//
// Anything else is an error (upstream prints a warning and returns false). We
// follow upstream by treating unrecognised tokens as `false` while pushing
// the frame.
// ---------------------------------------------------------------------------

const isPrefixOf = (value: string, prefix: string): boolean =>
  value.length > 0 &&
  value.length <= prefix.length &&
  prefix.slice(0, value.length).toLowerCase() === value.toLowerCase();

/** Returns the parsed boolean, or `null` if the string was not recognised. */
export const parseBool = (value: string): boolean | null => {
  if (value.length === 0) return null;
  if (isPrefixOf(value, 'true')) return true;
  if (isPrefixOf(value, 'false')) return false;
  if (isPrefixOf(value, 'yes')) return true;
  if (isPrefixOf(value, 'no')) return false;
  if (value.length >= 2) {
    const lower = value.toLowerCase();
    if ('on'.startsWith(lower)) return true;
    if ('off'.startsWith(lower)) return false;
  }
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
};

// ---------------------------------------------------------------------------
// Backslash command implementations
// ---------------------------------------------------------------------------

/**
 * Pull the expression argument off the BackslashContext. Returns `null` when
 * the caller supplied no arg (upstream treats a missing expression as false).
 */
const readExpr = (ctx: BackslashContext): string | null => {
  const arg = ctx.nextArg('normal');
  return arg;
};

const evalExpr = (ctx: BackslashContext): boolean => {
  const raw = readExpr(ctx);
  if (raw === null) return false;
  const parsed = parseBool(raw);
  if (parsed === null) {
    ctx.settings.lastErrorResult = {
      message: `unrecognized value "${raw}" for "\\if": Boolean expected`,
    };
    return false;
  }
  return parsed;
};

/**
 * Marker symbol on BackslashContext.cmdName so the mainloop can recognise the
 * cond commands without an interface-pollution argument. We instead attach the
 * CondStack via a well-known field on the `settings` object — see {@link
 * attachCondStack} / {@link getCondStack}.
 *
 * The mainloop is the sole owner of the CondStack, and it threads it onto the
 * BackslashContext via this helper pair so command modules don't have to know
 * about REPLContext.
 */
const COND_STACK_KEY = Symbol.for('neonctl.psql.condStack');

type StashRecord = Record<symbol, unknown> & { [COND_STACK_KEY]?: CondStack };

export const attachCondStack = (
  ctx: BackslashContext,
  cond: CondStack,
): void => {
  const settings = ctx.settings as unknown as StashRecord;
  settings[COND_STACK_KEY] = cond;
};

export const getCondStack = (ctx: BackslashContext): CondStack => {
  const settings = ctx.settings as unknown as StashRecord;
  const stack = settings[COND_STACK_KEY];
  if (stack === undefined) {
    throw new Error(
      'cond stack not attached; cmd_cond commands must be dispatched via runMainLoop',
    );
  }
  return stack;
};

const errResult = (ctx: BackslashContext, message: string): BackslashResult => {
  ctx.settings.lastErrorResult = { message };
  return { status: 'error' };
};

const okResult = (): BackslashResult => ({ status: 'ok' });

export const cmdIf: BackslashCmdSpec = {
  name: 'if',
  argMode: 'lex',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const cond = getCondStack(ctx);
    if (!cond.isActive()) {
      // Suppressed by outer; push IGNORED and discard expression (upstream
      // `ignore_boolean_expression`).
      // We still consume the arg so the dispatcher doesn't see it later.
      readExpr(ctx);
      cond.push('ignored');
      return Promise.resolve(okResult());
    }
    const truthy = evalExpr(ctx);
    cond.push(truthy ? 'true' : 'false');
    return Promise.resolve(okResult());
  },
};

export const cmdElif: BackslashCmdSpec = {
  name: 'elif',
  argMode: 'lex',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const cond = getCondStack(ctx);
    const top = cond.top();
    if (top === undefined) {
      readExpr(ctx);
      return Promise.resolve(errResult(ctx, '\\elif: no matching \\if'));
    }
    switch (top.state) {
      case 'true': {
        // Branch already taken — skip the rest until \endif.
        readExpr(ctx);
        cond.setState('ignored');
        return Promise.resolve(okResult());
      }
      case 'false': {
        // Have not yet found a true branch — evaluate this one.
        const truthy = evalExpr(ctx);
        cond.setState(truthy ? 'true' : 'false');
        return Promise.resolve(okResult());
      }
      case 'ignored': {
        readExpr(ctx);
        // Stay ignored.
        return Promise.resolve(okResult());
      }
      case 'else-true':
      case 'else-false':
        readExpr(ctx);
        return Promise.resolve(
          errResult(ctx, '\\elif: cannot occur after \\else'),
        );
      case 'none':
        readExpr(ctx);
        return Promise.resolve(errResult(ctx, '\\elif: no matching \\if'));
    }
  },
};

export const cmdElse: BackslashCmdSpec = {
  name: 'else',
  argMode: 'lex',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const cond = getCondStack(ctx);
    const top = cond.top();
    if (top === undefined) {
      return Promise.resolve(errResult(ctx, '\\else: no matching \\if'));
    }
    switch (top.state) {
      case 'true':
        cond.setState('else-false');
        return Promise.resolve(okResult());
      case 'false':
        cond.setState('else-true');
        return Promise.resolve(okResult());
      case 'ignored':
        cond.setState('else-false');
        return Promise.resolve(okResult());
      case 'else-true':
      case 'else-false':
        return Promise.resolve(
          errResult(ctx, '\\else: cannot occur after \\else'),
        );
      case 'none':
        return Promise.resolve(errResult(ctx, '\\else: no matching \\if'));
    }
  },
};

export const cmdEndif: BackslashCmdSpec = {
  name: 'endif',
  argMode: 'lex',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const cond = getCondStack(ctx);
    if (cond.top() === undefined) {
      return Promise.resolve(errResult(ctx, '\\endif: no matching \\if'));
    }
    cond.pop();
    return Promise.resolve(okResult());
  },
};

/** Names of the conditional commands — the mainloop dispatches these
 * unconditionally (i.e. ignoring `cond.isActive()`) so an `\if false` block
 * can still be closed by `\endif`. */
export const COND_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'if',
  'elif',
  'else',
  'endif',
]);
