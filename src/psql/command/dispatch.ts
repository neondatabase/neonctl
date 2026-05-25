/**
 * Backslash command dispatch.
 *
 * TypeScript port of the top half of PostgreSQL's `src/bin/psql/command.c`:
 * specifically the `exec_command()` entry point that, given a parsed slash
 * command name, looks up the right handler and runs it with a small per-call
 * context (`BackslashContext`).
 *
 * The upstream is a giant switch statement keyed off the first one-or-two
 * letters of the command. We replace that with a registry of typed
 * `BackslashCmdSpec` records keyed by primary name with a separate alias map.
 * Commands are added by `register()` at construction time; the default
 * registry returned by {@link defaultRegistry} is pre-populated with every
 * command implemented in this WP (meta + format). Later WPs (I/O, connection,
 * describe, large object, pipeline, misc) add their own commands by calling
 * `registry.register(...)` on top.
 *
 * The `BackslashContext` carries:
 *
 *   - the parsed command name (without the leading backslash),
 *   - the raw post-name remainder of the input line (`rawArgs`),
 *   - the current SQL query buffer (`queryBuf`), and
 *   - a small `nextArg(mode)` / `restOfLine()` pair backed by
 *     `scanSlashArgs()` from the WP-07 scanner. Each call to `nextArg` returns
 *     the next lexed argument under the requested {@link SlashArgMode}, or
 *     `null` once the buffer is exhausted. Mixing modes across calls is
 *     supported: each call rescans the tail starting at the current cursor.
 *
 * Variable substitution: the scanner is given a `varLookup` callback that
 * delegates to `settings.vars`. Modes that disable substitution (`no-vars`)
 * naturally fall through to the scanner's existing behaviour.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import type { SlashArgMode } from '../types/scanner.js';

import { scanSlashArgs } from '../scanner/slash.js';

import {
  cmdCd,
  cmdCopyright,
  cmdEcho,
  cmdErrverbose,
  cmdGetenv,
  cmdHelpSQL,
  cmdPrompt,
  cmdQecho,
  cmdQuit,
  cmdSet,
  cmdSetenv,
  cmdShell,
  cmdTiming,
  cmdUnset,
  cmdWarn,
} from './cmd_meta.js';
import {
  cmdA,
  cmdC,
  cmdEncoding,
  cmdF,
  cmdH,
  cmdPset,
  cmdT,
  cmdTitleAttr,
  cmdX,
} from './cmd_format.js';
import { registerIoCommands } from './cmd_io.js';
import { registerConnectCommands } from './cmd_connect.js';
import { registerCopyCommands } from './cmd_copy.js';
import { registerDescribeCommands } from './cmd_describe.js';
import { registerPipelineCommands } from './cmd_pipeline.js';
import { registerMiscCommands } from './cmd_misc.js';
import { registerLargeObjectCommands } from './cmd_lo.js';
import {
  isCommandRestricted,
  registerRestrictCommands,
  wrapRestrictedCommands,
} from './cmd_restrict.js';
import { writeErr } from './shared.js';

/**
 * Concrete `BackslashRegistry`: a primary-name → spec map plus a parallel
 * alias → primary-name map so lookups stay O(1).
 *
 * Re-registering the same primary name overwrites the existing spec; this
 * matches the upstream behaviour that doesn't multi-register and gives
 * downstream WPs a clean way to override a default if they need to.
 */
class Registry implements BackslashRegistry {
  private readonly specs = new Map<string, BackslashCmdSpec>();
  private readonly aliases = new Map<string, string>();

  register(spec: BackslashCmdSpec): void {
    this.specs.set(spec.name, spec);
    if (spec.aliases) {
      for (const alias of spec.aliases) {
        this.aliases.set(alias, spec.name);
      }
    }
  }

  lookup(name: string): BackslashCmdSpec | undefined {
    const direct = this.specs.get(name);
    if (direct) return direct;
    const aliased = this.aliases.get(name);
    if (aliased) return this.specs.get(aliased);
    return undefined;
  }

  all(): IterableIterator<BackslashCmdSpec> {
    return this.specs.values();
  }
}

/** Construct a fresh, empty registry. */
export const createBackslashRegistry = (): BackslashRegistry => new Registry();

/**
 * Build a {@link BackslashContext} from inputs the REPL has on hand at
 * dispatch time.
 *
 * The context's `nextArg(mode)` is built on top of `scanSlashArgs`. We
 * maintain a small internal byte cursor that tracks how much of `rawArgs`
 * has been consumed so far; each call rescans the remaining tail in the
 * requested mode and advances the cursor past the first arg's source
 * extent. `restOfLine()` returns the unconsumed tail verbatim (with leading
 * whitespace trimmed, matching `whole-line` semantics) and advances the
 * cursor to the end.
 *
 * The tracking is conservative: because `scanSlashArgs` does not directly
 * report per-arg source spans, we estimate the consumed span by re-lexing
 * with a 1-arg cap in `whole-line` mode to find the boundary. This is an
 * over-approximation only when adjacent quoted runs collapse to fewer
 * characters in the parsed output — in practice every command in this WP
 * either reads args in order or reads the whole tail with `restOfLine()`,
 * so the cursor is never observed to lag in the calls we ship.
 */
export const makeContext = (opts: {
  settings: PsqlSettings;
  cmdName: string;
  rawArgs: string;
  queryBuf: string;
}): BackslashContext => {
  let cursor = 0;
  const rawArgs = opts.rawArgs;
  const varLookup = (name: string): string | undefined =>
    opts.settings.vars.get(name);

  const nextArg = (mode: SlashArgMode = 'normal'): string | null => {
    // Find the next non-whitespace byte from the cursor; we use it both to
    // know whether anything remains and as the basis for span tracking.
    let i = cursor;
    while (i < rawArgs.length && /[\s]/.test(rawArgs[i])) i++;
    if (i >= rawArgs.length) return null;

    if (mode === 'whole-line') {
      const tail = rawArgs.slice(i);
      cursor = rawArgs.length;
      return tail;
    }

    // Scan just the tail and pick the first arg. The scanner consumes one
    // arg's worth of input; we need to advance `cursor` past it so the next
    // call sees the remaining tail. We do that by rescanning the tail again
    // with a one-token cap and comparing lengths.
    const tail = rawArgs.slice(i);
    const args = scanSlashArgs(tail, mode, varLookup);
    if (args.length === 0) {
      cursor = rawArgs.length;
      return null;
    }
    const first = args[0];

    // Compute the consumed span by scanning the original tail in normal
    // mode and finding where the second arg would start. We don't have a
    // direct API for that, so we walk character-by-character using the
    // same termination rules as the scanner.
    const span = consumedSpan(tail, mode, varLookup);
    cursor = i + span;
    return first;
  };

  const restOfLine = (): string => {
    let i = cursor;
    while (i < rawArgs.length && /[\s]/.test(rawArgs[i])) i++;
    const tail = rawArgs.slice(i);
    cursor = rawArgs.length;
    return tail;
  };

  return {
    settings: opts.settings,
    cmdName: opts.cmdName,
    queryBuf: opts.queryBuf,
    rawArgs,
    nextArg,
    restOfLine,
  };
};

/**
 * Compute how many bytes of `tail` were consumed lexing the first arg. We
 * walk the same quoting/escape rules as the scanner so the cursor advances
 * past the *source* extent, not the post-expansion length.
 *
 * Stops at whitespace or backslash. Quoted runs (`'…'`, `"…"`, `` `…` ``)
 * are consumed to their closing delimiter. `:var` substitutions advance
 * past the original `:name` form regardless of expansion size.
 */
const consumedSpan = (
  tail: string,
  mode: SlashArgMode,
  varLookup: (name: string) => string | undefined,
): number => {
  if (mode === 'whole-line') return tail.length;

  let i = 0;
  // Skip leading whitespace inside the tail (already trimmed by caller, but
  // safe to repeat).
  while (i < tail.length && /[\s]/.test(tail[i])) i++;

  // filepipe special: a leading `|` slurps to EOL.
  if (mode === 'filepipe' && tail[i] === '|') return tail.length;

  while (i < tail.length) {
    const c = tail[i];
    if (/[\s]/.test(c) || c === '\\') break;
    if (c === "'") {
      i++;
      while (i < tail.length) {
        if (tail[i] === '\\' && i + 1 < tail.length) {
          i += 2;
          continue;
        }
        if (tail[i] === "'") {
          if (tail[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < tail.length && tail[i] !== '"') i++;
      if (i < tail.length) i++;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < tail.length && tail[i] !== '`') i++;
      if (i < tail.length) i++;
      continue;
    }
    if (c === ':' && mode !== 'no-vars') {
      // :"name" / :'name' / :name — advance past the source form. We don't
      // actually call varLookup here; we just measure the lexical span.
      void varLookup;
      const next = tail[i + 1];
      if (next === '"' || next === "'") {
        let j = i + 2;
        while (j < tail.length && /[A-Za-z0-9_\x80-\xff]/.test(tail[j])) j++;
        if (j > i + 2 && tail[j] === next) {
          i = j + 1;
          continue;
        }
      }
      if (next && /[A-Za-z0-9_\x80-\xff]/.test(next)) {
        let j = i + 1;
        while (j < tail.length && /[A-Za-z0-9_\x80-\xff]/.test(tail[j])) j++;
        i = j;
        continue;
      }
    }
    i++;
  }
  return i;
};

/**
 * Top-level dispatch entry. Looks the command up by name (and falls back to
 * registered aliases), runs it, and returns the result.
 *
 * Unknown commands return `{ status: 'error' }` so the mainloop can emit
 * the upstream-style `"invalid command \…"` diagnostic. We deliberately
 * don't print here; the caller owns stderr.
 */
export const dispatchBackslash = async (
  registry: BackslashRegistry,
  cmdName: string,
  ctx: BackslashContext,
): Promise<BackslashResult> => {
  const spec = registry.lookup(cmdName);
  if (!spec) return { status: 'error' };
  // PG 18: refuse shell/filesystem-touching commands while restricted.
  // We check against the resolved *primary* name so aliases like
  // `\write` → `w` are caught.
  if (isCommandRestricted(ctx.settings, spec.name)) {
    writeErr(
      `\\${cmdName}: command is not allowed in restricted mode; ` +
        `use \\unrestrict to leave restricted mode\n`,
    );
    return { status: 'error' };
  }
  return spec.run(ctx);
};

/**
 * Return a fresh registry pre-populated with every backslash command this
 * WP implements: meta (`\q`, `\!`, `\cd`, `\echo`, `\qecho`, `\warn`,
 * `\prompt`, `\set`, `\unset`, `\getenv`, `\setenv`, `\errverbose`,
 * `\timing`) and format (`\a`, `\C`, `\f`, `\H`, `\t`, `\T`, `\x`,
 * `\pset`, `\encoding`).
 *
 * Other WPs (15/17/20/21/22/23) extend this set by calling `register()` on
 * the returned registry — see the plan for the full mapping.
 */
export const defaultRegistry = (): BackslashRegistry => {
  const r = createBackslashRegistry();
  // Meta.
  r.register(cmdQuit);
  r.register(cmdShell);
  r.register(cmdCd);
  r.register(cmdEcho);
  r.register(cmdQecho);
  r.register(cmdWarn);
  r.register(cmdPrompt);
  r.register(cmdSet);
  r.register(cmdUnset);
  r.register(cmdGetenv);
  r.register(cmdSetenv);
  r.register(cmdErrverbose);
  r.register(cmdTiming);
  r.register(cmdCopyright);
  r.register(cmdHelpSQL);
  // Format.
  r.register(cmdA);
  r.register(cmdC);
  r.register(cmdF);
  r.register(cmdH);
  r.register(cmdT);
  r.register(cmdTitleAttr);
  r.register(cmdX);
  r.register(cmdEncoding);
  r.register(cmdPset);
  // I/O & control (WP-15).
  registerIoCommands(r);
  registerConnectCommands(r);
  registerCopyCommands(r);
  registerDescribeCommands(r);
  registerPipelineCommands(r);
  registerMiscCommands(r);
  registerLargeObjectCommands(r);
  registerRestrictCommands(r);
  // Must run after every other `register*` call so the wrappers see the
  // final specs for the restricted command names (e.g. `\!`, `\cd`, `\copy`,
  // `\setenv`, `\w`). Without this, the REPL mainloop's direct
  // `spec.run(ctx)` invocation bypasses the gate that lives in
  // `dispatchBackslash`.
  wrapRestrictedCommands(r);
  return r;
};
