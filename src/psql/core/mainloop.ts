/**
 * psql REPL main loop.
 *
 * TypeScript port of `MainLoop()` in `src/bin/psql/mainloop.c`. Drives the
 * read-eval-print cycle: read a line, feed it to the SQL scanner, dispatch
 * SQL or backslash commands as boundaries appear, print results, and loop.
 *
 * Simplifications vs upstream (each tracked against the WP plan):
 *
 *  - Line editing is delegated to `node:readline` for now. Upstream uses
 *    GNU readline / libedit for history and completion. The proper raw-mode
 *    line editor is owned by WP-24; until then we get sane prompt rendering
 *    and Ctrl-C handling for free from the standard library.
 *  - History accumulation is omitted (`pg_append_history` / `pg_send_history`
 *    in upstream). The history sink lives in WP-25.
 *  - `\COPY FROM STDIN` raw-data lines are not wired (WP-16). When that lands,
 *    the mainloop will switch to PROMPT3 and forward lines to a CopyInStream.
 *  - `\if`/`\elif`/`\else`/`\endif` dispatch is wired directly here so the
 *    cmd_cond module can stay decoupled from the dispatch registry. Other
 *    backslash commands go through the registry interface that WP-13 owns.
 *  - The transaction-state poll (`pset.statusF`/`PQtransactionStatus`) is
 *    represented by an optional `txStatus` field on Connection; if the
 *    Connection doesn't expose one we treat the state as `unknown` for
 *    prompt rendering.
 *
 * Tracked TODOs:
 *
 *  - PSQLRC startup script (WP-22).
 *  - Encoding / multibyte handling beyond UTF-8 (handled implicitly by JS).
 *  - `\watch` continuous-execution mode.
 */

import * as readline from 'node:readline';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashResult,
} from '../types/backslash.js';
import type { REPLContext, IfState } from '../types/repl.js';
import type { ScanState, SlashArgMode } from '../types/scanner.js';

import { initialScanState } from '../types/scanner.js';
import { scanSql } from '../scanner/sql.js';
import { scanSlashArgs } from '../scanner/slash.js';
import { renderPromptByName, type PromptContext } from './prompt.js';
import { pickOut, renderResultSet, sendQuery } from './common.js';
import { formatDurationMs } from '../print/units.js';
import {
  COND_COMMAND_NAMES,
  attachCondStack,
  cmdElif,
  cmdElse,
  cmdEndif,
  cmdIf,
} from '../command/cmd_cond.js';
import { consumeNext as consumeQueuedInput } from '../command/inputQueue.js';
import { consumeBindState } from '../command/cmd_pipeline.js';
import {
  appendHistory,
  defaultHistoryPath,
  loadHistory,
  resolveHistSize,
  truncateHistory,
} from '../io/history.js';
import type { HistControl } from '../types/settings.js';
import { LineEditor } from '../io/lineEditor/index.js';
import { psqlCompleter } from '../complete/index.js';

// ---------------------------------------------------------------------------
// Exit codes — mirror psql's `EXIT_*` constants.
// ---------------------------------------------------------------------------

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_BADCONN = 2;
export const EXIT_USER = 3;

// ---------------------------------------------------------------------------
// Built-in cond command map — these are dispatched directly, before the
// registry lookup, because they must run even inside an inactive branch.
// ---------------------------------------------------------------------------

const COND_COMMANDS: ReadonlyMap<string, BackslashCmdSpec> = new Map([
  ['if', cmdIf],
  ['elif', cmdElif],
  ['else', cmdElse],
  ['endif', cmdEndif],
]);

// ---------------------------------------------------------------------------
// Line reader abstraction.
//
// Two backends:
//   - notty (file / pipe stdin): a `readline` async-iterator. Prompts are
//     suppressed by the surrounding caller; we just stream lines.
//   - interactive TTY: the WP-24 LineEditor (raw-mode VT100 with emacs
//     keybindings + reverse-i-search) plus WP-25 history persistence loaded
//     from / appended to $PSQL_HISTORY (default `~/.psql_history`).
//
// We expose `readLine(prompt)` so the caller decides what prompt to render
// per turn (the prompt string is computed against the current scanner /
// transaction state by `buildPromptContext`).
// ---------------------------------------------------------------------------

type LineReader = {
  /** Resolve next line; null on EOF. */
  readLine(prompt: string): Promise<string | null>;
  /** Record a submitted line in the live history (in-memory + on-disk). */
  pushHistory(line: string): void;
  close(): Promise<void>;
};

const makeStreamLineReader = (input: NodeJS.ReadableStream): LineReader => {
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });
  const iter = rl[Symbol.asyncIterator]();
  return {
    readLine: async (): Promise<string | null> => {
      const r = await iter.next();
      return r.done ? null : r.value;
    },
    pushHistory: (): void => undefined,
    close: (): Promise<void> => {
      rl.close();
      return Promise.resolve();
    },
  };
};

const makeEditorLineReader = async (ctx: REPLContext): Promise<LineReader> => {
  const env = process.env;
  const histPath = defaultHistoryPath(env);
  const histSize = resolveHistSize(env);
  const histControl =
    (ctx.settings.vars.get('HISTCONTROL') as HistControl | undefined) ??
    ctx.settings.histControl;
  let history: string[] = [];
  try {
    history = await loadHistory(histPath);
  } catch {
    // Missing or unreadable history file — start fresh.
    history = [];
  }
  const editor = new LineEditor({
    stdin: ctx.stdin as NodeJS.ReadStream,
    stdout: ctx.stdout,
    history,
    completer: psqlCompleter({ settings: ctx.settings }),
  });
  return {
    readLine: async (prompt: string): Promise<string | null> => {
      const r = await editor.readLine(prompt);
      if (r === editor.EOF) return null;
      return r as string;
    },
    pushHistory: (line: string): void => {
      const trimmed = line.replace(/\n+$/, '');
      if (trimmed.length === 0) return;
      editor.pushHistory(trimmed);
      // Best-effort persist. We don't block the REPL on disk I/O.
      void appendHistory(histPath, trimmed, histControl).catch(() => undefined);
    },
    close: async (): Promise<void> => {
      try {
        editor.close();
      } catch {
        // ignore
      }
      // Truncate to HISTSIZE on exit (libreadline behaviour).
      try {
        await truncateHistory(histPath, histSize);
      } catch {
        // ignore
      }
    },
  };
};

/**
 * Recognize upstream psql's `exit` / `quit` shortcut: when typed at the start
 * of a fresh statement (queryBuf empty), they exit the REPL. Accepts a
 * trailing `;` and/or whitespace.
 */
const isQuitKeyword = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const stripped = trimmed.replace(/;+\s*$/u, '').trimEnd();
  return stripped === 'exit' || stripped === 'quit';
};

/**
 * Recognize the bare `help` keyword the same way upstream does: at the start
 * of a fresh statement, it prints a one-screen reminder of the most useful
 * meta-commands and continues the REPL.
 */
const isHelpKeyword = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const stripped = trimmed.replace(/;+\s*$/u, '').trimEnd();
  return stripped === 'help';
};

const HELP_TEXT =
  'You are using psql-ts, the embedded TypeScript psql in neonctl.\n' +
  'Type:  \\copyright for distribution terms\n' +
  '       \\h for help with SQL commands\n' +
  '       \\? for help with psql commands\n' +
  '       \\g or terminate with semicolon to execute query\n' +
  '       \\q to quit\n';

const makeLineReader = async (ctx: REPLContext): Promise<LineReader> => {
  const debug = process.env.NEONCTL_PSQL_DEBUG === '1';
  if (ctx.settings.notty) {
    if (debug) {
      ctx.stderr.write(
        '[psql-debug] notty=true; using stream reader (no line editor / no Tab completion)\n',
      );
    }
    return makeStreamLineReader(ctx.stdin);
  }
  try {
    const r = await makeEditorLineReader(ctx);
    if (debug) {
      ctx.stderr.write(
        '[psql-debug] LineEditor engaged (raw mode, Tab completion active)\n',
      );
    }
    return r;
  } catch (err) {
    if (debug) {
      ctx.stderr.write(
        `[psql-debug] LineEditor setup failed, falling back to stream reader: ${(err as Error).message}\n`,
      );
    }
    return makeStreamLineReader(ctx.stdin);
  }
};

// ---------------------------------------------------------------------------
// Transaction status — best-effort. PgConnection exposes the raw
// ReadyForQuery byte (`'I' | 'T' | 'E'`) on a private `txStatus` field; we
// translate to the friendly enum the prompt expects.
// ---------------------------------------------------------------------------

type ConnWithTx = {
  txStatus?: 'I' | 'T' | 'E' | 'idle' | 'in-block' | 'failed' | 'unknown';
};

const transactionState = (
  ctx: REPLContext,
): 'idle' | 'in-block' | 'failed' | 'unknown' => {
  const db = ctx.settings.db;
  if (!db) return 'idle';
  const status = (db as unknown as ConnWithTx).txStatus;
  switch (status) {
    case 'I':
    case 'idle':
      return 'idle';
    case 'T':
    case 'in-block':
      return 'in-block';
    case 'E':
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    default:
      return 'idle';
  }
};

// ---------------------------------------------------------------------------
// BackslashContext factory — built per-invocation so the dispatched command
// sees an isolated arg-cursor.
// ---------------------------------------------------------------------------

const makeBackslashContext = (
  ctx: REPLContext,
  cmdName: string,
  rawArgs: string,
  queryBuf: string,
): BackslashContext => {
  // Pre-parse the args once at construction. `nextArg` then pops from this
  // queue. We over-parse a bit (every arg gets normalised through the slash
  // scanner in 'normal' mode), then re-split for non-normal modes lazily on
  // demand. For WP-12 the only consumers are the cond commands, which always
  // request 'normal'; future WPs may need richer routing.
  const varLookup = (name: string): string | undefined =>
    ctx.settings.vars.get(name);
  const buffered = new Map<SlashArgMode, string[]>();

  const argsFor = (mode: SlashArgMode): string[] => {
    const cached = buffered.get(mode);
    if (cached) return cached;
    const parsed = scanSlashArgs(rawArgs, mode, varLookup);
    buffered.set(mode, parsed);
    return parsed;
  };

  const cursors = new Map<SlashArgMode, number>();

  const bctx: BackslashContext = {
    settings: ctx.settings,
    cmdName,
    queryBuf,
    rawArgs,
    nextArg(mode: SlashArgMode = 'normal'): string | null {
      const args = argsFor(mode);
      const idx = cursors.get(mode) ?? 0;
      if (idx >= args.length) return null;
      cursors.set(mode, idx + 1);
      return args[idx];
    },
    restOfLine(): string {
      // Whatever the user typed after the command name, verbatim.
      return rawArgs;
    },
  };
  return bctx;
};

// ---------------------------------------------------------------------------
// Error printing. Keeps the format close to libpq's `psql: ERROR:  msg`.
// ---------------------------------------------------------------------------

const writeError = (ctx: REPLContext, message: string): void => {
  ctx.stderr.write(`psql: ERROR:  ${message}\n`);
};

// ---------------------------------------------------------------------------
// Prompt context builder.
// ---------------------------------------------------------------------------

const buildPromptContext = (
  ctx: REPLContext,
  promptStatus: PromptContext['promptStatus'],
  lineNumber: number,
): PromptContext => ({
  settings: ctx.settings,
  cond: ctx.cond,
  promptStatus,
  lineNumber,
  inTransaction: transactionState(ctx),
  pipelineState: 'off',
});

// ---------------------------------------------------------------------------
// Conditional-command dispatch. Returns true if the command was a cond
// command (handled here), false otherwise. cond commands run regardless of
// whether the surrounding branch is active.
// ---------------------------------------------------------------------------

const dispatchCondCommand = async (
  ctx: REPLContext,
  cmdName: string,
  rawArgs: string,
  queryBuf: string,
): Promise<{ handled: boolean; result?: BackslashResult }> => {
  const spec = COND_COMMANDS.get(cmdName);
  if (!spec) return { handled: false };
  const bctx = makeBackslashContext(ctx, cmdName, rawArgs, queryBuf);
  attachCondStack(bctx, ctx.cond);
  const result = await spec.run(bctx);
  if (result.status === 'error' && ctx.settings.lastErrorResult?.message) {
    writeError(ctx, ctx.settings.lastErrorResult.message);
  }
  return { handled: true, result };
};

// ---------------------------------------------------------------------------
// Backslash dispatch for non-cond commands. Only runs when cond is active.
// Returns the BackslashResult, or null if no command was found.
// ---------------------------------------------------------------------------

const dispatchRegisteredCommand = async (
  ctx: REPLContext,
  cmdName: string,
  rawArgs: string,
  queryBuf: string,
): Promise<BackslashResult | null> => {
  const spec = ctx.registry.lookup(cmdName);
  if (!spec) {
    writeError(ctx, `invalid command \\${cmdName}`);
    return { status: 'error' };
  }
  const bctx = makeBackslashContext(ctx, cmdName, rawArgs, queryBuf);
  attachCondStack(bctx, ctx.cond);
  const result = await spec.run(bctx);
  if (result.status === 'error' && ctx.settings.lastErrorResult?.message) {
    writeError(ctx, ctx.settings.lastErrorResult.message);
  }
  return result;
};

// ---------------------------------------------------------------------------
// SendQuery — delegate to the unified pipeline in `common.ts`. Returns the
// success flag so the read loop can short-circuit under ON_ERROR_STOP.
//
// If `\bind` (WP-21) has stashed parameters on the settings, route through
// the extended-query path on the Connection. Otherwise use the simple-query
// pipeline.
// ---------------------------------------------------------------------------

const dispatchSendQuery = async (
  ctx: REPLContext,
  sql: string,
): Promise<boolean> => {
  // Always consume the bind stash up-front so it's cleared regardless of which
  // branch runs (and regardless of success / failure on the bind path).
  const bind = consumeBindState(ctx.settings);
  if (bind && ctx.settings.db) {
    const started = ctx.settings.timing ? Date.now() : 0;
    try {
      const rs = await ctx.settings.db.query(sql, bind.values);
      // Route the single ResultSet through the unified printer pipeline so
      // `\bind` output looks identical to a simple-query result (and honours
      // `\o FILE`, format selection, expanded mode, etc.).
      await renderResultSet(ctx, rs, pickOut(ctx));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.settings.lastErrorResult = { message };
      writeError(ctx, message);
      return false;
    } finally {
      if (ctx.settings.timing) {
        ctx.stdout.write(formatDurationMs(Date.now() - started) + '\n');
      }
    }
  }
  const stats = await sendQuery(ctx, sql);
  return !stats.hadError;
};

// ---------------------------------------------------------------------------
// SIGINT installer. Returns a disposer to remove the listener cleanly. The
// installer is scoped to the duration of runMainLoop so we don't leak handlers
// when the function returns.
// ---------------------------------------------------------------------------

type SigintState = {
  inQuery: boolean;
  resetBuf: () => void;
};

const installSigint = (ctx: REPLContext, state: SigintState): (() => void) => {
  const handler = (): void => {
    if (state.inQuery && ctx.settings.db) {
      // Best-effort cancel; ignore errors.
      void ctx.settings.db.cancel().catch(() => undefined);
      return;
    }
    state.resetBuf();
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
};

// ---------------------------------------------------------------------------
// The main entry point.
// ---------------------------------------------------------------------------

export const runMainLoop = async (ctx: REPLContext): Promise<number> => {
  const reader = await makeLineReader(ctx);

  let queryBuf = '';
  let scanState: ScanState = initialScanState();
  let stmtLineNumber = 1;
  let successResult = EXIT_SUCCESS;
  let exitRequested = false;

  const resetBuf = (): void => {
    queryBuf = '';
    scanState = initialScanState();
    stmtLineNumber = 1;
  };

  const sigintState: SigintState = { inQuery: false, resetBuf };
  const removeSigint = installSigint(ctx, sigintState);

  // Compute the prompt string for the current state. For notty input we emit
  // the empty string so the stream reader doesn't see prompt bytes interleaved
  // with stdout. For TTY input the LineEditor renders the prompt itself.
  const computePrompt = (status: PromptContext['promptStatus']): string => {
    if (ctx.settings.notty) return '';
    const name =
      queryBuf.length === 0 || status === 'ready'
        ? 'PROMPT1'
        : status === 'copy'
          ? 'PROMPT3'
          : 'PROMPT2';
    const promptCtx = buildPromptContext(ctx, status, stmtLineNumber);
    return renderPromptByName(name, promptCtx);
  };

  /**
   * Process the assembled queryBuf+line through scanSql, dispatching the
   * boundaries it finds. Returns when we hit `incomplete`/`eof` and need
   * the next input line.
   */
  const processChunk = async (chunk: string): Promise<void> => {
    let working = chunk;
    while (working.length > 0) {
      const result = scanSql(working, scanState);
      scanState = result.nextState;

      if (result.kind === 'semicolon') {
        const sqlText = queryBuf + working.slice(0, result.consumed);
        queryBuf = '';
        working = working.slice(result.consumed);
        scanState = initialScanState();
        stmtLineNumber = 1;
        if (!ctx.cond.isActive()) {
          // Suppressed: discard, no execution, no error.
          continue;
        }
        sigintState.inQuery = true;
        const ok = await dispatchSendQuery(ctx, sqlText);
        sigintState.inQuery = false;
        if (!ok && ctx.settings.onErrorStop) {
          successResult = EXIT_USER;
          exitRequested = true;
          return;
        }
        continue;
      }

      if (result.kind === 'backslash') {
        const consumedChunk = working.slice(0, result.consumed);
        queryBuf += consumedChunk;
        working = working.slice(result.consumed);
        // Drop the consumed slice from queryBuf — psql's behaviour is to
        // suppress the "\cmd" text from query history when the buffer was
        // empty before. Easiest representation here: rewind.
        const cmdLen = '\\'.length + result.cmd.length + result.rest.length;
        queryBuf = queryBuf.slice(0, queryBuf.length - cmdLen);
        const cmdName = result.cmd;
        // Cond commands run unconditionally; everything else respects
        // cond.isActive().
        if (COND_COMMAND_NAMES.has(cmdName)) {
          const r = await dispatchCondCommand(
            ctx,
            cmdName,
            result.rest,
            queryBuf,
          );
          if (r.handled && r.result?.status === 'exit') {
            exitRequested = true;
            return;
          }
          if (
            r.handled &&
            r.result?.status === 'error' &&
            ctx.settings.onErrorStop
          ) {
            successResult = EXIT_USER;
            exitRequested = true;
            return;
          }
          continue;
        }
        if (!ctx.cond.isActive()) {
          // Skip non-cond commands inside an inactive branch.
          continue;
        }
        const bres = await dispatchRegisteredCommand(
          ctx,
          cmdName,
          result.rest,
          queryBuf,
        );
        if (bres?.status === 'exit') {
          exitRequested = true;
          return;
        }
        if (bres?.status === 'reset-buf') {
          queryBuf = bres.newBuf ?? '';
          scanState = initialScanState();
          stmtLineNumber = 1;
        }
        if (bres?.status === 'error' && ctx.settings.onErrorStop) {
          successResult = EXIT_USER;
          exitRequested = true;
          return;
        }
        continue;
      }

      // incomplete or eof — keep accumulating.
      queryBuf += working;
      working = '';
      return;
    }
  };

  // -----------------------------------------------------------------------
  // Read loop. Each iteration:
  //   1. Drain any pending input enqueued by `\i FILE` (WP-15) — those lines
  //      take precedence over fresh stdin so the include behaves as a
  //      prepend on the input source.
  //   2. Otherwise, ask the reader for the next line. For notty input this
  //      is a `readline` stream; for TTY input it's the LineEditor with
  //      emacs keybindings + persistent history (WP-24 + WP-25).
  //   3. Each submitted line is recorded in history.
  // -----------------------------------------------------------------------
  try {
    while (!exitRequested) {
      // Prompt status drives `%R`. When the query buffer holds an incomplete
      // statement but the scanner isn't inside any special context (paren,
      // comment, quoted-string), it still reports `'ready'`; map that to
      // `'continue'` so PROMPT2 renders `-` instead of `=`.
      const status: PromptContext['promptStatus'] =
        queryBuf.length === 0
          ? 'ready'
          : scanState.promptStatus === 'ready'
            ? 'continue'
            : scanState.promptStatus;
      const prompt = computePrompt(status);

      // 1. Pending input from \i: process as a single chunk and loop again.
      const queued = consumeQueuedInput();
      if (queued !== null) {
        await processChunk(queued.endsWith('\n') ? queued : queued + '\n');
        continue;
      }

      // 2. Read the next line from stdin / line editor.
      let line: string | null;
      try {
        line = await reader.readLine(prompt);
      } catch (err) {
        // SignalError (Ctrl-C on an interactive line) — drop the partial
        // buffer and re-prompt, matching upstream psql.
        if ((err as Error).name === 'SignalError') {
          resetBuf();
          continue;
        }
        throw err;
      }
      if (line === null) break; // EOF

      // 2a. `exit`/`quit` keyword handling.
      //
      //   - Empty buffer  → exit the REPL.
      //   - Non-empty buf → print "Use \\q to quit." hint and continue
      //     (buffer is preserved so the user can resume editing).
      //
      // The buffer may carry whitespace from a prior line's tail, so we
      // trim before checking.
      if (isQuitKeyword(line)) {
        if (queryBuf.trim().length === 0) {
          reader.pushHistory(line);
          exitRequested = true;
          break;
        }
        ctx.stdout.write('Use \\q to quit.\n');
        continue;
      }

      // 2b. `help` keyword handling, same shape.
      //
      //   - Empty buffer  → print the help text, continue.
      //   - Non-empty buf → print "Use \\? for help." hint, continue.
      if (isHelpKeyword(line)) {
        if (queryBuf.trim().length === 0) {
          reader.pushHistory(line);
          ctx.stdout.write(HELP_TEXT);
        } else {
          ctx.stdout.write('Use \\? for help.\n');
        }
        continue;
      }

      // 3. Push to history once we have a complete submitted line (only
      //    when there's something non-blank to record).
      reader.pushHistory(line);

      await processChunk(line + '\n');
    }

    // EOF: if there's a residual non-empty buffer in non-interactive mode,
    // dispatch it (mirroring upstream's tail-of-MainLoop block). For
    // interactive mode upstream skips this; we match the behaviour. We also
    // require the buffer to contain non-whitespace SQL — trailing blanks
    // between statement boundaries and EOF should not produce an empty
    // execSimple call.
    if (
      !exitRequested &&
      queryBuf.trim().length > 0 &&
      ctx.settings.notty &&
      successResult === EXIT_SUCCESS
    ) {
      if (ctx.cond.isActive()) {
        sigintState.inQuery = true;
        const ok = await dispatchSendQuery(ctx, queryBuf);
        sigintState.inQuery = false;
        if (!ok && ctx.settings.onErrorStop) successResult = EXIT_USER;
      }
      queryBuf = '';
    }

    // Warn about unbalanced \if blocks (psql's tail-of-MainLoop check).
    if (!exitRequested && ctx.cond.depth() > 0) {
      writeError(ctx, 'reached EOF without finding closing \\endif(s)');
      if (ctx.settings.onErrorStop && ctx.settings.notty) {
        successResult = EXIT_USER;
      }
    }
  } finally {
    await reader.close();
    removeSigint();
  }

  return successResult;
};

// Re-export the IfState union so callers driving the loop directly can build
// CondStack instances without dipping into the types/ module. Keeps the public
// surface of mainloop self-contained for WP-12 consumers.
export type { IfState };
