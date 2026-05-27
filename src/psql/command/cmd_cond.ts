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
 * Expression evaluation: upstream `read_boolean_expression` reads tokens
 * with `OT_NORMAL` (which expands `:vars` and backticks) and concatenates
 * them with single spaces; the assembled string is passed through
 * `ParseVariableBool`. We mirror that pipeline in {@link collectExpr} +
 * {@link parseBool}: collect every `nextArg('normal')` token, join with
 * spaces, parse. Unrecognised tokens emit the upstream
 * `unrecognized value "<tok>" for "\<cmd> expression": Boolean expected`
 * diagnostic and evaluate to false.
 *
 * Inactive branches: when the surrounding scope is suppressed, upstream
 * `ignore_boolean_expression` drops the argument tokens WITHOUT running
 * `:var` / backtick expansion (regress psql.sql ~line 1028 covers this).
 * We achieve the same by NOT calling `nextArg` at all — the
 * BackslashContext factory only invokes the slash scanner lazily on the
 * first `nextArg` request, so leaving the args queue untouched is
 * equivalent to upstream's "discard without expansion".
 *
 * Diagnostic format: cond commands emit their errors BARE (no
 * `psql: ERROR:` prefix). This mirrors `expected/psql.out` (e.g.
 * `\endif: no matching \if` on a single line). We use `writeErr` directly
 * and return `errorWritten: true` so the mainloop's `psql: ERROR:` fallback
 * is suppressed.
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
import { writeErr } from './shared.js';

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
 * Read every remaining `'normal'`-mode argument off the BackslashContext and
 * concatenate them with single spaces. Mirrors upstream
 * `read_boolean_expression`, which calls `psql_scan_slash_option(OT_NORMAL)`
 * in a loop and joins tokens with `" "`. Returns the empty string when no
 * args follow the command name — upstream's "missing expression" path
 * surfaces the same `unrecognized value ""...` diagnostic as any other
 * unparseable token, then evaluates to false.
 */
const collectExpr = (ctx: BackslashContext): string => {
  const parts: string[] = [];
  for (;;) {
    const arg = ctx.nextArg('normal');
    if (arg === null) break;
    parts.push(arg);
  }
  return parts.join(' ');
};

/**
 * Marker call indicating "discard the expression without evaluating it".
 * Mirrors upstream `ignore_boolean_expression` — when we're already inside
 * an inactive branch, `\if` / `\elif` arguments are dropped without
 * expanding `:vars` or running backticks. We achieve this by simply NOT
 * calling `nextArg`: the BackslashContext factory in `mainloop.ts` only
 * invokes the slash scanner lazily on the first arg request, so leaving
 * the queue untouched skips all expansion. The unconsumed `rawArgs` are
 * dropped after the cmd returns.
 *
 * Kept as a named no-op so call sites read intent-fully ("dropExpr") and
 * future refactors can replace the body without touching every caller.
 */
const dropExpr = (): void => {
  // Intentionally empty — see the doc comment.
};

/**
 * Evaluate the joined expression against {@link parseBool}. Unrecognised
 * tokens surface `unrecognized value "<tok>" for "\<cmd> expression":
 * Boolean expected` to stderr (bare, no `psql: ERROR:` prefix — upstream
 * `psql_error` shape) and evaluate to false. The caller is responsible for
 * setting the stack state to `'false'` on this path. `cmdName` is the
 * caller's command identifier (`'if'` / `'elif'`) so the diagnostic matches
 * upstream verbatim.
 */
const evalExpr = (ctx: BackslashContext, cmdName: 'if' | 'elif'): boolean => {
  const raw = collectExpr(ctx);
  const parsed = parseBool(raw);
  if (parsed === null) {
    const message = `unrecognized value "${raw}" for "\\${cmdName} expression": Boolean expected`;
    ctx.settings.lastErrorResult = { message };
    writeErr(`${message}\n`);
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
  // Upstream emits cond diagnostics bare via `psql_error("%s\n", ...)`: no
  // `psql: ERROR:` prefix, no `\<cmd>:` prefix on top of the message (the
  // message already includes it). We mirror that exactly so the regress
  // expected output (`\elif: cannot occur after \else`) matches verbatim.
  // The `errorWritten` flag tells the mainloop not to add its own
  // `psql: ERROR:  <msg>` fallback line.
  writeErr(`${message}\n`);
  return { status: 'error', errorWritten: true };
};

const okResult = (): BackslashResult => ({ status: 'ok' });

export const cmdIf: BackslashCmdSpec = {
  name: 'if',
  argMode: 'lex',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const cond = getCondStack(ctx);
    if (!cond.isActive()) {
      // Suppressed by outer: push IGNORED and drop the expression WITHOUT
      // expanding it. Upstream `ignore_boolean_expression` calls the lexer
      // with backticks/vars disabled (psql.sql:1028 covers this with
      // `\if false { \if \`nosuchcommand\` ... }`).
      dropExpr();
      cond.push('ignored');
      return Promise.resolve(okResult());
    }
    const truthy = evalExpr(ctx, 'if');
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
      dropExpr();
      return Promise.resolve(errResult(ctx, '\\elif: no matching \\if'));
    }
    switch (top.state) {
      case 'true': {
        // Branch already taken — flip to IGNORED. Drop the expression
        // without expansion (regress suite: `\if true \elif \`bad\` ...`).
        dropExpr();
        cond.setState('ignored');
        return Promise.resolve(okResult());
      }
      case 'false': {
        // Have not yet found a true branch — evaluate this one.
        // evalExpr emits its own `unrecognized value` diagnostic on failure
        // and falls through to false, mirroring upstream.
        const truthy = evalExpr(ctx, 'elif');
        cond.setState(truthy ? 'true' : 'false');
        return Promise.resolve(okResult());
      }
      case 'ignored': {
        // Outer is suppressed — stay ignored, drop args without expanding.
        dropExpr();
        return Promise.resolve(okResult());
      }
      case 'else-true':
      case 'else-false':
        dropExpr();
        return Promise.resolve(
          errResult(ctx, '\\elif: cannot occur after \\else'),
        );
      case 'none':
        dropExpr();
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
