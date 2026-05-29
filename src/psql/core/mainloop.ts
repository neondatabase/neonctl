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
import type { Notice } from '../types/connection.js';
import type { REPLContext, IfState } from '../types/repl.js';
import type { ScanState, SlashArgMode } from '../types/scanner.js';

import { initialScanState } from '../types/scanner.js';
import { scanSql } from '../scanner/sql.js';
import { scanSlashArgs } from '../scanner/slash.js';
import { renderPromptByName, type PromptContext } from './prompt.js';
import {
  captureLastError,
  pickOut,
  refreshErrorVars,
  renderResultSet,
  sendQuery,
  writeQueryError,
} from './common.js';
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
import { consumeBindState, getPipelineState } from '../command/cmd_pipeline.js';
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
  /**
   * Inject out-of-band output while the user is editing a prompt — used by
   * async producers (NotificationResponse, NoticeResponse) so they don't
   * garble the in-progress prompt rendering.
   */
  interject(text: string): void;
  close(): Promise<void>;
};

const makeStreamLineReader = (
  input: NodeJS.ReadableStream,
  out: NodeJS.WritableStream,
): LineReader => {
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
    // No prompt to garble; just write straight to stdout.
    interject: (text: string): void => {
      out.write(text);
    },
    close: (): Promise<void> => {
      rl.close();
      return Promise.resolve();
    },
  };
};

/**
 * Parse a psql VI_MODE-style boolean. Mirrors `ParseVariableBool` for the
 * common spellings: `on` / `true` / `yes` / `1` are truthy; `off` / `false` /
 * `no` / `0` are falsy; everything else returns `null` so the caller can
 * surface the upstream "invalid value" diagnostic.
 */
const parseBoolVar = (raw: string): boolean | null => {
  const v = raw.toLowerCase().trim();
  if (v === '' || v === 'on' || v === 'true' || v === 'yes' || v === '1') {
    return true;
  }
  if (v === 'off' || v === 'false' || v === 'no' || v === '0') {
    return false;
  }
  return null;
};

/** Translate a psql VI_MODE var value into the LineEditor mode. */
const viModeOption = (raw: string | undefined): 'emacs' | 'vi' => {
  if (raw === undefined) return 'emacs';
  return parseBoolVar(raw) === true ? 'vi' : 'emacs';
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
  // VI_MODE: upstream readline's `set editing-mode {emacs|vi}`. We read once
  // here for the initial mode, and below we install a VarStore hook so a
  // subsequent `\set VI_MODE on` switches the editor at the next prompt.
  const initialMode = viModeOption(ctx.settings.vars.get('VI_MODE'));
  const editor = new LineEditor({
    stdin: ctx.stdin as NodeJS.ReadStream,
    stdout: ctx.stdout,
    history,
    completer: psqlCompleter({ settings: ctx.settings }),
    mode: initialMode,
  });
  // Hook: validate the value, reject unrecognised input with psql's
  // `\set: VI_MODE: invalid value "X"; valid values: on, off` diagnostic,
  // and on success forward to `editor.setMode` (which defers the switch to
  // the next readLine boundary). Replay on registration is fine — the hook
  // is idempotent for a no-op `null`/unchanged value.
  ctx.settings.vars.addHook('VI_MODE', (newValue) => {
    if (newValue === null) {
      editor.setMode('emacs');
      return true;
    }
    const parsed = parseBoolVar(newValue);
    if (parsed === null) {
      ctx.stderr.write(
        `\\set: VI_MODE: invalid value "${newValue}"; valid values: on, off\n`,
      );
      return false;
    }
    editor.setMode(parsed ? 'vi' : 'emacs');
    return true;
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
    interject: (text: string): void => {
      editor.interject(text);
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
    return makeStreamLineReader(ctx.stdin, ctx.stdout);
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
    return makeStreamLineReader(ctx.stdin, ctx.stdout);
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
  // Only emit a fallback `psql: ERROR:  <msg>` line for commands that did
  // NOT write their own diagnostic. The `errorWritten` flag distinguishes
  // these: commands using cmd_io's `errResult` (and inline writers) set it
  // to `true`; cond commands (which only stash `lastErrorResult.message`)
  // leave it unset so the mainloop surfaces the message.
  if (
    result.status === 'error' &&
    !result.errorWritten &&
    ctx.settings.lastErrorResult?.message
  ) {
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
    // Treat the "invalid command" message as already-written so the next
    // layer doesn't add a second one. (Other dispatch paths set
    // `lastErrorResult.message`; this one does not, so the duplicate
    // guard below would skip anyway — flag it explicitly for symmetry.)
    return { status: 'error', errorWritten: true };
  }
  const bctx = makeBackslashContext(ctx, cmdName, rawArgs, queryBuf);
  attachCondStack(bctx, ctx.cond);
  const result = await spec.run(bctx);
  // Same contract as `dispatchCondCommand`: only fall back to the bare
  // `psql: ERROR:  <msg>` shape when the command didn't already surface
  // its own diagnostic. Without this guard, `\gdesc` Parse failures
  // would emit a stray `psql: ERROR:  <msg>` line between the LINE/`^`
  // block and the `\errverbose` re-render, breaking the strict ordering
  // check in the conformance regex.
  if (
    result.status === 'error' &&
    !result.errorWritten &&
    ctx.settings.lastErrorResult?.message
  ) {
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

/**
 * Refresh psql vars that mirror connection-driven server state. Today this
 * is just `ENCODING` (tracks `client_encoding` ParameterStatus). Upstream
 * does the same check at the tail of `SendQuery` in common.c so a
 * `SET client_encoding = ...` lands on the psql var before the next
 * statement looks it up. Safe to call when no connection is bound.
 */
const refreshConnectionVars = (ctx: REPLContext): void => {
  const db = ctx.settings.db;
  if (!db) return;
  const enc = db.parameterStatus('client_encoding');
  if (enc !== undefined && ctx.settings.vars.get('ENCODING') !== enc) {
    ctx.settings.vars.set('ENCODING', enc);
  }
};

const dispatchSendQuery = async (
  ctx: REPLContext,
  sql: string,
): Promise<boolean> => {
  // Always consume the bind stash up-front so it's cleared regardless of which
  // branch runs (and regardless of success / failure on the bind path).
  const bind = consumeBindState(ctx.settings);

  // Pipeline-active routing: when `\startpipeline` is in effect, a
  // semicolon-terminated SQL must be appended to the pipeline as
  // Parse/Bind/Describe/Execute (no Sync). Sending it as a simple Query
  // would corrupt the pipeline — the in-flight extended-protocol replies
  // would land in `handleQueryMessage` and the pipeline's ResultSet
  // promises would never settle, leaving `\endpipeline` hung.
  //
  // Mirrors upstream psql: `SendQuery` checks `PQpipelineStatus` and routes
  // through `PQsendQueryParams`/`PQsendQuery` accordingly. We use the
  // session helper so the wire enqueueing matches `\sendpipeline`.
  const ps = getPipelineState(ctx.settings);
  if (ps && ctx.settings.db) {
    // Upstream `libpq` refuses `COPY ... FROM STDIN` / `COPY ... TO
    // STDOUT` inside a pipeline with the fatal diagnostic
    // "COPY in a pipeline is not supported, aborting connection".
    // Detect, emit the same wording client-side, and tear down the
    // connection so the mainloop's `checkConnectionLost` halt path
    // fires for any subsequent statement (matching the upstream
    // "aborting connection" semantics).
    const trimmed = sql.trimStart();
    if (
      /^COPY\b/i.test(trimmed) &&
      /\b(FROM\s+STDIN|TO\s+STDOUT)\b/i.test(trimmed)
    ) {
      ctx.stderr.write(
        'psql: error: COPY in a pipeline is not supported, aborting connection\n',
      );
      // Hard-abort the underlying socket so isClosed() flips true and the
      // mainloop's post-dispatch `checkConnectionLost` ends the loop.
      try {
        const db = ctx.settings.db as unknown as {
          abortForCopyInPipeline?: () => void;
          close?: () => Promise<void>;
        };
        if (typeof db.abortForCopyInPipeline === 'function') {
          db.abortForCopyInPipeline();
        } else if (typeof db.close === 'function') {
          await db.close();
        }
      } catch {
        // ignore — the diagnostic has already been emitted.
      }
      return false;
    }
    try {
      // Pipeline-mode `;`-queries: empty parameter list, anonymous prepared
      // statement, anonymous portal. The result will surface later through
      // `\endpipeline` / `\getresults`.
      await ps.session.parse('', sql, []);
      await ps.session.bind('', bind?.values ?? []);
      const exec = (async () => {
        await ps.session.execute('', 0);
        return undefined;
      })();
      ps.pending.push(exec);
      // The enqueue succeeded; the actual result will flush at
      // `\endpipeline` time. Mark the diagnostic vars as success-now so
      // intervening `\echo :ERROR` sees "false" between pipeline appends.
      refreshErrorVars(ctx.settings, { kind: 'success', rowCount: null });
      return true;
    } catch (err) {
      const message = captureLastError(ctx.settings, err, sql);
      writeQueryError(ctx, message);
      refreshErrorVars(ctx.settings, { kind: 'error' });
      return false;
    }
  }

  if (bind && ctx.settings.db) {
    const started = ctx.settings.timing ? Date.now() : 0;
    let lastRowCount: number | null = null;
    let hadError = false;
    try {
      const rs = await ctx.settings.db.query(sql, bind.values);
      // Route the single ResultSet through the unified printer pipeline so
      // `\bind` output looks identical to a simple-query result (and honours
      // `\o FILE`, format selection, expanded mode, etc.).
      const r = await renderResultSet(ctx, rs, pickOut(ctx));
      lastRowCount = r.lastRowCount;
      return true;
    } catch (err) {
      // Capture the full ErrorResponse payload (severity / code / position /
      // detail / hint / location) so the layered renderer can honour
      // VERBOSITY and SHOW_CONTEXT exactly like the simple-query path.
      const message = captureLastError(ctx.settings, err, sql);
      writeQueryError(ctx, message);
      hadError = true;
      return false;
    } finally {
      refreshConnectionVars(ctx);
      refreshErrorVars(
        ctx.settings,
        hadError
          ? { kind: 'error' }
          : { kind: 'success', rowCount: lastRowCount },
      );
      if (ctx.settings.timing) {
        ctx.stdout.write('\n' + formatDurationMs(Date.now() - started) + '\n');
      }
    }
  }
  const stats = await sendQuery(ctx, sql);
  refreshConnectionVars(ctx);
  return !stats.hadError;
};

/**
 * Format an async NotificationResponse (LISTEN/NOTIFY payload) the way
 * upstream's `PrintNotifications` in common.c does. Empty payloads omit the
 * payload clause for backward-compat with pre-9.0 servers.
 */
const formatNotification = (
  channel: string,
  payload: string,
  pid: number,
): string => {
  if (payload.length > 0) {
    return (
      `Asynchronous notification "${channel}" with payload "${payload}" ` +
      `received from server process with PID ${String(pid)}.\n`
    );
  }
  return (
    `Asynchronous notification "${channel}" ` +
    `received from server process with PID ${String(pid)}.\n`
  );
};

/**
 * Subscribe to NotificationResponse on the active connection, rendering each
 * to the REPL output (mirrors upstream `PrintNotifications` writing to
 * `pset.queryFout`). Returns the disposer the connection handed us, or
 * `null` when no connection is bound.
 */
const installNotificationHandler = (
  ctx: REPLContext,
  reader: LineReader,
): (() => void) | null => {
  const db = ctx.settings.db;
  if (!db) return null;
  return db.onNotification((channel, payload, pid) => {
    // Route through the reader so the LineEditor (when raw-mode active)
    // can clear / re-render its prompt block around the injected line.
    // The stream-reader path treats interject as a plain stdout write.
    reader.interject(formatNotification(channel, payload, pid));
  });
};

/**
 * Render a NoticeResponse field the same way libpq's `pqBuildErrorMessage3`
 * does for the default `psql_notice_processor` (which is a thin
 * `fputs(msg, stderr)`). Mirrors VERBOSITY / SHOW_CONTEXT semantics:
 *
 *   - `terse` / `sqlstate`: just `<severity>:  <message>` (`sqlstate` also
 *     prepends the SQLSTATE on the severity line).
 *   - `default`: severity line + LINE/^ pointer + DETAIL/HINT, and CONTEXT
 *     when SHOW_CONTEXT is `always` (NOTICE is not an error, so the default
 *     `errors` setting suppresses its CONTEXT — upstream's libpq path
 *     gates context on `severity_nonlocalized == "ERROR"|"FATAL"|"PANIC"`).
 *   - `verbose`: full SQLSTATE / DETAIL / HINT / CONTEXT / LOCATION layers.
 *
 * The trailing newline mirrors libpq, so callers can `stderr.write()` the
 * returned string directly.
 */
const formatNotice = (
  notice: Notice,
  verbosity: 'default' | 'verbose' | 'terse' | 'sqlstate',
  showContext: 'never' | 'errors' | 'always',
): string => {
  const severity = notice.severity || 'NOTICE';
  const message = notice.message || '';
  const lines: string[] = [];

  if (verbosity === 'verbose' || verbosity === 'sqlstate') {
    const sqlstate = notice.code ?? 'XX000';
    lines.push(`${severity}:  ${sqlstate}: ${message}`);
  } else {
    lines.push(`${severity}:  ${message}`);
  }

  if (verbosity === 'terse' || verbosity === 'sqlstate') {
    return lines.join('\n') + '\n';
  }

  if (notice.detail) lines.push(`DETAIL:  ${notice.detail}`);
  if (notice.hint) lines.push(`HINT:  ${notice.hint}`);

  // CONTEXT gating mirrors libpq's `pqBuildErrorMessage3`:
  //   - `verbose` always includes CONTEXT
  //   - `default` shows CONTEXT only when SHOW_CONTEXT is `always` for
  //     non-error severities (NOTICE / WARNING / INFO / LOG / DEBUG), or
  //     when SHOW_CONTEXT is `errors`/`always` for ERROR-level entries.
  const isError =
    severity === 'ERROR' || severity === 'FATAL' || severity === 'PANIC';
  const includeContext =
    verbosity === 'verbose' ||
    showContext === 'always' ||
    (showContext === 'errors' && isError);
  if (includeContext && notice.where) {
    lines.push(`CONTEXT:  ${notice.where}`);
  }

  if (verbosity === 'verbose' && (notice.routine || notice.file)) {
    const location =
      (notice.routine ?? '') +
      (notice.file ? `, ${notice.file}:${notice.line ?? ''}` : '');
    lines.push(`LOCATION:  ${location}`);
  }

  return lines.join('\n') + '\n';
};

/**
 * Subscribe to NoticeResponse on the active connection, rendering each to
 * stderr the way libpq's default `psql_notice_processor` does. Returns the
 * disposer the connection handed us, or `null` when no connection is bound.
 *
 * NOTICEs fire synchronously as the wire layer receives them, so an
 * inline `RAISE NOTICE` inside a `\;`-chained batch lands BEFORE the
 * tuples-producing portion of the batch is rendered — matching upstream
 * psql output.
 */
const installNoticeHandler = (
  ctx: REPLContext,
  reader: LineReader,
): (() => void) | null => {
  const db = ctx.settings.db;
  if (!db) return null;
  return db.onNotice((notice) => {
    // Skip in pipeline mode: cmd_pipeline.ts's `\endpipeline` / `\getresults`
    // re-renders each result's `notices[]` array via the per-result drain so
    // the NOTICE lands AT the result boundary, not before. Emitting here too
    // would duplicate every notice — once when the wire layer parses it,
    // once when the drain walks `rs.notices`.
    if (ctx.settings.sendMode === 'extended-pipeline') return;
    const text = formatNotice(
      notice,
      ctx.settings.verbosity,
      ctx.settings.showContext,
    );
    // Notices go to stderr (libpq default). The LineEditor's prompt-redraw
    // logic uses `interjectErr` to flush the message without disturbing the
    // active prompt block — fall back to a raw stderr write when the reader
    // doesn't expose that hook (stream / notty path).
    const interjectErr = (
      reader as LineReader & { interjectErr?: (s: string) => void }
    ).interjectErr;
    if (interjectErr) {
      interjectErr.call(reader, text);
    } else {
      ctx.stderr.write(text);
    }
  });
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
  // Tracks whether the most recently dispatched SQL statement (NOT a
  // backslash command) errored. Upstream psql's MainLoop maintains the
  // equivalent `success` flag; at end-of-input, if the last statement
  // failed we surface that as a non-zero exit even when ON_ERROR_STOP
  // is off (mirrors `\timing on; SELECT error` exiting non-zero).
  let lastWasError = false;

  const resetBuf = (): void => {
    queryBuf = '';
    scanState = initialScanState();
    stmtLineNumber = 1;
  };

  // Detect mid-script connection loss and, on first detection, emit the
  // upstream "connection to server was lost" diagnostic + flag EXIT_BADCONN.
  // Subsequent statements would all rethrow against the closed connection;
  // we halt the loop instead so we don't spam ERROR lines for every one.
  const checkConnectionLost = (): boolean => {
    if (ctx.settings.db?.isClosed()) {
      ctx.stderr.write('psql: error: connection to server was lost\n');
      successResult = EXIT_BADCONN;
      exitRequested = true;
      return true;
    }
    return false;
  };

  const sigintState: SigintState = { inQuery: false, resetBuf };
  const removeSigint = installSigint(ctx, sigintState);

  // Seed the ENCODING psql var from the server's client_encoding the first
  // time we enter the REPL — subsequent `SET client_encoding = ...` lands
  // back through `refreshConnectionVars` after each query.
  refreshConnectionVars(ctx);

  // Subscribe to async NotificationResponse (LISTEN/NOTIFY) so a `NOTIFY foo`
  // surfaces upstream's `Asynchronous notification "foo" ...` line. The
  // disposer is run in the finally block at exit so we don't leak listeners.
  const removeNotificationHandler = installNotificationHandler(ctx, reader);
  // Subscribe to NoticeResponse so `RAISE NOTICE` / NOTICE DETAIL / `drop
  // cascades` style server notices surface on stderr — matching libpq's
  // default `psql_notice_processor`. Notices arrive synchronously during
  // query execution, so inline `\;`-chain notices land at the right spot.
  const removeNoticeHandler = installNoticeHandler(ctx, reader);

  // Compute the prompt string for the current state. For notty input we emit
  // the empty string so the stream reader doesn't see prompt bytes interleaved
  // with stdout. For TTY input the LineEditor renders the prompt itself.
  const computePrompt = (status: PromptContext['promptStatus']): string => {
    if (ctx.settings.notty) return '';
    const name =
      queryBuf.trim().length === 0 || status === 'ready'
        ? 'PROMPT1'
        : status === 'copy'
          ? 'PROMPT3'
          : 'PROMPT2';
    const promptCtx = buildPromptContext(ctx, status, stmtLineNumber);
    return renderPromptByName(name, promptCtx);
  };

  // Resolves a psql variable for `:NAME` substitution in SQL bodies.
  // Backslash command bodies do their own expansion via `scanSlashArgs` in
  // `makeBackslashContext`, so this lookup only fires inside scanSql.
  const sqlVarLookup = (name: string): string | undefined =>
    ctx.settings.vars.get(name);

  // Resolves a backslash-command's argument-mode hint so scanSql can
  // consume the rest of the line correctly for whole-line / filepipe
  // commands. Upstream's psqlscanslash.l flips between `<xslasharg>` and
  // `<xslashwholeline>` based on the same hint — without it, the SQL
  // scanner would terminate a `\!` or `\sf` arg at the next `\` (e.g.
  // `\! whole_line \endif` would split into `\!` + `\endif`).
  const slashCmdMode = (
    cmdName: string,
  ): 'normal' | 'whole-line' | 'filepipe' | undefined => {
    const spec = ctx.registry.lookup(cmdName);
    if (!spec) return undefined;
    if (spec.argMode === 'whole-line') return 'whole-line';
    // Backslash registry currently only distinguishes whole-line vs the
    // default `lex` mode. Filepipe is signalled per-call via
    // `nextArg('filepipe')` inside cmd implementations rather than the
    // spec, so we infer it from a small allow-list of commands that
    // upstream declares as `OT_FILEPIPE` (`\w` and `\o`). Without this,
    // `\w |/no/such/file \else` would split off `\else` as a separate
    // command instead of capturing it as the file's whole-line arg.
    if (cmdName === 'w' || cmdName === 'o') return 'filepipe';
    return undefined;
  };

  /**
   * Strip block / line comments cheaply before scanning so a COPY-shaped
   * comment doesn't trigger pre-buffering or sink wiring.
   */
  const stripSqlComments = (sql: string): string =>
    sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

  /**
   * Count the number of `COPY ... FROM STDIN` segments in `sql`. Upstream
   * `handleCopyIn` in copy.c is invoked for each one that hits the wire as
   * a `\;`-chained simple-query batch; the mainloop must pre-buffer the
   * `\.`-terminated data block per occurrence and hand them to the wire
   * layer before dispatch so CopyInResponse is satisfied without a
   * blocking callback into the REPL.
   *
   * The regex tolerates the optional column list (`COPY t (a, b)`) and the
   * format clause (`COPY t FROM STDIN WITH (...)` / `... CSV ...`). False
   * positives inside string literals / comments are possible but extremely
   * rare in scripted workloads — and a false positive only over-consumes
   * lines from the input, which is recoverable. The conservative regex
   * here matches upstream `psql`'s scanner heuristics closely enough for
   * the conformance suite (`psql.sql` lines around 1467-1476).
   */
  const countCopyFromStdin = (sql: string): number => {
    const stripped = stripSqlComments(sql);
    const re = /\bCOPY\b[\s\S]*?\bFROM\s+STDIN\b/giu;
    let n = 0;
    while (re.exec(stripped) !== null) n += 1;
    return n;
  };

  /**
   * `true` when `sql` contains at least one `COPY ... TO STDOUT` segment.
   * The wire layer routes mid-batch CopyData into our `copyOutMidBatchSink`
   * when it's set; we install one for the duration of a batch that mentions
   * `TO STDOUT` so the bytes land on the active output stream.
   */
  const hasCopyToStdout = (sql: string): boolean =>
    /\bCOPY\b[\s\S]*?\bTO\s+STDOUT\b/iu.test(stripSqlComments(sql));

  /**
   * Read one COPY-FROM-STDIN data block: consume lines from the reader
   * until a bare `\.` arrives (or EOF / null). Returns the concatenated
   * payload as a Buffer with trailing newlines preserved (the wire side
   * sends the bytes verbatim; the server treats them as the COPY input).
   * The `\.` terminator itself is NOT included.
   */
  const readCopyDataBlock = async (): Promise<Buffer> => {
    const lines: string[] = [];
    for (;;) {
      const line = await reader.readLine('');
      if (line === null) break;
      if (line.replace(/\s+$/, '') === '\\.') break;
      lines.push(line);
      // Upstream `handleCopyIn` in copy.c reads COPY data lines straight
      // off `copystream` with `fgets` and ships them to the server via
      // `PQputCopyData` — there is no `--echo-all` branch on this path.
      // Suppressing the echo here keeps the COPY-FROM-STDIN data out of
      // the echo stream, matching vanilla: only the surrounding SQL
      // statement (`COPY ... FROM STDIN`) lands in stdout, not its
      // payload.
    }
    // Each line plus a trailing newline — matches the byte stream COPY
    // expects on its input side.
    const text = lines.length === 0 ? '' : lines.join('\n') + '\n';
    return Buffer.from(text, 'utf8');
  };

  /**
   * Process the assembled queryBuf+line through scanSql, dispatching the
   * boundaries it finds. Returns when we hit `incomplete`/`eof` and need
   * the next input line.
   */
  const processChunk = async (chunk: string): Promise<void> => {
    let working = chunk;
    while (working.length > 0) {
      const result = scanSql(working, scanState, sqlVarLookup, slashCmdMode);
      scanState = result.nextState;

      if (result.kind === 'semicolon') {
        // Use the substituted `result.sql` so `:NAME` references already
        // resolved at scan time make it into the executed SQL.
        const sqlText = queryBuf + result.sql;
        queryBuf = '';
        working = working.slice(result.consumed);
        scanState = initialScanState();
        stmtLineNumber = 1;
        if (!ctx.cond.isActive()) {
          // Suppressed: discard, no execution, no error.
          continue;
        }
        // COPY ... FROM STDIN appearing as a segment of a `\;`-chained
        // batch needs its CopyInResponse satisfied with the COPY data
        // block(s) that follow on stdin. We pre-buffer one block per
        // detected `FROM STDIN` occurrence and hand the bytes to the wire
        // layer before dispatch. Mirrors upstream `handleCopyIn` in
        // copy.c — except we pump the bytes up-front instead of via a
        // callback into the REPL when CopyInResponse arrives.
        const copyCount = ctx.settings.db ? countCopyFromStdin(sqlText) : 0;
        const wantsCopyOut =
          ctx.settings.db !== undefined && hasCopyToStdout(sqlText);
        if (copyCount > 0 && ctx.settings.db) {
          // The Connection type doesn't expose `queueCopyInData` (kept
          // off the frozen interface), but the concrete PgConnection
          // does. We duck-type the method to avoid coupling here.
          const conn = ctx.settings.db as unknown as {
            queueCopyInData?: (data: Buffer) => void;
            clearCopyInDataQueue?: () => void;
          };
          if (typeof conn.queueCopyInData === 'function') {
            // Drop any leftover buffers from a previous (failed) batch so
            // we don't accidentally re-use stale data.
            conn.clearCopyInDataQueue?.();
            for (let i = 0; i < copyCount; i += 1) {
              const block = await readCopyDataBlock();
              conn.queueCopyInData(block);
            }
          }
        }
        if (wantsCopyOut && ctx.settings.db) {
          // Wire a sink so the wire layer can forward mid-batch CopyData
          // bytes verbatim (matching `handleCopyOut`). Routes to the
          // active query output (`\o FILE` stashed stream when set,
          // otherwise `ctx.stdout`) — upstream `handleCopyOut` sinks the
          // bytes into `pset.queryFout`, which is whatever `\o` last
          // pointed at. Bytes already include trailing newlines on each
          // row, so we pass them through unchanged.
          const conn = ctx.settings.db as unknown as {
            copyOutMidBatchSink?: ((chunk: Buffer) => void) | null;
          };
          const out = pickOut(ctx);
          conn.copyOutMidBatchSink = (chunk: Buffer): void => {
            out.write(chunk);
          };
        }
        sigintState.inQuery = true;
        const ok = await dispatchSendQuery(ctx, sqlText);
        sigintState.inQuery = false;
        // Always clear any leftover queued blocks once the batch settles
        // (success or failure) so the next dispatch starts fresh.
        if (copyCount > 0 && ctx.settings.db) {
          const conn = ctx.settings.db as unknown as {
            clearCopyInDataQueue?: () => void;
          };
          conn.clearCopyInDataQueue?.();
        }
        if (wantsCopyOut && ctx.settings.db) {
          const conn = ctx.settings.db as unknown as {
            copyOutMidBatchSink?: ((chunk: Buffer) => void) | null;
          };
          conn.copyOutMidBatchSink = null;
        }
        lastWasError = !ok;
        // After any SQL statement, the server may have closed the connection
        // (e.g. pg_terminate_backend on our own pid). Surface that once and
        // halt — psql cannot recover from a lost connection mid-script.
        if (checkConnectionLost()) return;
        if (!ok && ctx.settings.onErrorStop) {
          successResult = EXIT_USER;
          exitRequested = true;
          return;
        }
        continue;
      }

      if (result.kind === 'backslash') {
        // Fold buffered SQL accumulated before the backslash into queryBuf.
        // `result.sql` carries the (possibly empty) text that preceded the
        // backslash in this scan pass — empty when the backslash was at the
        // top of the buffer, non-empty for shapes like
        // `SELECT 1 \watch c=3` or `SELECT error\gdesc`. Buffer-consuming
        // commands (\g, \gx, \gset, \gexec, \gdesc, \crosstabview, \watch,
        // \bind) will read this through `BackslashContext.queryBuf` and
        // return `reset-buf` to clear it; commands that don't care leave it
        // intact for the next dispatch.
        //
        // Track whether this scan started cleanly: empty queryBuf and the
        // backslash was at the head of `working`. In that case the slash
        // command is the ENTIRE source line — the trailing `\n` left in
        // `working` after the slice is just the line terminator, not an
        // inter-line continuation separator. We need to drop it after
        // dispatch so the next chunk's scanSql doesn't return an `eof`
        // with `sql: '\n'` and accumulate a stray leading newline into
        // the NEXT statement's queryBuf. Mirrors upstream `MainLoop()`'s
        // `query_buf->len == added_nl_pos` strip (mainloop.c lines
        // 480-484): when a line contains only a backslash command and
        // the scanner added nothing to the buffer, the appended `\n` is
        // taken back off so the buffer's `LINE N:` counting matches the
        // user's mental model.
        const slashOnlyLine = result.sql.length === 0 && queryBuf.length === 0;
        queryBuf += result.sql;
        working = working.slice(result.consumed);
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
          // Note: we intentionally do NOT update `lastWasError` for cond
          // errors. Upstream psql exits 0 from a script whose only failure
          // was `\endif: no matching \if` (or any other cond diagnostic) —
          // these are printed and the loop continues, but they don't taint
          // the terminal `lastWasError → EXIT_USER` escalation. Only
          // ON_ERROR_STOP can escalate cond failures.
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
          // The SQL scanner intentionally stops the backslash boundary on
          // (not past) the trailing line terminator so that an inter-line
          // `\n` separating a slash command from continuing SQL on the
          // next line survives in `working`. That's the right call when
          // the slash command leaves `queryBuf` intact — the `\n` keeps
          // line breaks in the assembled multi-line query.
          //
          // For `reset-buf`, however, the buffer is being intentionally
          // dropped: the slash command (`\g`, `\gset`, `\gdesc`, `\gexec`,
          // `\crosstabview`, `\watch`, `\bind`, `\parse`, …) has just
          // consumed and dispatched whatever was buffered. A residual
          // `\n` at the head of `working` is then leftover line-terminator
          // bytes from the slash-command line itself — NOT a continuation
          // separator. If we let it survive, the next scanSql pass returns
          // an `eof` with `sql: '\n'`, the loop's
          // `queryBuf += result.sql` line folds it into the NEXT
          // statement's buffer, and commands that store the buffer
          // verbatim (notably `\parse`, which uses the buffer text as the
          // prepared-statement source) emit a stray leading 0x0a byte.
          //
          // Strip the line terminator here so the next pass starts cleanly.
          // This matches upstream `psql_scan_slash_command_end()`'s eat-
          // through-newline behaviour for the buffer-reset case — without
          // changing the scanner's semantics for the inline-slash + multi-
          // line shape that depends on the `\n` surviving.
          if (working.startsWith('\r\n')) {
            working = working.slice(2);
          } else if (working.startsWith('\n') || working.startsWith('\r')) {
            working = working.slice(1);
          }
        }
        // For status='ok' (the buffer was NOT consumed by the slash command),
        // also drop the `\n` left in `working` when the slash command was
        // the sole content of this source line. Upstream's
        // `query_buf->len == added_nl_pos` strip (mainloop.c lines 480-484)
        // covers the same shape: a line whose only token is a slash command
        // doesn't contribute a `\n` to `query_buf`. Without this, e.g.
        //   \set ECHO errors
        //   SELECT * FROM bad;
        // would assemble the SELECT's queryBuf as `\n` + `SELECT...` —
        // shifting the server's `LINE N` count by one and contaminating
        // the `STATEMENT:  ...` echo emitted on error.
        if (bres?.status !== 'reset-buf' && slashOnlyLine) {
          if (working.startsWith('\r\n')) {
            working = working.slice(2);
          } else if (working.startsWith('\n') || working.startsWith('\r')) {
            working = working.slice(1);
          }
        }
        // Upstream `mainloop.c`: on PSQL_CMD_ERROR, the query buffer is
        // reset and the scanner state is dropped. Mirrors `resetPQExpBuffer`
        // + `psql_scan_reset`. Without this, a buffer-consuming command
        // that fails (e.g. `SELECT 1 \watch 1 1` rejecting duplicate
        // positional intervals) would leave `SELECT 1 ` in the buffer for
        // the next prompt — and in notty mode the tail dispatch would
        // execute it, masking the failure exit code.
        //
        // Upstream `HandleSlashCmds` additionally silently discards the
        // remainder of the current line via `psql_scan_slash_option(scan_state,
        // OT_WHOLE_LINE, …)` when a backslash command returns PSQL_CMD_ERROR.
        // Mirror that here by dropping `working` up to and including the next
        // newline. Without this, `\bind_named NAME 1 2 \gset pref02_ \echo X`
        // would still execute `\echo X` after the pipeline-mode `\gset`
        // rejection — vanilla suppresses it.
        if (bres?.status === 'error') {
          queryBuf = '';
          scanState = initialScanState();
          stmtLineNumber = 1;
          // Discard any trailing content on the SAME physical line — but NOT
          // the rest of the script. The scanner consumes a slash command's
          // args but typically leaves the line terminator (`\n`) at the head
          // of `working`. If `working` starts with `\n` / `\r\n`, the failed
          // command was already at end-of-line — just drop the terminator
          // and let the next line dispatch normally. If `working` has
          // non-newline chars before the next `\n`, drop up to and including
          // that `\n` (mirrors upstream `HandleSlashCmds`' `OT_WHOLE_LINE`
          // discard). Without this branch a stack of `\gdesc\n\gdesc\n…`
          // lines collapses to a single dispatched `\gdesc` because the
          // first discard ate the second line.
          if (working.startsWith('\r\n')) {
            working = working.slice(2);
          } else if (working.startsWith('\n') || working.startsWith('\r')) {
            working = working.slice(1);
          } else {
            const nlIdx = working.indexOf('\n');
            working = nlIdx === -1 ? '' : working.slice(nlIdx + 1);
          }
        }
        lastWasError = bres?.status === 'error';
        // Backslash commands like \connect can also tear down the connection.
        if (checkConnectionLost()) return;
        if (bres?.status === 'error' && ctx.settings.onErrorStop) {
          successResult = EXIT_USER;
          exitRequested = true;
          return;
        }
        continue;
      }

      // incomplete or eof — keep accumulating. Use the substituted
      // `result.sql` so `:NAME` tokens that were fully consumed in this
      // chunk land in the buffer in expanded form. (A `:NAME` that
      // straddles two chunks falls back to the literal — a corner case
      // upstream also handles only when the variable name fits inside the
      // current buffer; the line-reader feeds whole lines so this is
      // effectively unreachable in interactive use.)
      queryBuf += result.sql;
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
      // `'continue'` so PROMPT2 renders `-` instead of `=`. A whitespace-only
      // residue (e.g. a trailing `\n` left over after a `;` boundary) counts
      // as empty so the next prompt is PROMPT1 not PROMPT2.
      const status: PromptContext['promptStatus'] =
        queryBuf.trim().length === 0
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

      // Upstream `mainloop.c` MainLoop():
      //
      //   if (line[0] == '\0' && !psql_scan_in_quote(scan_state))
      //   {
      //       free(line);
      //       continue;
      //   }
      //
      // I.e., bare-empty lines are skipped entirely (no echo, no scanner
      // pass) UNLESS the scanner is mid-quote (single-, double-, dollar-,
      // or block-comment continuation). Inside a quote we keep the empty
      // line so it lands in the assembled query buffer (e.g. a quoted
      // identifier `"ab\n\nc"` spans multiple input lines including blanks),
      // and `--echo-all` surfaces it so the echo stream tracks the source
      // verbatim.
      //
      // `psql_scan_in_quote` returns true for all start_states except
      // INITIAL and xqs — we approximate with the scanner-state fields
      // that track each quoted construct. `parenDepth` is intentionally
      // omitted (upstream doesn't count it as in-quote).
      const scanInQuote =
        scanState.inBlockComment > 0 ||
        scanState.inSingleQuote ||
        scanState.inDoubleQuote ||
        scanState.dollarTag !== null;
      if (line.length === 0 && !scanInQuote) {
        continue;
      }

      // 2'. ECHO=all — upstream `--echo-all` / `\set ECHO all` echoes every
      // input line to stdout *before* it's processed. Blank lines outside a
      // quote already short-circuited above, so a blank reaching here means
      // the scanner is mid-quote and the line is part of the assembled
      // statement. ECHO=queries echoes only completed queries — handled
      // separately by the exec path.
      if (ctx.settings.echo === 'all') {
        ctx.stdout.write(line + '\n');
      }

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
        lastWasError = !ok;
        if (ctx.settings.db?.isClosed()) {
          ctx.stderr.write('psql: error: connection to server was lost\n');
          successResult = EXIT_BADCONN;
        } else if (!ok && ctx.settings.onErrorStop) {
          successResult = EXIT_USER;
        }
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

    // Upstream MainLoop's terminal check: when the very last statement
    // errored and we haven't already escalated to a worse exit code, surface
    // EXIT_USER. Only kicks in for scripted input (`notty`); the interactive
    // REPL never propagates per-statement failures into the process exit.
    if (lastWasError && ctx.settings.notty && successResult === EXIT_SUCCESS) {
      successResult = EXIT_USER;
    }
  } finally {
    await reader.close();
    removeSigint();
    if (removeNotificationHandler) removeNotificationHandler();
    if (removeNoticeHandler) removeNoticeHandler();
  }

  return successResult;
};

// Re-export the IfState union so callers driving the loop directly can build
// CondStack instances without dipping into the types/ module. Keeps the public
// surface of mainloop self-contained for WP-12 consumers.
export type { IfState };

/**
 * Test-only surface. Exposes the small VI_MODE helpers so the matching unit
 * tests can exercise the parse / translate logic without engaging the
 * raw-mode LineEditor. Treated as private — callers should not rely on it.
 */
export const __testing = {
  parseBoolVar,
  viModeOption,
};
