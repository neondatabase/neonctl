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
import { sendQuery } from './common.js';
import {
  COND_COMMAND_NAMES,
  attachCondStack,
  cmdElif,
  cmdElse,
  cmdEndif,
  cmdIf,
} from '../command/cmd_cond.js';

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
// Line source abstraction.
//
// For test ergonomics we accept any NodeJS.ReadableStream. We layer a small
// async-iterator over readline so callers can pass `process.stdin` or a
// `stream.Readable.from([...])` and get the same behaviour. Readline handles
// CRLF and EOF for us.
// ---------------------------------------------------------------------------

type LineSource = AsyncIterableIterator<string> & {
  close(): void;
};

const makeLineSource = (input: NodeJS.ReadableStream): LineSource => {
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });
  const iter = rl[Symbol.asyncIterator]();
  return {
    next: (): Promise<IteratorResult<string>> => iter.next(),
    [Symbol.asyncIterator](): AsyncIterableIterator<string> {
      return this;
    },
    close: (): void => {
      rl.close();
    },
  };
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
// ---------------------------------------------------------------------------

const dispatchSendQuery = async (
  ctx: REPLContext,
  sql: string,
): Promise<boolean> => {
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
  const lineSource = makeLineSource(ctx.stdin);

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

  // Render and write a prompt to stdout. For non-interactive (notty) input
  // we skip rendering so script-driven runs don't pollute stdout.
  const writePrompt = (status: PromptContext['promptStatus']): void => {
    if (ctx.settings.notty) return;
    const name =
      queryBuf.length === 0 || status === 'ready'
        ? 'PROMPT1'
        : status === 'copy'
          ? 'PROMPT3'
          : 'PROMPT2';
    const promptCtx = buildPromptContext(ctx, status, stmtLineNumber);
    const text = renderPromptByName(name, promptCtx);
    ctx.stdout.write(text);
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
  // Read loop. readline emits one line per `for await`; we re-add the
  // trailing newline so scanSql sees the same character stream a byte-level
  // reader would.
  // -----------------------------------------------------------------------
  try {
    writePrompt('ready');
    for await (const rawLine of lineSource) {
      const line = rawLine + '\n';
      await processChunk(line);
      if (exitRequested) break;
      if (queryBuf.length === 0) {
        writePrompt('ready');
      } else {
        writePrompt(scanState.promptStatus);
      }
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
    lineSource.close();
    removeSigint();
  }

  return successResult;
};

// Re-export the IfState union so callers driving the loop directly can build
// CondStack instances without dipping into the types/ module. Keeps the public
// surface of mainloop self-contained for WP-12 consumers.
export type { IfState };
