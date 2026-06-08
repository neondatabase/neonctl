/**
 * psql I/O & control backslash commands.
 *
 * TypeScript port of the following `exec_command_*` functions in upstream
 * PostgreSQL's `src/bin/psql/command.c`:
 *
 *   - `\i`,  `\include`           → exec_command_include          (normal)
 *   - `\ir`, `\include_relative`  → exec_command_include          (relative=true)
 *   - `\o`,  `\out`               → exec_command_out
 *   - `\w`,  `\write`             → exec_command_write
 *   - `\g`                        → exec_command_g
 *   - `\gx`                       → exec_command_g  (force_expanded=true)
 *   - `\gset`                     → exec_command_gset
 *   - `\gdesc`                    → exec_command_gdesc
 *   - `\gexec`                    → exec_command_gexec
 *   - `\watch`                    → exec_command_watch
 *
 * Each is exported as a `BackslashCmdSpec` and registered via
 * {@link registerIoCommands}. The single line that wires us into the
 * default dispatcher lives in `dispatch.ts::defaultRegistry()`.
 *
 * # Integration touch-points and known limitations
 *
 * Several of these commands really want to participate in the mainloop's
 * scanner/printer pipeline. This WP keeps `src/psql/core/mainloop.ts`
 * untouched, so we provide the data structures and let a follow-up WP wire
 * the consumption sites. Limitations documented per-command:
 *
 *   - `\i FILE` enqueues the file's contents on a small input queue
 *     (`./inputQueue.ts`) AND, as a stop-gap, executes the file's SQL
 *     directly via `Connection.execSimple`. Backslash commands embedded in
 *     the file are NOT processed by the scanner; the include is a "best
 *     effort: run as one big SQL blob". Once mainloop adopts the queue API
 *     this becomes a true include.
 *
 *   - `\o FILE` opens a writable stream and stashes it under a symbol on
 *     `settings`. We expose a getter (`getQueryFout`) for the mainloop to
 *     consult; until that wiring happens, query output continues to flow
 *     to the mainloop's `ctx.stdout`. The stash + close-on-rebind logic is
 *     in place and fully tested.
 *
 *   - `\g` (no arg) executes the current queryBuf directly through
 *     `Connection.execSimple` and renders via the aligned printer. This
 *     duplicates a tiny slice of mainloop's send/print pipeline, which is
 *     fine for the bytewise-simple cases this WP needs to support. For
 *     `\g FILE` / `\g |cmd` the output goes through the temporary writer.
 *
 *   - `\gx` toggles `topt.expanded` for the single execution and restores
 *     the prior value in a `try { ... } finally { ... }`.
 *
 *   - `\gset [PREFIX]` executes via `execSimple`, requires the last result
 *     to have exactly one row, and stores `${prefix}${colname}` → value
 *     for each column on `settings.vars`.
 *
 *   - `\gdesc` parses the buffered query with the extended protocol
 *     (Parse + Describe by statement, no Execute), then assembles a
 *     synthetic `Column / Type` ResultSet and renders it through the
 *     active printer (`alignedPrinter` by default; the format picker
 *     honours `\pset format`). Tuples-only mode (`\t on`) and `\o FILE`
 *     redirects ride along automatically because the same ResultSet
 *     goes through the same printer the REPL would use for a query.
 *
 *   - `\gexec` iterates the cells of the last result row-major and feeds
 *     each non-null cell back as SQL through `execSimple`. Each statement's
 *     output is rendered to stdout (or to the active queryFout stash).
 *
 *   - `\watch [INTERVAL]` re-executes the queryBuf every `INTERVAL` seconds
 *     (default 2) until SIGINT or until the iteration count limit is hit.
 *     We hook SIGINT via a transient listener that's removed on completion.
 *     Tests bypass the listener by using an AbortController exposed via
 *     `WATCH_TEST_CONTROLLER`.
 *
 * # Error format
 *
 * Upstream prints `<cmd>: <msg>` to stderr and returns failure. We mirror
 * that and also stash the message on `settings.lastErrorResult` so the
 * mainloop's `writeError()` wrapper can pick it up.
 */

import { spawn } from 'node:child_process';
import {
  promises as fsPromises,
  closeSync,
  createWriteStream,
  fsyncSync,
  openSync,
} from 'node:fs';
import * as path from 'node:path';
import { platform } from 'node:os';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { Printer } from '../types/printer.js';

import { alignedPrinter } from '../print/aligned.js';
import { asciidocPrinter } from '../print/asciidoc.js';
import { csvPrinter } from '../print/csv.js';
import { htmlPrinter } from '../print/html.js';
import { jsonPrinter } from '../print/json.js';
import { latexLongtablePrinter, latexPrinter } from '../print/latex.js';
import { troffMsPrinter } from '../print/troff.js';
import { unalignedPrinter } from '../print/unaligned.js';

import { writeErr, writeOut } from './shared.js';
import { formatErrorReport, psqlErrorPrefix } from './cmd_meta.js';
import { applyPset } from './cmd_format.js';
import {
  consumeBindState,
  lookupPrepared,
  stagedNamedBindPresent,
} from './cmd_pipeline.js';
import {
  captureLastError,
  refreshErrorVars,
  stripLeadingCommentsAndWS,
} from '../core/common.js';

// ---------------------------------------------------------------------------
// Query-output (queryFout) stash.
//
// psql tracks a "query output" file pointer separately from stdout (see
// pset.queryFout in upstream settings.h). Our PsqlSettings type is frozen
// at WP-00, so we stash the stream on the settings object via a well-known
// symbol — the same approach used for the CondStack in cmd_cond.ts.
// ---------------------------------------------------------------------------

const QUERY_FOUT_KEY = Symbol.for('neonctl.psql.queryFout');

type QueryFoutEntry = {
  stream: NodeJS.WritableStream;
  /**
   * Closer used by `\o` rebinds to drain the previous target.
   *
   * For pipe targets the resolved object carries the spawned program's
   * exit status (`exitCode`, `null` if the child died from a signal) and
   * the terminating signal name when applicable. `\w | program` uses these
   * to render an upstream-style `wait_result_to_str` message; `\g |
   * program` is silent and only consults them for SHELL_ERROR/
   * SHELL_EXIT_CODE bookkeeping (future WP). File targets resolve with an
   * object whose pipe fields are omitted.
   *
   * `isPipe` lets callers distinguish file targets from pipe targets
   * cheaply — the file branch resolves `exitCode=undefined` and we'd
   * otherwise be unable to tell that apart from a successful pipe exit
   * (`exitCode=0`).
   */
  isPipe: boolean;
  close: () => Promise<{
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  }>;
};

type FoutStash = Record<symbol, unknown> & {
  [QUERY_FOUT_KEY]?: QueryFoutEntry;
};

/**
 * Return the currently active queryFout stream (or `null` if none).
 * The mainloop is encouraged to call this in lieu of writing directly to
 * `ctx.stdout` for query results.
 */
export const getQueryFout = (
  settings: PsqlSettings,
): NodeJS.WritableStream | null => {
  const stash = settings as unknown as FoutStash;
  return stash[QUERY_FOUT_KEY]?.stream ?? null;
};

const setQueryFout = (
  settings: PsqlSettings,
  entry: QueryFoutEntry | null,
): void => {
  const stash = settings as unknown as FoutStash;
  if (entry === null) {
    stash[QUERY_FOUT_KEY] = undefined;
  } else {
    stash[QUERY_FOUT_KEY] = entry;
  }
};

const closeQueryFout = async (settings: PsqlSettings): Promise<void> => {
  const stash = settings as unknown as FoutStash;
  const prev = stash[QUERY_FOUT_KEY];
  if (prev) {
    stash[QUERY_FOUT_KEY] = undefined;
    await prev.close();
  }
};

// ---------------------------------------------------------------------------
// Watch SIGINT escape hatch (tests).
//
// `\watch` installs a SIGINT handler so Ctrl-C breaks the polling loop in
// real psql sessions. Tests need to break the loop deterministically; we
// expose an AbortController hook that, if set, takes precedence.
// ---------------------------------------------------------------------------

export const WATCH_TEST_CONTROLLER: { ref: AbortController | null } = {
  ref: null,
};

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

const errResult = (ctx: BackslashContext, message: string): BackslashResult => {
  ctx.settings.lastErrorResult = { message };
  // Upstream psql prefixes every diagnostic with the `psql:[<file>:<n>]:`
  // tag that `pg_log_pre_callback` adds. Mirror that here so backslash
  // command errors look like upstream when surfaced via `psql_fails_like`.
  const prefix = psqlErrorPrefix(ctx.settings);
  writeErr(`${prefix}\\${ctx.cmdName}: ${message}\n`);
  // Tell the mainloop the error has already been surfaced — without this
  // it would also write a `psql: ERROR:  <msg>` fallback, producing a stray
  // duplicate that breaks the `\errverbose` ordering check on tests like
  // `SELECT error\gdesc\n\errverbose`.
  return { status: 'error', errorWritten: true };
};

/**
 * Reject buffer-consuming commands when an extended pipeline is open. Upstream
 * `exec_command_g` / `gx` / `gset` / `gexec` / `watch` all guard with
 * `PQpipelineStatus(pset.db) != PQ_PIPELINE_OFF` and emit
 * `pg_log_error("\\%s not allowed in pipeline mode", cmd)` (note: no `:`
 * after the command name — different shape from `errResult`).
 *
 * `\gdesc` is the odd one out: upstream uses
 * `pg_log_error("synchronous command execution functions are not allowed in
 * pipeline mode")` because the underlying `PQdescribePrepared`/`PQfn`-style
 * helpers all share that text — the regress baseline asserts this exact
 * wording at three call sites in `psql_pipeline.out`.
 *
 * If the command proceeded it would inject a synchronous Query/Sync into the
 * queue, corrupt the pipeline state, and leave `\endpipeline` waiting forever.
 *
 * Returns `null` when not in pipeline mode (caller proceeds); otherwise
 * returns a populated error result the caller should bubble up.
 *
 * Upstream psql 18.4 leaks gate diagnostics through `pg_log_error_internal`
 * which appends to the libpq result error log on the underlying PGresult;
 * each subsequent gate hit RE-EMITS the full accumulated log plus its own
 * line ("Error messages accumulate and are repeated" — the regress comment
 * is the spec). Two `\gdesc` calls back-to-back therefore emit 3 lines
 * total: 1 for the first call, 2 for the second (one accumulated + one
 * own). Mirror that with a settings-stashed accumulator keyed off the
 * current pipeline session; reset when the pipeline ends.
 */
const PIPELINE_GATE_ERRORS_KEY = Symbol.for('neonctl.psql.pipelineGateErrors');

type GateErrorsStash = Record<symbol, unknown> & {
  [PIPELINE_GATE_ERRORS_KEY]?: string[];
};

const getGateErrors = (settings: PsqlSettings): string[] => {
  const s = settings as unknown as GateErrorsStash;
  let cur = s[PIPELINE_GATE_ERRORS_KEY];
  if (!cur) {
    cur = [];
    s[PIPELINE_GATE_ERRORS_KEY] = cur;
  }
  return cur;
};

/**
 * Drop the accumulated pipeline-gate errors. Called from
 * `\endpipeline` so the next pipeline session starts fresh — without
 * this, gate errors from a closed pipeline would leak into the next
 * one.
 */
export const clearPipelineGateErrors = (settings: PsqlSettings): void => {
  const s = settings as unknown as GateErrorsStash;
  s[PIPELINE_GATE_ERRORS_KEY] = undefined;
};

const pipelineGate = (ctx: BackslashContext): BackslashResult | null => {
  if (ctx.settings.sendMode !== 'extended-pipeline') return null;
  const message =
    ctx.cmdName === 'gdesc'
      ? 'synchronous command execution functions are not allowed in pipeline mode'
      : `\\${ctx.cmdName} not allowed in pipeline mode`;
  ctx.settings.lastErrorResult = { message };
  const prefix = psqlErrorPrefix(ctx.settings);
  // Only `\gdesc` accumulates: each call appends its own line to the
  // log AND re-emits the full log to stderr ("Error messages
  // accumulate and are repeated" — regress spec at expected line 648:
  // two consecutive `\gdesc` emit 1+2 = 3 lines total). Upstream's
  // underlying `PQdescribePrepared` path is the one that leaks into
  // the session-scoped error log; other gated commands (`\g`, `\gx`,
  // `\gset`, `\gexec`, `\watch`) emit a single line per invocation
  // and do NOT participate in the accumulator.
  if (ctx.cmdName === 'gdesc') {
    const log = getGateErrors(ctx.settings);
    log.push(message);
    for (const m of log) {
      writeErr(`${prefix}${m}\n`);
    }
  } else {
    writeErr(`${prefix}${message}\n`);
  }
  return { status: 'error', errorWritten: true };
};

/**
 * Set of psql variables upstream marks as "specially treated" — i.e. names
 * that have a substitute / assign hook installed in `startup.c`'s
 * `EstablishVariableSpace`. Used by `\gset` to reject assignments into
 * those names (matching upstream `StoreQueryTuple`'s `VariableHasHook`
 * check). We mirror the upstream list directly so a `\gset IGNORE` into
 * `IGNOREEOF` produces the conformance-expected warning even though our
 * settings.ts hasn't installed the IGNOREEOF / HISTFILE hooks yet — that
 * gap is tracked separately and harmless because the values are read-only
 * for us.
 */
const UPSTREAM_SPECIAL_VAR_NAMES: ReadonlySet<string> = new Set([
  'AUTOCOMMIT',
  'COMP_KEYWORD_CASE',
  'ECHO',
  'ECHO_HIDDEN',
  'FETCH_COUNT',
  'HIDE_TABLEAM',
  'HIDE_TOAST_COMPRESSION',
  'HISTCONTROL',
  'HISTFILE',
  'HISTSIZE',
  'IGNOREEOF',
  'ON_ERROR_ROLLBACK',
  'ON_ERROR_STOP',
  'PROMPT1',
  'PROMPT2',
  'PROMPT3',
  'QUIET',
  'SHOW_ALL_RESULTS',
  'SHOW_CONTEXT',
  'SINGLELINE',
  'SINGLESTEP',
  'VERBOSITY',
]);

/**
 * True when `name` is a psql variable that `\gset` must skip with an
 * "attempt to \gset into specially treated variable" message. Combines the
 * registered-hook check (so future hook installations are automatically
 * covered) with the upstream-canonical list above (so cases like
 * IGNOREEOF that aren't hooked in our settings.ts still match upstream's
 * `\gset` behaviour exactly).
 */
const isSpeciallyTreatedVar = (settings: PsqlSettings, name: string): boolean =>
  settings.vars.hasSubstituteHook(name) || UPSTREAM_SPECIAL_VAR_NAMES.has(name);

// `stripLeadingCommentsAndWS` lives in core/common.ts so the wire path
// (sendQuery / executeAndPrint) and the slash-command paths share one
// implementation. Re-imported from there at the top of the file.

/**
 * Strip line and block comments from `sql` so a COPY-shaped token inside a
 * comment (e.g. dash-dash `COPY t TO STDOUT`) doesn't trigger the
 * `\g FILE` mid-batch sink. Mirrors the cheap normaliser the mainloop uses
 * before wiring `copyOutMidBatchSink`. Embedded literals are NOT stripped —
 * `'COPY x TO STDOUT'` would still match `hasCopyToStdout`, but that's the
 * same false-positive shape upstream tolerates (the regex sweep is
 * intentionally conservative, and the worst-case outcome is "route bytes
 * that never arrive to the file" — harmless).
 */
const stripSqlCommentsForCopyScan = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/--[^\n]*/gu, '');

/**
 * True when `sql` contains at least one `COPY ... TO STDOUT` segment.
 * Used by `runGCore` to install a CopyData sink while `\g` / `\gx` /
 * `\g FILE` / `\g |cmd` dispatches a `\;`-chained batch that mixes
 * COPY-OUT with regular SELECT statements. Without the sink the wire
 * layer drops the CopyData bytes on the floor, and the file/pipe ends
 * up with the surrounding tuple results only — see regress/psql lines
 * 5760-5787 (`COPY (SELECT 'foo') TO STDOUT \; COPY (SELECT 'bar') TO
 * STDOUT \g :g_out_file`).
 */
const hasCopyToStdout = (sql: string): boolean =>
  /\bCOPY\b[\s\S]*?\bTO\s+STDOUT\b/iu.test(stripSqlCommentsForCopyScan(sql));

/**
 * Render a server-side error in upstream psql's 3-line shape (severity +
 * message, then `LINE N:` / `^` re-print) and refresh the `:LAST_ERROR_*`
 * diagnostic variables so a subsequent `\errverbose` sees the rich payload.
 *
 * Mirrors the path that `core/common.ts::writeQueryError` takes for top-level
 * statement errors: capture full ErrorResponse fields onto
 * `settings.lastErrorResult`, render via `formatErrorReport` (honouring
 * VERBOSITY + SHOW_CONTEXT), prefix only the leading severity line with
 * `psql:[<file>:<n>]:`, and update the per-statement diagnostic vars via
 * `refreshErrorVars`.
 *
 * Used by `\g`, `\gx`, `\gset`, `\gdesc`, and `\gexec` so a server-rejected
 * statement dispatched through them renders the same shape vanilla psql
 * produces, instead of the legacy `\<cmd>: <message>` one-liner.
 */
const formatServerError = (
  ctx: BackslashContext,
  err: unknown,
  sql: string,
): BackslashResult => {
  // Stash full ErrorResponse payload so `\errverbose` can re-render later.
  const msg = captureLastError(ctx.settings, err, sql);
  const e = ctx.settings.lastErrorResult;
  if (e) {
    const lines = formatErrorReport(
      e,
      ctx.settings.verbosity,
      ctx.settings.showContext,
    );
    const prefix = psqlErrorPrefix(ctx.settings);
    const prefixed = [prefix + lines[0], ...lines.slice(1)];
    writeErr(prefixed.join('\n') + '\n');
  } else {
    // Defensive fallback — captureLastError always sets lastErrorResult,
    // but if a future caller bypasses it, surface at least the message.
    const prefix = psqlErrorPrefix(ctx.settings);
    writeErr(`${prefix}ERROR:  ${msg}\n`);
  }
  // Refresh `:SQLSTATE`, `:ERROR`, `:LAST_ERROR_*`, `:ROW_COUNT` so the
  // following `\echo :LAST_ERROR_MESSAGE` and `\errverbose` see the new
  // outcome. Matches upstream's `SetErrorVariables` call after every
  // failed dispatch.
  refreshErrorVars(ctx.settings, { kind: 'error' });
  return { status: 'error', errorWritten: true };
};

/**
 * Open a writable destination for `\o` / `\w` / `\g FILE` / `\g |cmd`.
 *
 * `target` of the form `|cmd` spawns `sh -c cmd` and pipes to its stdin.
 * The returned closer waits for the child to exit and resolves to its
 * status + terminating signal (if any) so callers can render
 * `wait_result_to_str`-style errors. Any other string is treated as a
 * file path; the file is truncated.
 */
const openWriter = (target: string): QueryFoutEntry => {
  if (target.startsWith('|')) {
    const cmd = target.slice(1);
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    // Swallow EPIPE on the stdin pipe — the child may exit before we
    // finish writing, and Node would otherwise raise an unhandled error.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') {
        // Re-raise non-EPIPE errors as a crash so they show up; tests
        // run with the default unhandledRejection handler and will see
        // these via the failing assertion.
        throw err;
      }
    });
    return {
      stream: child.stdin,
      isPipe: true,
      close: () =>
        new Promise<{
          exitCode: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) => {
          let settled = false;
          const finish = (
            code: number | null,
            signal: NodeJS.Signals | null,
          ): void => {
            if (settled) return;
            settled = true;
            resolve({ exitCode: code, signal });
          };
          child.once('close', (code, signal) => {
            finish(code, signal);
          });
          child.once('error', () => {
            // spawn failure or stdio glitch — treat as a non-zero exit so
            // \w sees a failure. \g intentionally ignores this, mirroring
            // upstream `CloseGOutput` which only sets SHELL_ERROR /
            // SHELL_EXIT_CODE.
            finish(127, null);
          });
          // Half-close stdin so the child sees EOF and exits.
          if (!child.stdin.destroyed) {
            child.stdin.end();
          }
        }),
    };
  }
  // Open the file synchronously up-front so a bad path (ENOENT,
  // EACCES, EISDIR, …) throws here — before any write — instead of
  // emitting an asynchronous `'error'` event on the lazily-opened
  // WriteStream that Node would then re-raise as an unhandled
  // exception and kill the process. Upstream psql calls `fopen()`
  // synchronously and reports the failure via `pg_log_error` while
  // continuing to read the next command, which is the behaviour we
  // need to mirror for `\g FILE`, `\o FILE`, `\w FILE` and friends.
  //
  // Wrapping the resulting fd in `createWriteStream({ fd })` retains
  // the streaming write interface the rest of the code expects. Disable
  // `autoClose` so we control the close order — we fsync before close so
  // a follow-on server-side `COPY FROM` (Docker bind-mount on macOS) sees
  // the fully flushed file even when the next command immediately follows
  // the `\g`.
  const fd = openSync(target, 'w');
  const stream = createWriteStream(target, {
    encoding: 'utf8',
    fd,
    autoClose: false,
  });
  // openSync catches OPEN failures synchronously, but a WRITE-time failure
  // (ENOSPC / EDQUOT after a clean open, e.g. a multi-MB result to a
  // quota-limited fs) emits an asynchronous 'error'. Without a listener Node
  // re-raises it as an uncaught exception and kills the whole neonctl process.
  // Capture it; close() surfaces it to the caller.
  let writeError: Error | null = null;
  stream.on('error', (err: Error) => {
    writeError = writeError ?? err;
  });
  return {
    stream,
    isPipe: false,
    close: () =>
      new Promise<Record<string, never>>((resolve, reject) => {
        if (writeError !== null) {
          try {
            closeSync(fd);
          } catch {
            // swallow — the write error takes precedence
          }
          reject(writeError);
          return;
        }
        // `stream.end(cb)` fires after the internal buffer drains to the
        // underlying fd. Once that returns, the fd still holds dirty data
        // in the kernel buffer cache; on macOS + Docker bind mounts the
        // server inside the container can read the file before the cache
        // flushes through to the bind mount, returning a partial view.
        // Force an fsync against the open fd before closing so the
        // bytes are guaranteed visible to subsequent reads — including
        // server-side `COPY FROM` reading via the mount.
        stream.end((err?: Error | null) => {
          if (err) {
            try {
              closeSync(fd);
            } catch {
              // swallow — the original error takes precedence
            }
            reject(err);
            return;
          }
          try {
            fsyncSync(fd);
          } catch {
            // ignore — fsync best-effort; the close below still cleans up.
          }
          try {
            closeSync(fd);
          } catch (closeErr) {
            reject(closeErr as Error);
            return;
          }
          // Docker Desktop on macOS uses virtiofs/gRPC-FUSE for bind
          // mounts; cache propagation from host writes to the container's
          // view is eventual, not synchronous. A subsequent server-side
          // `COPY FROM '/bind/mount/file'` can read a partial view even
          // though the file is fully synced on the host. Linux + Windows
          // bind mounts are coherent, so this branch is macOS-only.
          if (platform() === 'darwin') {
            setTimeout(() => {
              resolve({});
            }, 25);
            return;
          }
          resolve({});
        });
      }),
  };
};

/**
 * Map a Node.js errno (`err.code`) to the libc `strerror()` string
 * upstream psql renders in its `pg_log_error("%s: %m", fname)` path.
 *
 * Falls back to `err.message` (with the verbose `ENOENT: ...` prefix
 * stripped if present) so unmapped errno values still surface
 * meaningful text instead of a cryptic Node-internal phrasing.
 */
const errnoToStrerror = (err: NodeJS.ErrnoException): string => {
  switch (err.code) {
    case 'ENOENT':
      return 'No such file or directory';
    case 'EACCES':
      return 'Permission denied';
    case 'EISDIR':
      return 'Is a directory';
    case 'ENOTDIR':
      return 'Not a directory';
    case 'EEXIST':
      return 'File exists';
    case 'EROFS':
      return 'Read-only file system';
    case 'ELOOP':
      return 'Too many levels of symbolic links';
    case 'ENAMETOOLONG':
      return 'File name too long';
    case 'ENOSPC':
      return 'No space left on device';
    case 'EMFILE':
      return 'Too many open files';
    case 'ENFILE':
      return 'Too many open files in system';
    case 'EIO':
      return 'Input/output error';
    case 'EFBIG':
      return 'File too large';
    case 'EDQUOT':
      return 'Disk quota exceeded';
    case 'EPERM':
      return 'Operation not permitted';
    case 'EINVAL':
      return 'Invalid argument';
    default: {
      // Strip Node's `ENOENT: no such file or directory, open '/x'`
      // prefix when present so the fallback at least looks like the
      // libc form. The leading `/, ` slice keeps the human-readable
      // phrase ("no such file or directory") if Node's message
      // mirrors the `strerror` text but lowercases it.
      const m = /^[A-Z]+: ([^,]+)/.exec(err.message);
      return m ? m[1] : err.message;
    }
  }
};

/**
 * Emit a file-open failure for `\g FILE`, `\o FILE`, `\w FILE` in the
 * exact shape vanilla psql produces: a bare `<path>: <strerror>` line
 * on stderr, no `\<cmd>:` prefix (matches `pg_log_error` under terse
 * mode, which is what `psql -X` uses).
 *
 * The leading `psql:[<file>:<n>]:` tag is still applied when we're
 * reading SQL from a `\i FILE` include — `psqlErrorPrefix` returns ''
 * for stdin so the line stays bare for the interactive / harness case.
 *
 * Returns an `error` envelope with `errorWritten: true` so the mainloop
 * doesn't write a duplicate `psql: ERROR:` fallback.
 */
const reportFileOpenFailure = (
  ctx: BackslashContext,
  target: string,
  err: unknown,
): BackslashResult => {
  const errno = err as NodeJS.ErrnoException;
  const phrase = errnoToStrerror(errno);
  const line = `${target}: ${phrase}`;
  ctx.settings.lastErrorResult = { message: line };
  const prefix = psqlErrorPrefix(ctx.settings);
  writeErr(`${prefix}${line}\n`);
  return { status: 'error', errorWritten: true };
};

/**
 * True when `err` was thrown by our synchronous `openSync` in
 * {@link openWriter} (i.e. has an errno `code`) and the caller should
 * render it via {@link reportFileOpenFailure} rather than the generic
 * `\<cmd>: <msg>` path.
 */
const isFileOpenFailure = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as NodeJS.ErrnoException;
  return typeof e.code === 'string' && e.code.startsWith('E');
};

/**
 * Format a child process exit code + signal into upstream psql's
 * `wait_result_to_str` style. Mirrors the C helper in
 * `src/common/wait_error.c`:
 *
 *   - exit code 127  → `command not found`
 *   - exit code 126  → `command was not executable`
 *   - any other code → `child process exited with exit code N`
 *   - terminated by signal S → `child process was terminated by
 *     signal N: <SIG>`
 *
 * Returns null when the child exited cleanly (code 0, no signal).
 */
const formatChildWaitResult = (
  exitCode: number | null | undefined,
  signal: NodeJS.Signals | null | undefined,
): string | null => {
  if (signal) {
    // Node doesn't expose the numeric signal number; surface the name as
    // upstream's `pg_strsignal` would, with a stable prefix.
    return `child process was terminated by signal: ${signal}`;
  }
  if (exitCode === null || exitCode === undefined) return null;
  if (exitCode === 0) return null;
  if (exitCode === 127) return 'command not found';
  if (exitCode === 126) return 'command was not executable';
  return `child process exited with exit code ${String(exitCode)}`;
};

/**
 * Compose the `CommandComplete`-tag line upstream prints for non-tuples-
 * producing results (DDL, DML without RETURNING, COPY). Mirrors
 * `formatCommandTag` in `core/common.ts` — duplicated to avoid the
 * cmd_io → common import cycle. Returns an empty string when no tag is
 * available (e.g. `EmptyQueryResponse` carries `command = ''`).
 */
const formatCommandTagText = (rs: ResultSet): string => {
  const command = (rs.command || '').trim();
  if (command.length === 0) return '';
  if (command === 'INSERT') {
    // INSERT is the only tag with the legacy oid in front of rowCount.
    return `INSERT ${String(rs.oid ?? 0)} ${String(rs.rowCount ?? 0)}`;
  }
  if (rs.rowCount !== null && rs.rowCount !== undefined) {
    return `${command} ${String(rs.rowCount)}`;
  }
  return command;
};

/**
 * Render a `ResultSet` to the supplied writable stream using the printer
 * picked from the active `\pset format`. Upstream's `do_watch`, `do_gset`,
 * `do_gexec`, and `\i` all funnel results through the standard query
 * output pipeline (`ExecQueryAndProcessResults` → `printQuery`), which
 * honours `\pset format`. Hard-coding the aligned printer here breaks the
 * conformance harness's `psql -A` runs (which expect unaligned tuples-only
 * output for things like `\watch` polled rows).
 *
 * Non-tuples-producing results (CommandComplete with `fields.length === 0`,
 * which covers DDL, DML without RETURNING, and the post-CopyDone tag for
 * `COPY ... TO STDOUT`) are rendered as a single status line instead of
 * the printer's `(0 rows)` empty-table block — matching `renderResultSets`
 * in `core/common.ts`. Tuples-only (`\t`) and quiet (`--quiet`) both
 * suppress the tag entirely.
 */
const renderResult = async (
  settings: PsqlSettings,
  rs: ResultSet,
  out: NodeJS.WritableStream,
): Promise<void> => {
  // `COPY ... TO STDOUT` segment — emit the accumulated CopyData payloads
  // in arrival order at this result's position in the `\;`-chain.
  if (rs.copyOutBytes && rs.copyOutBytes.length > 0) {
    for (const chunk of rs.copyOutBytes) {
      out.write(chunk);
    }
  }
  if (rs.fields.length === 0) {
    // Mirrors `renderResultSets`'s zero-fields branch: emit the tag (e.g.
    // `COPY 1`) unless quiet / tuples-only suppresses it. Without this
    // branch the aligned printer renders an empty header + `(0 rows)`
    // footer for the COPY-TO-STDOUT command complete, which doesn't
    // match upstream (where the data already streamed via the COPY-OUT
    // sink and the tag goes to the user's status stream, not the
    // queryFout). The regress fixture sets QUIET=true before the
    // COPY-OUT `\g` shape so the tag stays out of the file under test.
    // For COPY-out results, the tag is suppressed regardless — the bytes
    // already flowed; upstream's `handleCopyOut` doesn't emit `COPY N`
    // on the queryFout.
    if (!settings.popt.topt.tuplesOnly && !settings.quiet && !rs.copyOutBytes) {
      const tag = formatCommandTagText(rs);
      if (tag.length > 0) out.write(`${tag}\n`);
    }
    return;
  }
  await pickActivePrinter(settings).printQuery(rs, settings.popt, out);
};

/**
 * Pick the printer for the active output format. Mirrors `pickPrinter`
 * in `core/common.ts` — duplicated here to avoid the cmd_io → common
 * import cycle (common.ts depends on this file for `getQueryFout`).
 *
 * `wrapped` falls back to the aligned printer (which renders `wrapped`
 * mode itself via `topt.format`).
 */
const pickActivePrinter = (settings: PsqlSettings): Printer => {
  switch (settings.popt.topt.format) {
    case 'aligned':
    case 'wrapped':
      return alignedPrinter;
    case 'unaligned':
      return unalignedPrinter;
    case 'csv':
      return csvPrinter;
    case 'json':
      return jsonPrinter;
    case 'html':
      return htmlPrinter;
    case 'asciidoc':
      return asciidocPrinter;
    case 'latex':
      return latexPrinter;
    case 'latex-longtable':
      return latexLongtablePrinter;
    case 'troff-ms':
      return troffMsPrinter;
    default:
      return alignedPrinter;
  }
};

/**
 * Pick the output target for a query result.
 *
 * Precedence: explicit `oneShot` (e.g. `\g FILE`) > the settings stash
 * (`\o FILE`) > `process.stdout`.
 */
const pickOut = (
  settings: PsqlSettings,
  oneShot: NodeJS.WritableStream | null,
): NodeJS.WritableStream => {
  if (oneShot) return oneShot;
  return getQueryFout(settings) ?? process.stdout;
};

// ---------------------------------------------------------------------------
// \i FILE / \include FILE
// ---------------------------------------------------------------------------

const runInclude = async (
  ctx: BackslashContext,
  relative: boolean,
): Promise<BackslashResult> => {
  const arg = ctx.nextArg('normal');
  if (arg === null || arg.length === 0) {
    return errResult(ctx, 'missing required argument');
  }

  // Resolve path: \ir resolves relative to the current input file's
  // directory (if any); \i resolves relative to cwd unless absolute.
  let resolved: string;
  if (path.isAbsolute(arg)) {
    resolved = arg;
  } else if (relative && ctx.settings.inputfile) {
    resolved = path.resolve(path.dirname(ctx.settings.inputfile), arg);
  } else {
    resolved = path.resolve(process.cwd(), arg);
  }

  let contents: string;
  try {
    contents = await fsPromises.readFile(resolved, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errResult(ctx, msg);
  }

  // Execute the included file's SQL directly here. This is the single
  // execution path for BOTH the interactive REPL and the non-interactive
  // -c/-f/stdin path: the latter (`executeInputString`) does not drain the
  // `\i` input queue, so an `enqueueInput()` here would (a) never run under
  // -f/-c and (b) double-run interactively (the mainloop drains the queue
  // AND we run execSimple). See.
  if (!ctx.settings.db) {
    return errResult(ctx, 'no connection to the server');
  }

  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    return { status: 'ok' };
  }

  // Track the prior inputfile so `\ir` chains relative to the included
  // file's directory.
  const priorInputFile = ctx.settings.inputfile;
  ctx.settings.inputfile = resolved;
  try {
    const results = await ctx.settings.db.execSimple(trimmed);
    const out = pickOut(ctx.settings, null);
    for (const rs of results) {
      await renderResult(ctx.settings, rs, out);
    }
    return { status: 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errResult(ctx, msg);
  } finally {
    ctx.settings.inputfile = priorInputFile;
  }
};

export const cmdInclude: BackslashCmdSpec = {
  name: 'i',
  aliases: ['include'],
  helpKey: 'i',
  run: (ctx: BackslashContext): Promise<BackslashResult> =>
    runInclude(ctx, false),
};

export const cmdIncludeRel: BackslashCmdSpec = {
  name: 'ir',
  aliases: ['include_relative'],
  helpKey: 'ir',
  run: (ctx: BackslashContext): Promise<BackslashResult> =>
    runInclude(ctx, true),
};

// ---------------------------------------------------------------------------
// \o [FILE|cmd] / \out
// ---------------------------------------------------------------------------

export const cmdOut: BackslashCmdSpec = {
  name: 'o',
  aliases: ['out'],
  helpKey: 'o',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const arg = ctx.nextArg('filepipe');

    // Drain any previous target first so writes flush before we rebind.
    await closeQueryFout(ctx.settings);

    if (arg === null || arg.length === 0) {
      // Restore default (stdout).
      return { status: 'ok' };
    }

    try {
      const entry = openWriter(arg);
      setQueryFout(ctx.settings, entry);
      return { status: 'ok' };
    } catch (err) {
      // File targets fail synchronously in `openWriter` via `openSync`;
      // surface them in upstream's `<path>: <strerror>` shape (bare,
      // no `\o:` prefix) and continue with the loop so a follow-up
      // `SELECT` still executes. Pipe spawn failures (which lack an
      // errno code) fall through to the generic `\o: <msg>` path.
      if (!arg.startsWith('|') && isFileOpenFailure(err)) {
        return reportFileOpenFailure(ctx, arg, err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }
  },
};

// ---------------------------------------------------------------------------
// \w FILE / \write FILE
// ---------------------------------------------------------------------------

export const cmdWrite: BackslashCmdSpec = {
  name: 'w',
  aliases: ['write'],
  helpKey: 'w',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const arg = ctx.nextArg('filepipe');
    if (arg === null || arg.length === 0) {
      return errResult(ctx, 'missing required argument');
    }
    let entry: QueryFoutEntry;
    try {
      entry = openWriter(arg);
    } catch (err) {
      // Same upstream-shape pivot as `\o`: a missing / unwritable file
      // path errors out as a bare `<path>: <strerror>` line and the
      // shim keeps reading commands. Pipe spawn failures still use
      // the generic `\w: <msg>` envelope.
      if (!arg.startsWith('|') && isFileOpenFailure(err)) {
        return reportFileOpenFailure(ctx, arg, err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        entry.stream.write(ctx.queryBuf, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      // On pipe targets a fast-exiting child (e.g. `| false` or a
      // command-not-found shell exit) closes its stdin before we finish
      // writing, surfacing as EPIPE. Linux fires this reliably; macOS
      // sometimes races it past us. In either case the child's exit
      // status is what we want to report, NOT the write error — so we
      // swallow EPIPE on pipes and fall through to entry.close() which
      // awaits the child and emits the upstream-shape wait_result_to_str.
      const isEpipe =
        err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE';
      if (!entry.isPipe || !isEpipe) {
        try {
          await entry.close();
        } catch {
          // ignore
        }
        const msg = err instanceof Error ? err.message : String(err);
        return errResult(ctx, msg);
      }
    }
    // Wait for the target to drain. For pipe targets a non-zero exit /
    // killing signal is surfaced as `<fname>: <wait_result_to_str>`,
    // mirroring upstream `exec_command_write`:
    //
    //   pg_log_error("%s: %s", fname, wait_result_to_str(result));
    //
    // Note that upstream's `fname` retains the leading `|`, and the
    // message does NOT carry the `\w:` cmd-prefix that the other
    // backslash-command errors use — `pg_log_error` writes the bare
    // formatted message (under terse mode, which is the conformance
    // harness setup). We bypass `errResult` to match that shape exactly.
    try {
      const result = await entry.close();
      if (entry.isPipe) {
        const msg = formatChildWaitResult(result.exitCode, result.signal);
        if (msg !== null) {
          // `arg` still has the leading `|`; emit it verbatim so the
          // text reads `| program: child process exited with exit code 1`.
          const line = `${arg}: ${msg}`;
          ctx.settings.lastErrorResult = { message: line };
          const prefix = psqlErrorPrefix(ctx.settings);
          writeErr(`${prefix}${line}\n`);
          return { status: 'error', errorWritten: true };
        }
      }
      return { status: 'ok' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }
  },
};

// ---------------------------------------------------------------------------
// \g, \gx — execute the query buffer with optional one-shot redirect.
// ---------------------------------------------------------------------------

/**
 * Parse the body of a `\g (option=value option2=value2 ...)` clause —
 * the text between the outer parentheses, already stripped. Options
 * are separated by whitespace; values may be single-quoted to embed
 * spaces. Unquoted values run to the next whitespace.
 *
 * Mirrors upstream's `parse_slash_pgopts_list`. We deliberately stay
 * narrow — the conformance corpus exercises `format=`, `csv_fieldsep=`,
 * and `title=` only.
 */
const parseGPsetOptions = (
  body: string,
): { option: string; value: string }[] => {
  const out: { option: string; value: string }[] = [];
  let i = 0;
  while (i < body.length) {
    // Skip whitespace between pairs.
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    // Read option name up to `=`.
    const optStart = i;
    while (i < body.length && body[i] !== '=' && !/\s/.test(body[i])) i++;
    const option = body.slice(optStart, i);
    if (option.length === 0) break;
    let value = '';
    if (body[i] === '=') {
      i++; // skip '='
      // Value: single-quoted or unquoted.
      if (body[i] === "'") {
        i++;
        while (i < body.length && body[i] !== "'") {
          // Single-quoted strings support `''` doubling and a few
          // C-style escapes (\n, \t, \\, \'). Mirror enough of the
          // upstream `xslashquote` handling to round-trip the regress
          // corpus.
          if (body[i] === '\\' && i + 1 < body.length) {
            const next = body[i + 1];
            if (next === 'n') value += '\n';
            else if (next === 't') value += '\t';
            else if (next === 'r') value += '\r';
            else if (next === '\\') value += '\\';
            else if (next === "'") value += "'";
            else value += next;
            i += 2;
            continue;
          }
          value += body[i++];
        }
        if (body[i] === "'") i++;
      } else {
        const vStart = i;
        while (i < body.length && !/\s/.test(body[i])) i++;
        value = body.slice(vStart, i);
      }
    }
    out.push({ option, value });
  }
  return out;
};

const runGCore = async (
  ctx: BackslashContext,
  forceExpanded: boolean,
): Promise<BackslashResult> => {
  const gated = pipelineGate(ctx);
  if (gated !== null) return gated;
  // Strip leading whitespace + `--`/`/* */` comments so the SQL we hand to
  // the wire (and use for `LINE N:` re-print on error) matches what vanilla
  // psql sends through `PQexec`. Without the strip, queryBuf accumulated
  // across `\bind` re-entries carries blank+comment lines from the gap
  // between the previous `\g` and this one, and the server-relative
  // position lands on `LINE 3` instead of `LINE 1`.
  const trimmedBuf = stripLeadingCommentsAndWS(ctx.queryBuf);
  const bufSql = trimmedBuf.trim();
  let target: string | null;
  let psetOverrides: { option: string; value: string }[] | null = null;

  // `\g (option=value ...)` — temporary pset overrides for this query
  // only. Upstream `exec_command_g` recognises a leading `(` and slurps
  // the rest of the args until matching `)`. We can't call nextArg in
  // two different modes against the BackslashContext (each mode has its
  // own cursor), so when the leading char is `(`, parse the entire raw
  // arg block ourselves; otherwise fall back to normal filepipe arg
  // extraction.
  const rawTrimmed = ctx.rawArgs.trimStart();
  if (rawTrimmed.startsWith('(')) {
    const close = rawTrimmed.indexOf(')');
    if (close === -1) {
      return errResult(ctx, 'missing right parenthesis in \\g options');
    }
    // Strip parens; parse `key=value` pairs (values may be single-
    // quoted). The conformance corpus exercises `format=`,
    // `csv_fieldsep=`, and `title=` only.
    psetOverrides = parseGPsetOptions(rawTrimmed.slice(1, close).trim());
    // Anything after the matching `)` is the output target — `\g (format=csv)
    // out.txt` writes to out.txt. Previously this was dropped, so the file/pipe
    // redirect was silently ignored whenever options were present.
    const afterParen = rawTrimmed.slice(close + 1).trim();
    target = afterParen.length > 0 ? afterParen : null;
  } else {
    target = ctx.nextArg('filepipe');
  }

  // `\g` / `\gx` with an empty buffer re-runs the most recently submitted
  // query — upstream tracks this in `pset.last_query` and `PSQLexec` reads
  // it when the active buffer is empty. We mirror via `settings.lastQuery`,
  // populated in `sendQuery` before dispatch. Preserve trailing whitespace
  // on the re-run so the server's `position` (and the `LINE N:` echo we
  // render on failure) match upstream byte-for-byte — vanilla passes the
  // un-trimmed `pset.last_query` straight to `PQexec`.
  const sql = bufSql.length > 0 ? bufSql : ctx.settings.lastQuery;

  // If a `\bind_named NAME` has staged a server-side prepared statement
  // lookup, we don't need any SQL text — the prepared statement carries
  // it server-side. Skip the empty-sql guard so the bind branch below
  // can do its thing.
  const hasPendingNamedBind = stagedNamedBindPresent(ctx.settings);
  if (sql.length === 0 && !hasPendingNamedBind) {
    // No buffered SQL, no prior query, no staged bind — silent no-op
    // like upstream.
    return { status: 'reset-buf', newBuf: '' };
  }

  if (!ctx.settings.db) {
    return errResult(ctx, 'no connection to the server');
  }

  // Open the one-shot writer if a target was supplied; close it on the way
  // out so the file/pipe is flushed before we return.
  let oneShot: QueryFoutEntry | null = null;
  if (target !== null && target.length > 0) {
    try {
      oneShot = openWriter(target);
    } catch (err) {
      // A `\g FILE` whose path is unopenable (ENOENT, EACCES, EISDIR,
      // …) — typically because an unresolved `:VAR` substitution left
      // a literal `:VAR` in the path — must NOT crash the process the
      // way Node's lazy WriteStream `'error'` event would. Render in
      // upstream's bare `<path>: <strerror>` shape and continue so the
      // next command in the script still executes. Pipe spawn
      // failures retain the generic `\g: <msg>` envelope.
      if (!target.startsWith('|') && isFileOpenFailure(err)) {
        return reportFileOpenFailure(ctx, target, err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }
  }

  const topt = ctx.settings.popt.topt;
  // Snapshot topt BEFORE any per-query mutation so the restore in
  // `finally` covers both `\gx`'s `expanded = 'on'` and any `\g (...)`
  // pset overrides in one shot. Snapshotting AFTER the `forceExpanded`
  // mutation would persist `expanded = 'on'` across queries.
  const toptSnapshot = { ...topt };
  if (forceExpanded) topt.expanded = 'on';

  // Apply per-query pset overrides silently. Upstream applies the
  // temporary options without emitting the status lines that
  // interactive `\pset` would.
  if (psetOverrides) {
    for (const { option, value } of psetOverrides) {
      applyPset(topt, option, value, ctx.cmdName, true);
    }
  }

  // Track for `\g` / `\gx` re-run with empty buffer. Upstream sets
  // `pset.last_query` in `PSQLexec` before dispatch.
  ctx.settings.lastQuery = sql;

  // Consume any pending `\bind` / `\bind_named` state. Upstream's
  // `\g` routes through the extended-query protocol when bind params
  // are set: anonymous `\bind` re-prepares from the buffer; named
  // `\bind_named NAME` looks up the server-side prepared statement
  // by NAME (set earlier via `\parse NAME`) and just runs Bind +
  // Execute against it.
  const bindState = consumeBindState(ctx.settings);

  let execError: unknown = null;
  // Track whether we wired the mid-batch COPY-OUT sink so the `finally`
  // can clear it deterministically — even if `execSimple` threw.
  let copyOutSinkConn: {
    copyOutMidBatchSink?: ((chunk: Buffer) => void) | null;
  } | null = null;
  try {
    const out = pickOut(ctx.settings, oneShot?.stream ?? null);
    if (bindState?.byName) {
      // \bind_named NAME — execute the previously-prepared statement
      // identified by NAME. The cache was populated by `\parse NAME`.
      // The empty-string NAME is the upstream "unnamed" prepared
      // statement slot.
      const ps = lookupPrepared(ctx.settings, bindState.name);
      if (!ps) {
        // Synthesise a thrown-Error-like object so formatServerError can
        // render the same `ERROR:  <msg>` shape vanilla emits for the
        // server's `prepared statement "X" does not exist` error.
        execError = Object.assign(
          new Error(`prepared statement "${bindState.name}" does not exist`),
          { severity: 'ERROR', code: '26000' },
        );
      } else {
        // Bind + Execute MUST go in one extended-protocol batch: the
        // anonymous portal is implicitly closed at the next Sync, so a
        // separate ps.bind() then ps.execute() would lose the portal in
        // between. `bindAndExecute` issues both messages before the
        // Sync.
        const rs = await ps.bindAndExecute(bindState.values);
        await renderResult(ctx.settings, rs, out);
      }
    } else if (bindState) {
      // Anonymous \bind — re-prepare from the current buffer (or
      // lastQuery fallback) and execute with the supplied params.
      const rs = await ctx.settings.db.query(sql, bindState.values);
      await renderResult(ctx.settings, rs, out);
    } else {
      // Plain `\g` / `\gx`: simple-query dispatch.
      //
      // When the batch contains `COPY ... TO STDOUT`, the wire layer
      // forwards CopyData bytes via `copyOutMidBatchSink`. Mainloop wires
      // that sink to `ctx.stdout` for top-level dispatches; here in `\g`
      // we redirect it to the current output target (`\g FILE`,
      // `\g |cmd`, or `\o`-stashed stream when neither is set). Without
      // this, `COPY (SELECT 'foo') TO STDOUT \g :file` silently drops
      // `foo` on the floor and the file ends up with only the empty
      // `(0 rows)` shape printed by `renderResult` for the wire's empty
      // ResultSet. Matches upstream's `do_copy` / `handleCopyOut` path:
      // the COPY OUT bytes go wherever the active queryFout points.
      if (hasCopyToStdout(sql)) {
        copyOutSinkConn = ctx.settings.db as unknown as {
          copyOutMidBatchSink?: ((chunk: Buffer) => void) | null;
        };
        copyOutSinkConn.copyOutMidBatchSink = (chunk: Buffer): void => {
          out.write(chunk);
        };
      }
      const results = await ctx.settings.db.execSimple(sql);
      for (const rs of results) {
        await renderResult(ctx.settings, rs, out);
      }
    }
  } catch (err) {
    execError = err;
  } finally {
    // Restore the pre-query topt verbatim — covers both the `\gx`
    // `expanded = 'on'` swap and any `\g (...)` pset overrides, so a
    // subsequent plain `\g` runs in the user's persistent print mode.
    Object.assign(topt, toptSnapshot);
    // Tear down the COPY-OUT sink so subsequent top-level batches reach
    // mainloop's installer with a clean slate. (Mainloop reinstalls per
    // batch; leaving ours pointed at a now-closed file would cause a
    // write-after-close on the next CopyData burst.)
    if (copyOutSinkConn) copyOutSinkConn.copyOutMidBatchSink = null;
  }

  // Close the one-shot writer regardless of execution success so any
  // partial output is flushed.
  //
  // Note: a non-zero exit from `\g | program` is intentionally NOT
  // surfaced as an error. Upstream `CloseGOutput` (src/bin/psql/common.c)
  // only feeds the wait status to `SetShellResultVariables`, which sets
  // `SHELL_ERROR` / `SHELL_EXIT_CODE` for user inspection — no
  // `pg_log_error` call. This matches `\g | false` in vanilla psql:
  // silent, exit code 0, the next command (`\echo after`) prints
  // normally. Bookkeeping for the SHELL_* vars is a follow-up; what
  // matters here is that we don't emit a stray "program exited" line
  // that the conformance harness would diff against an empty upstream
  // stderr.
  //
  // The only failure we still surface from a pipe target is a synchronous
  // `close()` rejection (e.g. EPIPE escaping the swallow above), which
  // would indicate a genuine bug in our wiring rather than the child
  // program's exit code.
  let pipeError: string | null = null;
  if (oneShot) {
    try {
      await oneShot.close();
    } catch (err) {
      pipeError = err instanceof Error ? err.message : String(err);
    }
  }

  if (execError !== null) {
    // Render in upstream's `ERROR:  <msg>\nLINE N: ...\n        ^` shape
    // by funnelling through `formatServerError` — same path top-level
    // statement errors take in `core/common.ts::writeQueryError`. The
    // `\<cmd>:` prefix is reserved for client-side I/O / parse errors
    // (e.g. `\g: no connection`), not server-side ErrorResponse-shaped
    // failures. Pass the COMMENT-STRIPPED buffer (`trimmedBuf`) so the
    // `LINE N:` count starts at the first content line — vanilla strips
    // leading comments + blank lines from queryBuf before `PQexec`, and
    // the server's reported `position` is a 1-based offset into THAT
    // trimmed buffer. We preserve trailing whitespace so a `\g` after
    // `SELECT $1, $2 ` still renders `LINE 1: SELECT $1, $2 ` verbatim.
    // When buffer was empty (lastQuery fallback or named-bind path), the
    // dispatched SQL is `sql` — pass that instead so the `LINE N:` echo
    // still reflects the executed statement (e.g. `\bind_named NAME \g`
    // after a `\parse NAME` of `SELECT $1, $2`).
    return formatServerError(
      ctx,
      execError,
      bufSql.length > 0 ? trimmedBuf : sql,
    );
  }
  if (pipeError !== null) {
    return errResult(ctx, pipeError);
  }
  return { status: 'reset-buf', newBuf: '' };
};

export const cmdG: BackslashCmdSpec = {
  name: 'g',
  helpKey: 'g',
  run: (ctx: BackslashContext): Promise<BackslashResult> =>
    runGCore(ctx, false),
};

export const cmdGx: BackslashCmdSpec = {
  name: 'gx',
  helpKey: 'gx',
  run: (ctx: BackslashContext): Promise<BackslashResult> => runGCore(ctx, true),
};

// ---------------------------------------------------------------------------
// \p / \print — print the current or previous query buffer.
// ---------------------------------------------------------------------------

/**
 * `\p` / `\print` — print the query buffer the next `\g` would execute.
 *
 * Mirrors upstream `exec_command_print` in `src/bin/psql/command.c`:
 *
 *   if (query_buf && query_buf->len > 0)
 *     puts(query_buf->data);
 *   else if (previous_buf && previous_buf->len > 0)
 *     puts(previous_buf->data);
 *   else if (!pset.quiet)
 *     puts(_("Query buffer is empty."));
 *
 * Buffer-vs-previous-buffer precedence matters for the regress sequence:
 *
 *     SELECT 1;       -- executes, previous_buf := "SELECT 1;"
 *     \p              -- queryBuf empty → prints previous_buf
 *     SELECT 2 \r     -- queryBuf="SELECT 2 ", \r resets to "" without
 *                     -- touching previous_buf
 *     \p              -- queryBuf still empty → prints previous_buf
 *     SELECT 3 \p     -- queryBuf="SELECT 3 ", non-empty → prints queryBuf
 *
 * Implementation notes:
 *
 *  - We use `settings.lastQuery` as the previous-buffer source. Upstream
 *    tracks `previous_buf` independently of `pset.last_query`, but our
 *    `lastQuery` is set at the exact same point upstream sets
 *    `previous_buf` (the dispatch site in `SendQuery`-equivalent code paths
 *    in `core/common.ts` and `cmd_io.ts`'s `\g` implementation), so the
 *    semantics match for every shape exercised by the conformance corpus.
 *  - We must NOT clear queryBuf — return `status: 'ok'` so the mainloop
 *    leaves the buffer untouched. The user is inspecting, not executing.
 *  - `puts()` appends a trailing newline. We use `writeOut` and append `\n`
 *    explicitly to match.
 */
export const cmdPrint: BackslashCmdSpec = {
  name: 'p',
  aliases: ['print'],
  helpKey: 'p',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    // `queryBuf.trim()` for the emptiness check — not the printed text.
    // Upstream's `query_buf->len > 0` is a byte-length check that, in
    // upstream, is reliably zero after a `;`-dispatch (because PQexec is
    // followed by `resetPQExpBuffer(query_buf)`). Our mainloop leaves a
    // residual `\n` in queryBuf after a top-level dispatch when the next
    // source line starts with a slash command — so a raw `length > 0`
    // check here would route to the "print the buffer" arm and emit
    // `\n\n` instead of falling through to `lastQuery`. The trim-only
    // emptiness check is purely an empty-vs-content discriminator; the
    // actual writeOut still uses the un-trimmed buffer text so an inline
    // `SELECT 3 \p` correctly emits the trailing space upstream prints.
    if (ctx.queryBuf.trim().length > 0) {
      writeOut(`${ctx.queryBuf}\n`);
    } else if (ctx.settings.lastQuery.length > 0) {
      writeOut(`${ctx.settings.lastQuery}\n`);
    } else if (!ctx.settings.quiet) {
      writeOut('Query buffer is empty.\n');
    }
    return Promise.resolve({ status: 'ok' });
  },
};

// ---------------------------------------------------------------------------
// \gset [PREFIX]
// ---------------------------------------------------------------------------

const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  // Plain objects / arrays from JSON columns: JSON-stringify so the test
  // surface is deterministic and avoids "[object Object]".
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

export const cmdGset: BackslashCmdSpec = {
  name: 'gset',
  helpKey: 'gset',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const gated = pipelineGate(ctx);
    if (gated !== null) return gated;
    // Strip leading whitespace + comments — see runGCore for the rationale.
    const trimmedBuf = stripLeadingCommentsAndWS(ctx.queryBuf);
    const bufSql = trimmedBuf.trim();
    const prefix = ctx.nextArg('normal') ?? '';

    // Empty buffer behaviour mirrors upstream `exec_command_gset`'s
    // `PSQL_CMD_SEND` return: the dispatch loop sends the active
    // `pset.last_query` (or nothing). Upstream does NOT emit an error
    // — it's a silent no-op when there's no buffer AND no prior query.
    // We mirror via `settings.lastQuery`, populated in `sendQuery` before
    // dispatch.
    const sql = bufSql.length > 0 ? bufSql : ctx.settings.lastQuery.trim();
    if (sql.length === 0) {
      return { status: 'reset-buf', newBuf: '' };
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }

    // Track for a subsequent `\g` re-run with empty buffer. Upstream
    // `exec_command_gset` updates `pset.last_query` to the dispatched SQL
    // before sending, so a follow-on `\g` (with the buffer reset by the
    // implicit `\\` separator in `... \gset pref01_ \\ \g`) re-executes
    // this same statement and prints the result table.
    ctx.settings.lastQuery = sql;

    let results: ResultSet[];
    try {
      results = await ctx.settings.db.execSimple(sql);
    } catch (err) {
      // Server-side ErrorResponse — render in upstream's 3-line shape
      // (severity + message + LINE N / caret) instead of `\gset: <msg>`.
      // Pass the comment-stripped buffer so the `LINE N:` count matches
      // vanilla. When the buffer was empty, fall back to the re-run SQL
      // — the user wants to see WHICH statement failed.
      return formatServerError(ctx, err, bufSql.length > 0 ? trimmedBuf : sql);
    }

    // `\;`-chained batches: render every result EXCEPT the last to the
    // active output before `\gset` captures the last. Upstream's
    // `ExecQueryAndProcessResults` walks the libpq result list and runs
    // `PrintQueryResults` on each one in order; the trailing `\gset`
    // applies to the FINAL result (`StoreQueryTuple` in common.c) and
    // suppresses its print. Without this loop, a script like
    // `SELECT 3 AS three \; SELECT warn('3.5') \; SELECT 4 AS four \gset`
    // would silently drop the `three` table + the warn NOTICE's
    // surrounding tuples row.
    if (results.length > 1) {
      const out = pickOut(ctx.settings, null);
      for (let i = 0; i < results.length - 1; i++) {
        await renderResult(ctx.settings, results[i], out);
      }
    }
    // Use the last result that returned rows. Upstream uses the most-recent
    // tuples-producing statement; results without a row descriptor (e.g.
    // pure DDL) are skipped.
    // Upstream `StoreQueryTuple` only runs against the LAST PGresult and
    // only when that result is `PGRES_TUPLES_OK` (a tuples-producing
    // statement). Non-tuples results (DDL, INSERT/UPDATE without RETURNING)
    // fall through to a plain status print — `\gset` is a no-op there, NOT
    // an error. Mirror that here: pick the last result; if it isn't
    // tuples-producing, skip the variable-assignment step entirely.
    const lastRs = results[results.length - 1];
    if (!lastRs || lastRs.fields.length === 0) {
      return { status: 'reset-buf', newBuf: '' };
    }
    const rs = lastRs;
    if (rs.rows.length === 0) {
      // Bare `no rows returned for \gset` (no `\gset:` prefix) — matches
      // upstream psql's `pg_log_error("no rows returned for \\gset")`.
      ctx.settings.lastErrorResult = {
        message: 'no rows returned for \\gset',
      };
      const errPrefix = psqlErrorPrefix(ctx.settings);
      writeErr(`${errPrefix}no rows returned for \\gset\n`);
      return { status: 'error', errorWritten: true };
    }
    if (rs.rows.length > 1) {
      // Match upstream psql's exact wording from `exec_command_gset` —
      // bare `more than one row returned for \gset` (no `\gset:` prefix).
      // Verified against vanilla psql; vendored psql.out emits it bare.
      ctx.settings.lastErrorResult = {
        message: 'more than one row returned for \\gset',
      };
      const errPrefix = psqlErrorPrefix(ctx.settings);
      writeErr(`${errPrefix}more than one row returned for \\gset\n`);
      return { status: 'error', errorWritten: true };
    }
    const row = rs.rows[0];
    for (let i = 0; i < rs.fields.length; i++) {
      const fieldName = rs.fields[i].name;
      const name = `${prefix}${fieldName}`;
      const cell = row[i];
      const isNull = cell === null || cell === undefined;
      // Upstream skips assignments where the target maps to a "specially
      // treated" variable (one with a substitute / assign hook installed)
      // whose value would be rejected by the hook. The non-special columns
      // continue to be assigned: only the offending one is skipped, with
      // an informational stderr line. See psql.out line ~240:
      //   attempt to \gset into specially treated variable "IGNOREEOF" ignored
      if (isSpeciallyTreatedVar(ctx.settings, name)) {
        // The target maps to a "specially treated" variable (one with a
        // substitute / assign hook installed). Upstream skips just this
        // assignment with an informational stderr line; other columns
        // are still processed. We don't actually call the hook — even a
        // value that the hook would accept must be rejected per upstream:
        // see `exec_command_gset` and `VariableHasHook`.
        const errPrefix = psqlErrorPrefix(ctx.settings);
        writeErr(
          `${errPrefix}attempt to \\gset into specially treated variable ` +
            `"${name}" ignored\n`,
        );
        continue;
      }
      // Upstream `StoreQueryTuple` in src/bin/psql/common.c:
      //
      //   if (PQgetisnull(result, 0, i))
      //       UnsetVariable(pset.vars, varname);
      //   else if (!SetVariable(pset.vars, varname, PQgetvalue(...))) { ... }
      //
      // i.e. a NULL cell unsets the target variable (so a subsequent
      // `:var` interpolates to the literal `:var` via the scanner's
      // unset-var passthrough) rather than setting it to the empty
      // string. Mirror that semantics here.
      if (isNull) {
        ctx.settings.vars.unset(name);
        continue;
      }
      const value = formatCell(cell);
      if (!ctx.settings.vars.set(name, value)) {
        // Bare `invalid variable name: "<name>"` (no `\gset:` prefix) —
        // matches upstream psql.out wording for `\gset` exactly.
        ctx.settings.lastErrorResult = {
          message: `invalid variable name: "${fieldName}"`,
        };
        const errPrefix = psqlErrorPrefix(ctx.settings);
        writeErr(`${errPrefix}invalid variable name: "${fieldName}"\n`);
        return { status: 'error', errorWritten: true };
      }
    }
    return { status: 'reset-buf', newBuf: '' };
  },
};

// ---------------------------------------------------------------------------
// \gdesc — describe the current query without executing it.
//
// Mirrors upstream `exec_command_gdesc` in `src/bin/psql/command.c`: parse
// the buffered query through the extended protocol (Parse + Describe by
// statement, no Execute), then build a synthetic two-column ResultSet of
// `Column` and `Type` rows and route it through the printer the user's
// `\pset format` selected. Tuples-only mode (`\t on`) suppresses the
// header / `(N columns)` footer the same way it would for a real query
// result, because we hand the synthetic ResultSet to the same printer.
//
// Type names come from a follow-up `SELECT ... format_type(tp, tpm)`
// over a VALUES literal — exactly the round-trip upstream uses so
// non-builtin types and typmod modifiers (`numeric(10,2)`, `varchar(64)`)
// render with their canonical form.
// ---------------------------------------------------------------------------

/**
 * Build the SQL that resolves each describe-result column's `Type` via
 * `pg_catalog.format_type(typoid, typmod)`. We feed the names + OIDs
 * + typmods through a `VALUES` literal so the server does the formatting
 * for us — the same query upstream issues from `describeFieldsByType`.
 *
 * Returns null when there are zero fields (caller emits `(0 rows)` form
 * by hand because PostgreSQL rejects an empty VALUES list).
 */
const buildGdescFormatQuery = (fields: FieldDescription[]): string | null => {
  if (fields.length === 0) return null;
  // Each row literal escapes the column name with the standard E'' string
  // form so embedded quotes survive the round trip. The pg_type catalogue
  // expects oid + int4 typmod, so we cast accordingly. `_idx` keeps the
  // VALUES list in insertion order; `format_type` handles -1 typmod
  // (== "no modifier") natively.
  const rows = fields
    .map((f, i) => {
      const safeName = f.name.replace(/'/gu, "''");
      const oid = String(f.dataTypeID >>> 0);
      const typmod = String(f.dataTypeModifier | 0);
      return `(${String(i)}, '${safeName}', ${oid}::oid, ${typmod}::int4)`;
    })
    .join(', ');
  // ORDER BY _idx preserves the describe order regardless of how the server
  // happens to evaluate the VALUES list. Aliases match upstream column
  // titles exactly so the printer header is identical.
  return (
    'SELECT name AS "Column", pg_catalog.format_type(tp, tpm) AS "Type"' +
    ` FROM (VALUES ${rows}) AS x(_idx, name, tp, tpm) ORDER BY _idx`
  );
};

/**
 * Field descriptors for the synthetic `Column / Type` ResultSet that
 * `\gdesc` emits when format_type resolution fails or yields nothing.
 *
 * We fall back to the field's raw OID so the user still sees a value.
 */
const GDESC_SYNTHETIC_FIELDS: FieldDescription[] = [
  {
    name: 'Column',
    tableID: 0,
    columnID: 0,
    dataTypeID: 25, // text
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: 0,
  },
  {
    name: 'Type',
    tableID: 0,
    columnID: 0,
    dataTypeID: 25, // text
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: 0,
  },
];

const buildSyntheticGdescResultSet = (rows: unknown[][]): ResultSet => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: null,
  fields: GDESC_SYNTHETIC_FIELDS,
  rows,
  notices: [],
});

export const cmdGdesc: BackslashCmdSpec = {
  name: 'gdesc',
  helpKey: 'gdesc',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const gated = pipelineGate(ctx);
    if (gated !== null) return gated;
    // Strip leading whitespace + comments — see runGCore for the rationale.
    const trimmedBuf = stripLeadingCommentsAndWS(ctx.queryBuf);
    const sql = trimmedBuf.trim();
    if (sql.length === 0) {
      // Upstream `\gdesc` with no buffer falls through `PSQL_CMD_SEND` to
      // the printer which renders the synthetic 0-column result via
      // `PrintQueryStatus`'s "The command has no result, or the result
      // has no columns." line. Stdout, exit 0 — not an error. Verified
      // against vanilla psql 18.
      process.stdout.write(
        'The command has no result, or the result has no columns.\n',
      );
      // Match upstream's post-PSQL_CMD_SEND state vars: success, 0 rows.
      refreshErrorVars(ctx.settings, { kind: 'success', rowCount: 0 });
      return { status: 'reset-buf', newBuf: '' };
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }
    // Track for a subsequent `\g` re-run with empty buffer. Upstream
    // `exec_command_gdesc` updates `pset.last_query` to the dispatched SQL
    // before sending, so a follow-on `\g` (with the buffer reset because
    // `\gdesc` dispatches via PSQL_CMD_SEND) re-executes this same statement
    // and prints the result table. Without this, the regress sequence
    //   SELECT 1 AS x, ... \gdesc
    //   \g
    // would silently drop the `\g` (empty buffer + stale lastQuery), and
    // any later `TABLE bububu;` failure would taint `\g`'s re-run output.
    ctx.settings.lastQuery = sql;
    let fields: FieldDescription[];
    try {
      const stmt = await ctx.settings.db.prepare('', sql);
      fields = await stmt.describe();
      // Close the unnamed prepared statement so we don't leak it. Failure
      // to close (e.g. server already in error state) is non-fatal.
      try {
        await stmt.close();
      } catch {
        // ignore
      }
    } catch (err) {
      // Capture + render the full ErrorResponse-shaped payload in upstream's
      // 3-line shape (severity + message + LINE N / caret), refresh the
      // diagnostic vars, and signal `errorWritten` to the mainloop so the
      // `\errverbose` re-render after `\gdesc` sees the rich layers. Pass
      // the comment-stripped buffer so the `LINE N:` count starts at the
      // first content line (matches vanilla — see runGCore).
      return formatServerError(ctx, err, trimmedBuf);
    }

    // When the prepared statement describes back zero columns (DDL, empty
    // SELECT list, etc.), upstream `exec_command_gdesc` prints the
    // pg_log_info "The command has no result, or the result has no
    // columns." line to stdout and skips the synthetic-table render.
    // Verified against vanilla psql 18: `SELECT \gdesc` and
    // `CREATE TABLE bububu(a int) \gdesc` both produce that text.
    if (fields.length === 0) {
      process.stdout.write(
        'The command has no result, or the result has no columns.\n',
      );
      // Match upstream's post-PSQL_CMD_SEND state vars: success, 0 rows.
      refreshErrorVars(ctx.settings, { kind: 'success', rowCount: 0 });
      return { status: 'reset-buf', newBuf: '' };
    }

    // Resolve canonical type names via a follow-up round trip when we have
    // at least one field. On failure (or when the server returns nothing —
    // a mock or an unusual connection state) fall back to the raw OID so
    // the user still sees a row per described column.
    let rows: unknown[][];
    const formatQuery = buildGdescFormatQuery(fields);
    if (formatQuery === null) {
      rows = [];
    } else {
      const fallbackRows = (): unknown[][] =>
        fields.map((f) => [f.name, String(f.dataTypeID)]);
      try {
        const sets = await ctx.settings.db.execSimple(formatQuery);
        const last = sets[sets.length - 1];
        rows = last && last.rows.length > 0 ? last.rows : fallbackRows();
      } catch {
        rows = fallbackRows();
      }
    }

    const rs = buildSyntheticGdescResultSet(rows);
    const printer = pickActivePrinter(ctx.settings);
    const out = pickOut(ctx.settings, null);
    try {
      await printer.printQuery(rs, ctx.settings.popt, out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }
    // Refresh state vars to mark the describe success: `:ERROR=false`,
    // `:SQLSTATE=00000`, `:ROW_COUNT=<#-described-columns>`. Upstream
    // routes `\gdesc` through `PSQL_CMD_SEND` so its post-dispatch
    // `SetResultVariables` sees the synthetic 2-column tuple result and
    // assigns ROW_COUNT to the field count we just rendered.
    refreshErrorVars(ctx.settings, {
      kind: 'success',
      rowCount: rs.rowCount,
    });
    return { status: 'reset-buf', newBuf: '' };
  },
};

// ---------------------------------------------------------------------------
// \gexec — treat each cell of the result as SQL to execute.
// ---------------------------------------------------------------------------

export const cmdGexec: BackslashCmdSpec = {
  name: 'gexec',
  helpKey: 'gexec',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const gated = pipelineGate(ctx);
    if (gated !== null) return gated;
    // Strip leading whitespace + comments — see runGCore for the rationale.
    const trimmedBuf = stripLeadingCommentsAndWS(ctx.queryBuf);
    const bufSql = trimmedBuf.trim();
    // Upstream `\gexec` with no buffer falls through `PSQL_CMD_SEND` and
    // re-runs `pset.last_query` (or nothing). Silent on empty + no prior
    // query — exit 0, no message. Verified against vanilla psql 18.
    const sql = bufSql.length > 0 ? bufSql : ctx.settings.lastQuery.trim();
    if (sql.length === 0) {
      return { status: 'reset-buf', newBuf: '' };
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }

    // Track the outer (meta) query for a subsequent `\g` re-run with an empty
    // buffer. Upstream `exec_command_gexec` runs through PSQL_CMD_SEND, which
    // bumps `pset.last_query` before dispatch.
    ctx.settings.lastQuery = sql;

    let firstPass: ResultSet[];
    try {
      firstPass = await ctx.settings.db.execSimple(sql);
    } catch (err) {
      // Render the first-pass server error in upstream's 3-line shape.
      // Pass the comment-stripped buffer so the `LINE N:` count matches
      // vanilla — see runGCore for the rationale.
      return formatServerError(ctx, err, trimmedBuf);
    }

    const tupled = firstPass.filter((r) => r.fields.length > 0);
    if (tupled.length === 0) {
      return { status: 'reset-buf', newBuf: '' };
    }

    const out = pickOut(ctx.settings, null);
    // Echo each generated SQL when ECHO is `all` or `queries`. Vanilla
    // `exec_command_gexec` calls `SendQuery` for each row's text, and
    // SendQuery itself prints the statement via the standard query-echo
    // path: stdout, no `\gexec:` / `psql:` prefix, trailing LF. The echo
    // appears BEFORE the result body so the conformance harness sees
    // the same interleaving vanilla produces.
    const echo = ctx.settings.echo;
    const shouldEcho = echo === 'all' || echo === 'queries';
    // Per-row errors are tolerated: upstream `\gexec` calls
    // `SendQuery` in a loop and ignores its return value (the only
    // escape is the global ON_ERROR_STOP variable, which the
    // conformance harness sets to 0). Without this, the regress
    // expects `drop table gexec_test\nERROR: ...\nselect ...` and we'd
    // truncate at the ERROR.
    let sawError = false;
    for (const rs of tupled) {
      for (const row of rs.rows) {
        for (const cell of row) {
          if (cell === null || cell === undefined) continue;
          const statement = formatCell(cell).trim();
          if (statement.length === 0) continue;
          if (shouldEcho) {
            out.write(statement + '\n');
          }
          try {
            const nested = await ctx.settings.db.execSimple(statement);
            for (const sub of nested) {
              if (sub.fields.length > 0) {
                await renderResult(ctx.settings, sub, out);
              }
            }
          } catch (err) {
            // Each iteration is its own statement; render the per-row
            // server error in upstream's 3-line shape (LINE / caret are
            // positioned against `statement`, the offending row text)
            // but DO NOT return — vanilla continues to the next row.
            formatServerError(ctx, err, statement);
            sawError = true;
            // Honour ON_ERROR_STOP: when set, halt the loop after the
            // first failing row. Upstream's `do_gexec` consults the
            // global `pset.on_error_stop` flag via `SendQuery`'s
            // return; we mirror by checking the setting directly.
            if (ctx.settings.onErrorStop) {
              return { status: 'error', errorWritten: true };
            }
          }
        }
      }
    }
    // Even with errors, return `reset-buf` so the mainloop clears the
    // outer `\gexec` buffer. Per-row error rendering already happened;
    // returning `error` here would re-trigger the writeError path.
    void sawError;
    return { status: 'reset-buf', newBuf: '' };
  },
};

// ---------------------------------------------------------------------------
// \watch [args...]
//
// Upstream `\watch` accepts:
//
//   \watch [SEC]              — legacy positional interval (seconds)
//   \watch i=SEC              — interval as named flag
//   \watch c=N                — iteration count limit
//   \watch m=N                — minimum row count: keep polling until the
//                               result has >= N rows; uses `interval` as the
//                               sleep between polls
//   \watch min_rows=N         — long-form alias of `m=`
//
// Flags may be combined in any order. Duplicates (including the positional
// interval colliding with `i=`) are rejected upstream with the message
// "<thing> is specified more than once".
//
// The `WATCH_INTERVAL` psql variable supplies the default `interval` value
// when `i=` is not given (and when there is no positional). The variable is
// validated at `\set` time via a hook installed by `defaultSettings`.
// ---------------------------------------------------------------------------

const sleepCancellable = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort);
  });

/**
 * Strictly parse a non-negative finite float.
 *
 * Returns the parsed number, or `null` for any of:
 *   - empty string
 *   - non-numeric trailing characters (e.g. `10ab`)
 *   - negative values (e.g. `-10`)
 *   - out-of-range / non-finite results (e.g. `10e400` → Infinity)
 *
 * Used to validate `\watch` intervals and the `WATCH_INTERVAL` variable.
 */
const parseStrictNonNegativeFloat = (raw: string): number | null => {
  if (raw.length === 0) return null;
  // Reject anything that doesn't look like a plain float literal. We
  // accept optional sign + digits + optional fractional + optional
  // exponent. Trailing garbage (`10ab`), negative values, and exponents
  // that overflow to Infinity all funnel into the null result.
  const re = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
  if (!re.test(raw)) return null;
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
};

/**
 * Parse a strict non-negative integer (no exponent, no fractional).
 * Used for `c=` and `m=` / `min_rows=` argument values.
 */
const parseStrictNonNegativeInt = (raw: string): number | null => {
  if (raw.length === 0) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  return value;
};

/**
 * Default `\watch` interval (seconds). Mirrors upstream
 * `DEFAULT_WATCH_INTERVAL`. Exported so `defaultSettings` can substitute
 * it when the user unsets the `WATCH_INTERVAL` variable — upstream's
 * `watch_interval_substitute_hook` reseeds the value to `2` on null.
 */
export const DEFAULT_WATCH_INTERVAL = '2';

/**
 * Render `\watch`'s per-iteration timestamp in upstream psql's
 * `ctime`-style layout: `Day Mon DD HH:MM:SS YYYY` (e.g. `Mon May 25
 * 19:41:55 2026`). Upstream calls `strftime("%c", &tm)` with the C locale;
 * we reproduce the field order in vanilla English so the output matches
 * regardless of the host locale.
 *
 * Exported only for unit-testing the format ladder.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const pad2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

export const formatWatchTimestamp = (now: Date): string => {
  const weekday = WEEKDAYS[now.getDay()];
  const month = MONTHS[now.getMonth()];
  const day = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const mm = pad2(now.getMinutes());
  const ss = pad2(now.getSeconds());
  const year = String(now.getFullYear());
  return `${weekday} ${month} ${day} ${hh}:${mm}:${ss} ${year}`;
};

/**
 * Upper bound on the `WATCH_INTERVAL` variable and the positional interval
 * — matches upstream which rejects "out of range" values. Upstream uses
 * `strtod` and rejects ±Infinity; we tighten further so a single watch loop
 * cannot sleep for longer than ~100 hours, which catches obvious typos
 * without breaking legitimate slow polls.
 */
const WATCH_INTERVAL_MAX_SECONDS = 100 * 3600;

/**
 * Resolve the effective default `\watch` interval from the `WATCH_INTERVAL`
 * psql variable. Returns the parsed value, the documented default
 * (`DEFAULT_WATCH_INTERVAL`), or an `error` envelope if the variable is set
 * but parses out of range.
 */
const resolveWatchIntervalDefault = (
  settings: PsqlSettings,
): { value: number } | { error: string } => {
  // The variable is seeded to `DEFAULT_WATCH_INTERVAL` by `defaultSettings`
  // (and re-seeded on `\unset`), so it's typically a string at use time.
  // If a future code path leaves it undefined we fall back to the same
  // documented default — upstream's `ParseVariableDouble` substitutes
  // `DEFAULT_WATCH_INTERVAL` when the var slot is empty.
  const raw = settings.vars.get('WATCH_INTERVAL') ?? DEFAULT_WATCH_INTERVAL;
  const parsed = parseStrictNonNegativeFloat(raw);
  if (parsed === null || parsed > WATCH_INTERVAL_MAX_SECONDS) {
    return {
      error: `WATCH_INTERVAL "${raw}" is out of range`,
    };
  }
  return { value: parsed };
};

/**
 * Pager handle returned by {@link openWatchPager}.
 */
type WatchPagerHandle = {
  stream: NodeJS.WritableStream;
  close: () => Promise<void>;
};

/**
 * Spawn the `\watch` pager for the full duration of the polling loop.
 *
 * Upstream `do_watch` wraps the loop in a single `popen` of
 * `PSQL_WATCH_PAGER`. It deliberately ignores `PSQL_PAGER` and `$PAGER`:
 *
 *   > we ignore the regular PSQL_PAGER or PAGER environment variables,
 *   > because traditional pagers probably won't be very useful for
 *   > showing a stream of results.
 *
 * Mirror that here. Reading from `$PAGER` would silently hijack
 * `\watch` output for any user whose shell sets `PAGER=less` (the
 * common default), which makes the loop's output disappear into a
 * subprocess that diff harnesses can't capture.
 *
 * We use a single `sh -c <pager>` spawn so the user can set the
 * variable to a full command string (`less -R`, `tee /tmp/log`, …)
 * without the caller having to tokenise it. EPIPE on the stdin pipe is
 * swallowed for the same reason as in `openWriter`: the user may quit
 * `less` while we still have writes pending in the next iteration.
 *
 * Returns `null` when `PSQL_WATCH_PAGER` is unset or whitespace-only
 * (upstream's "no pager" rule), so the caller falls back to the normal
 * output target.
 */
const openWatchPager = (): WatchPagerHandle | null => {
  const cmd = process.env.PSQL_WATCH_PAGER ?? '';
  if (cmd.trim().length === 0) return null;

  const child = spawn('sh', ['-c', cmd], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') {
      throw err;
    }
  });
  return {
    stream: child.stdin,
    close: () =>
      new Promise<void>((resolve) => {
        // If the pager already exited (e.g. PSQL_WATCH_PAGER=false, or the
        // user quit it) the 'close'/'error' events have ALREADY fired, so a
        // freshly-registered `once()` listener would never run and close()
        // would hang forever — taking `\watch` with it.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once('close', finish);
        child.once('error', finish);
        if (!child.stdin.destroyed) {
          try {
            child.stdin.end();
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code !== 'EPIPE') finish();
          }
        }
      }),
  };
};

export const cmdWatch: BackslashCmdSpec = {
  name: 'watch',
  helpKey: 'watch',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const gated = pipelineGate(ctx);
    if (gated !== null) return gated;
    // Strip leading whitespace + comments — see runGCore for the rationale.
    const trimmedBuf = stripLeadingCommentsAndWS(ctx.queryBuf);
    const sql = trimmedBuf.trim();
    if (sql.length === 0) {
      return errResult(ctx, 'no query buffer');
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }

    // Track which options have been seen so we can reject duplicates with
    // the upstream-formatted "<thing> is specified more than once" message.
    let intervalSet = false;
    let interval: number | null = null;
    let iterSet = false;
    let iterMax = 0; // 0 = unlimited (matches upstream's "no -c").
    let minRowsSet = false;
    let minRows = 0;
    let positionalSeen = false;

    // Drain all args. Each is either a `key=value` token or a bare
    // positional (only allowed as the very first arg, and only once).
    while (true) {
      const arg = ctx.nextArg('normal');
      if (arg === null) break;
      if (arg.length === 0) continue;

      // Identify named flags by looking for `=`. Upstream tolerates an
      // empty value (treats it as the option not being provided), but we
      // mirror its stricter behaviour for the values we care about.
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const key = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);

        if (key === 'i') {
          if (intervalSet) {
            return errResult(ctx, 'interval value is specified more than once');
          }
          const parsed = parseStrictNonNegativeFloat(value);
          if (parsed === null || parsed > WATCH_INTERVAL_MAX_SECONDS) {
            return errResult(ctx, `incorrect interval value "${value}"`);
          }
          interval = parsed;
          intervalSet = true;
          continue;
        }

        if (key === 'c') {
          if (iterSet) {
            return errResult(
              ctx,
              'iteration count is specified more than once',
            );
          }
          const parsed = parseStrictNonNegativeInt(value);
          // Upstream parses the count with `option_parse_int(..., 1, INT_MAX)`
          // so the iteration count must be >= 1; `c=0` is rejected as out of
          // range. We reserve the internal `iterMax = 0` sentinel purely for
          // "no `c=` given" (unlimited continuous mode), so accepting `c=0`
          // here would silently cap the loop at a single iteration instead.
          if (parsed === null || parsed === 0) {
            return errResult(ctx, `incorrect iteration count "${value}"`);
          }
          iterMax = parsed;
          iterSet = true;
          continue;
        }

        if (key === 'm' || key === 'min_rows') {
          if (minRowsSet) {
            return errResult(ctx, 'minimum row count specified more than once');
          }
          const parsed = parseStrictNonNegativeInt(value);
          if (parsed === null) {
            return errResult(ctx, `incorrect minimum row count "${value}"`);
          }
          minRows = parsed;
          minRowsSet = true;
          continue;
        }

        // Unknown key=value: surface a generic error mirroring upstream
        // ("unrecognized value …").
        return errResult(ctx, `unrecognized option "${key}"`);
      }

      // Positional argument — legacy interval. Allowed only once, and
      // only collides with `i=` under the same upstream "specified more
      // than once" rubric.
      if (positionalSeen || intervalSet) {
        return errResult(ctx, 'interval value is specified more than once');
      }
      const parsed = parseStrictNonNegativeFloat(arg);
      if (parsed === null || parsed > WATCH_INTERVAL_MAX_SECONDS) {
        return errResult(ctx, `incorrect interval value "${arg}"`);
      }
      interval = parsed;
      intervalSet = true;
      positionalSeen = true;
    }

    // If no explicit interval was supplied, fall back to WATCH_INTERVAL.
    if (interval === null) {
      const resolved = resolveWatchIntervalDefault(ctx.settings);
      if ('error' in resolved) {
        return errResult(ctx, resolved.error);
      }
      interval = resolved.value;
    }
    const intervalMs = Math.round(interval * 1000);

    // Prefer a test-supplied controller; otherwise install a transient
    // SIGINT listener that aborts the loop.
    const controller = WATCH_TEST_CONTROLLER.ref ?? new AbortController();
    const sigintHandler = (): void => {
      controller.abort();
    };
    const installedSigint = WATCH_TEST_CONTROLLER.ref === null;
    if (installedSigint) {
      process.once('SIGINT', sigintHandler);
    }

    // Open the pager once for the whole loop (upstream `do_watch` wraps the
    // entire session, not each iteration, so the user can scroll the
    // accumulated output in one go). When PSQL_WATCH_PAGER / PAGER aren't
    // set we fall through to the normal `pickOut` target.
    const pager = openWatchPager();
    const out = pager?.stream ?? pickOut(ctx.settings, null);

    try {
      // CONTINUOUS mode: when `c=` is absent, `iterSet` stays false and the
      // iteration-cap break below never fires, so the loop re-runs the query
      // on the interval forever — exactly upstream `do_watch`'s `for (i = 0;
      // !iter || i < iter; i++)` when `iter == 0`. The only exits are a
      // SIGINT (or the test controller) aborting `controller.signal`, a
      // server error, or the `min_rows` CONTINUE predicate failing.
      let iter = 0;
      while (!controller.signal.aborted) {
        iter++;
        const stamp = formatWatchTimestamp(new Date());
        out.write(`${stamp} (every ${String(interval)}s)\n\n`);
        let lastRowCount = 0;
        try {
          const results = await ctx.settings.db.execSimple(sql);
          for (const rs of results) {
            if (rs.fields.length > 0) {
              await renderResult(ctx.settings, rs, out);
              lastRowCount = rs.rows.length;
            }
          }
        } catch (err) {
          // Surface in upstream's 3-line ErrorResponse shape (severity +
          // message + LINE / caret) — same path top-level statement errors
          // take. The `\watch:` prefix is reserved for client-side
          // argument-parsing errors (e.g. `incorrect interval value "-10"`).
          // Pass the comment-stripped buffer so the `LINE N:` count starts
          // at the first content line — see runGCore for the rationale.
          return formatServerError(ctx, err, trimmedBuf);
        }
        // Stop if `c=` reached the configured iteration cap, OR if `m=`
        // was set and the previous result returned FEWER than `min_rows`
        // tuples. Upstream's `ExecQueryAndProcessResults` sets `return_early`
        // exactly when `min_rows > 0 && PQntuples(result) < min_rows`, and
        // `do_watch` breaks out of the loop on that signal — see PG source
        // `src/bin/psql/common.c::ExecQueryAndProcessResults`. In other
        // words `min_rows` is a CONTINUE predicate: keep polling while
        // the result has at least `min_rows` rows; stop the moment it
        // doesn't.
        if (iterSet && iter >= iterMax) break;
        if (minRowsSet && lastRowCount < minRows) break;
        if (controller.signal.aborted) break;
        // sleep_ms == 0 is upstream's "tight loop, no wait needed" — skip
        // the timer round-trip entirely so we don't queue a setTimeout(0)
        // for every iteration. Matches `do_watch`'s `if (sleep_ms == 0)
        // continue;` branch.
        if (intervalMs > 0) {
          await sleepCancellable(intervalMs, controller.signal);
        }
      }
      // Upstream `do_watch` injects a trailing newline AFTER the loop
      // ends when no pager is attached, to clear the cursor after a
      // possible `^C` echo. Mirror that here so the conformance output
      // shape (`...\n(N rows)\n\n\n`) matches vanilla psql.
      if (!pager) {
        out.write('\n');
      }
      return { status: 'reset-buf', newBuf: '' };
    } finally {
      if (installedSigint) {
        process.removeListener('SIGINT', sigintHandler);
      }
      // Drain the pager so its child has a chance to exit before \watch
      // returns. Failures are swallowed: a broken pager shouldn't mask the
      // (already-flushed) query results.
      if (pager) {
        await pager.close();
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Registration entry point.
// ---------------------------------------------------------------------------

export const registerIoCommands = (registry: BackslashRegistry): void => {
  registry.register(cmdInclude);
  registry.register(cmdIncludeRel);
  registry.register(cmdOut);
  registry.register(cmdWrite);
  registry.register(cmdG);
  registry.register(cmdGx);
  registry.register(cmdPrint);
  registry.register(cmdGset);
  registry.register(cmdGdesc);
  registry.register(cmdGexec);
  registry.register(cmdWatch);
};
