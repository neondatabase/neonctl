/**
 * psql pipeline / extended-query backslash commands (WP-21).
 *
 * Implements the subset of upstream psql's "pipeline mode" backslash commands
 * that drive the extended protocol directly. These are typically used together
 * with the existing `\g` flow: a `\bind` (or `\parse`) command stashes
 * parameter / statement state on the {@link BackslashContext}'s settings via
 * a Symbol-keyed slot; when the mainloop then sees a `;` (or a `\g`), it can
 * notice the stashed state and route the query through
 * `Connection.query(sql, params)` instead of `execSimple`.
 *
 * Because the mainloop integration is owned by other WPs (and was deliberately
 * left untouched here), this module exposes both the command specs AND a
 * small helper, {@link getPipelineState}, that the mainloop will use to
 * consult the stashed state. The commands operate on the buffered query the
 * same way `\g` does — they execute or queue the buffer and reset it.
 *
 * Commands shipped:
 *
 *   \bind [VALUE ...]        stash params for next ; / \g
 *   \bind_named NAME [V ...] stash params + named prepared statement
 *   \parse NAME              prepare current query buffer as NAME
 *   \close_prepared NAME     Close('S', NAME)
 *   \startpipeline           begin a pipeline session (settings.sendMode)
 *   \endpipeline             end the pipeline session, drain results
 *   \syncpipeline            send Sync mid-pipeline
 *   \sendpipeline            submit the current buffered query w/o waiting
 *   \flushrequest            send Flush
 *   \flush                   alias for \flushrequest
 *   \getresults [N]          drain pending pipeline results
 *   \gdesc                   describe-without-execute the buffered query
 *
 * The set is registered in bulk via {@link registerPipelineCommands}.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import type {
  Pipeline,
  PreparedStatement,
  ResultSet,
} from '../types/connection.js';

import { writeErr } from './shared.js';
import { alignedPrinter } from '../print/aligned.js';
import { PipelineSession } from '../wire/pipeline.js';

// ---------------------------------------------------------------------------
// Settings stash. We can't add new fields to PsqlSettings (frozen WP-00) so
// we attach Symbol-keyed state.
// ---------------------------------------------------------------------------

const BIND_STATE_KEY = Symbol.for('neonctl.psql.bindState');
const PIPELINE_KEY = Symbol.for('neonctl.psql.pipeline');
const PREPARED_BY_NAME_KEY = Symbol.for('neonctl.psql.preparedByName');

type BindState = {
  /** Named prepared statement to bind to ('' = anonymous). */
  name: string;
  values: string[];
  /**
   * `true` when this was set by `\bind_named NAME` — `\g` should look up
   * the previously-prepared statement (via `\parse NAME`) and just run
   * Bind + Execute against it. `false` (set by `\bind`) means re-prepare
   * from the current buffer and execute in one round-trip.
   */
  byName: boolean;
};

type PipelineStash = {
  session: Pipeline;
  /**
   * Synthetic per-Execute slots — one entry per `\sendpipeline` or
   * implicit-`;` push. The contents aren't load-bearing; the **count**
   * (length) is used by older call sites that track "queued but not
   * sent" commands. Real per-Execute ResultSets live on
   * `(session as PipelineSession).results` and are surfaced by
   * `\getresults` / `\endpipeline` via {@link drainedCount}.
   */
  pending: Promise<ResultSet | undefined>[];
  /**
   * Index into `(session as PipelineSession).results` of the next
   * ResultSet that has NOT yet been displayed. Bumped by `\getresults`
   * after each result is printed; `\endpipeline` prints
   * `results[drainedCount..]` on the way out.
   */
  drainedCount: number;
};

type Stash = Record<symbol, unknown> & {
  [BIND_STATE_KEY]?: BindState;
  [PIPELINE_KEY]?: PipelineStash;
  [PREPARED_BY_NAME_KEY]?: Map<string, PreparedStatement>;
};

const stashOf = (settings: PsqlSettings): Stash => settings as unknown as Stash;

/** Read (and clear) the pending bind params, if any. */
export const consumeBindState = (settings: PsqlSettings): BindState | null => {
  const s = stashOf(settings);
  const cur = s[BIND_STATE_KEY] ?? null;
  s[BIND_STATE_KEY] = undefined;
  return cur;
};

/**
 * Peek at the bind stash without consuming. Used by `\g` to decide
 * whether to skip the "empty buffer, no prior query" no-op guard:
 * when a `\bind_named NAME` is pending, the prepared statement carries
 * the SQL server-side so no buffer text is needed.
 */
export const stagedNamedBindPresent = (settings: PsqlSettings): boolean => {
  const cur = stashOf(settings)[BIND_STATE_KEY];
  return !!cur && cur.byName;
};

/** Stash a PreparedStatement for later `\bind_named NAME \g` lookup. */
export const stashPrepared = (
  settings: PsqlSettings,
  name: string,
  ps: PreparedStatement,
): void => {
  const s = stashOf(settings);
  let map = s[PREPARED_BY_NAME_KEY];
  if (!map) {
    map = new Map();
    s[PREPARED_BY_NAME_KEY] = map;
  }
  map.set(name, ps);
};

/** Look up a previously-stashed PreparedStatement by name. */
export const lookupPrepared = (
  settings: PsqlSettings,
  name: string,
): PreparedStatement | null => {
  const map = stashOf(settings)[PREPARED_BY_NAME_KEY];
  return map?.get(name) ?? null;
};

/** Drop a stashed PreparedStatement (after `\close_prepared`). */
export const dropPrepared = (settings: PsqlSettings, name: string): void => {
  const map = stashOf(settings)[PREPARED_BY_NAME_KEY];
  if (map) map.delete(name);
};

/** Peek at the current pipeline session (or null). */
export const getPipelineState = (
  settings: PsqlSettings,
): PipelineStash | null => stashOf(settings)[PIPELINE_KEY] ?? null;

// ---------------------------------------------------------------------------
// PIPELINE_* counter book-keeping.
//
// Upstream psql 18 exposes three pipeline counters as `:VAR`-interpolatable
// session variables (initialized to "0" in `settings.ts` at startup):
//
//   PIPELINE_COMMAND_COUNT  number of P/B/E batches queued since last Sync
//   PIPELINE_SYNC_COUNT     number of Syncs issued in the current pipeline
//   PIPELINE_RESULT_COUNT   results queued server-side but not yet fetched
//
// The counter rules (verified empirically against vanilla psql 18.4):
//
//   \startpipeline    — all three reset to "0".
//   \parse            — COMMAND_COUNT++.
//   \sendpipeline     — COMMAND_COUNT++.
//   ;-query in pipeline mode — COMMAND_COUNT++ (each implicit-`;` send).
//   \syncpipeline     — SYNC_COUNT++, RESULT_COUNT += COMMAND_COUNT,
//                       COMMAND_COUNT = 0.
//   \flushrequest /
//   \flush            — RESULT_COUNT += COMMAND_COUNT, COMMAND_COUNT = 0.
//   \getresults [N]   — RESULT_COUNT -= actually-drained; if RESULT_COUNT
//                       hits 0, SYNC_COUNT also resets to 0 (full-drain
//                       returns the pipeline to a clean slate).
//   \endpipeline      — all three reset to "0".
//
// For `;`-queries the increment fires from a wrapper installed around the
// stashed `Pipeline.execute` in `cmdStartPipeline.run` — mainloop's
// `dispatchSendQuery` calls `ps.session.parse/bind/execute` directly, and
// the wrapper picks that up without mainloop having to know about the var
// store.
// ---------------------------------------------------------------------------

const readCounter = (settings: PsqlSettings, name: string): number => {
  const raw = settings.vars.get(name);
  if (raw === undefined) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const setCounter = (
  settings: PsqlSettings,
  name: string,
  value: number,
): void => {
  settings.vars.set(name, String(Math.max(0, value)));
};

const bumpCounter = (
  settings: PsqlSettings,
  name: string,
  delta: number,
): void => {
  setCounter(settings, name, readCounter(settings, name) + delta);
};

const resetPipelineCounters = (settings: PsqlSettings): void => {
  setCounter(settings, 'PIPELINE_COMMAND_COUNT', 0);
  setCounter(settings, 'PIPELINE_SYNC_COUNT', 0);
  setCounter(settings, 'PIPELINE_RESULT_COUNT', 0);
};

/**
 * Wrap `Pipeline.execute` so each enqueued Execute message bumps
 * `PIPELINE_COMMAND_COUNT`. The wrapping covers both call sites:
 *
 *  - `cmdSendPipeline` (this file) — `\sendpipeline`.
 *  - `dispatchSendQuery` (mainloop) — implicit `;`-queries while pipeline
 *    is active. Mainloop calls `ps.session.execute('', 0)` so the wrapper
 *    fires automatically without mainloop knowing about the var store.
 *
 * The wrapper preserves the original function's `this` binding via `apply`.
 */
const wrapSessionForCounters = (
  session: Pipeline,
  settings: PsqlSettings,
): Pipeline => {
  const origExecute = session.execute.bind(session);
  session.execute = (name: string, maxRows?: number) => {
    bumpCounter(settings, 'PIPELINE_COMMAND_COUNT', 1);
    return origExecute(name, maxRows);
  };
  return session;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errResult = (ctx: BackslashContext, message: string): BackslashResult => {
  ctx.settings.lastErrorResult = { message };
  writeErr(`\\${ctx.cmdName}: ${message}\n`);
  // Tell mainloop the diagnostic is already on stderr so it doesn't add
  // a `psql: ERROR:  <msg>` fallback line.
  return { status: 'error', errorWritten: true };
};

/**
 * Coerce any thrown / rejected value into a printable string. The
 * extended-protocol driver in `PgConnection` rejects with raw
 * ConnectError records (`{severity, code, message, detail, ...}`) —
 * not `Error` instances — so `String(err)` would produce
 * `[object Object]` in the conformance output. We probe for a
 * `.message` property (covering both `Error` and the ConnectError
 * shape) and fall back to JSON.stringify only when there's no
 * message field at all.
 */
const errorToMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (
    err !== null &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

/**
 * Render a pipeline-collected ConnectError to stderr in the upstream
 * shape: a `SEVERITY:  message` line, followed by optional `DETAIL:` /
 * `HINT:` / `CONTEXT:` lines (each on its own line). Matches the
 * subset of `formatErrorReport`-style output the conformance corpus
 * expects from `\endpipeline` for non-FATAL pipeline errors. We
 * inline a minimal renderer here rather than importing the full
 * `formatErrorReport` from `cmd_meta` because we always want the
 * "default verbosity, no LINE/caret context" form — pipeline errors
 * arrive after the buffered query has been reset and we don't carry
 * the originating SQL position through `session.lastError`.
 */
const renderPipelineError = (err: unknown): void => {
  if (err === null || typeof err !== 'object') {
    writeErr(`ERROR:  ${errorToMessage(err)}\n`);
    return;
  }
  const e = err as {
    severity?: string;
    message?: string;
    detail?: string;
    hint?: string;
    where?: string;
  };
  const severity = e.severity ?? 'ERROR';
  const message = e.message ?? '';
  writeErr(`${severity}:  ${message}\n`);
  if (e.detail) writeErr(`DETAIL:  ${e.detail}\n`);
  if (e.hint) writeErr(`HINT:  ${e.hint}\n`);
  if (e.where) writeErr(`CONTEXT:  ${e.where}\n`);
};

const readAllArgs = (ctx: BackslashContext): string[] => {
  const out: string[] = [];
  for (;;) {
    const arg = ctx.nextArg('normal');
    if (arg === null) break;
    out.push(arg);
  }
  return out;
};

// ---------------------------------------------------------------------------
// \bind [VALUE ...]
// ---------------------------------------------------------------------------

export const cmdBind: BackslashCmdSpec = {
  name: 'bind',
  helpKey: 'bind',
  run(ctx: BackslashContext): Promise<BackslashResult> {
    const values = readAllArgs(ctx);
    stashOf(ctx.settings)[BIND_STATE_KEY] = {
      name: '',
      values,
      byName: false,
    };
    return Promise.resolve({ status: 'ok' });
  },
};

// ---------------------------------------------------------------------------
// \bind_named NAME [VALUE ...]
// ---------------------------------------------------------------------------

export const cmdBindNamed: BackslashCmdSpec = {
  name: 'bind_named',
  helpKey: 'bind_named',
  run(ctx: BackslashContext): Promise<BackslashResult> {
    const name = ctx.nextArg('normal');
    // Upstream `exec_command_bind_named` rejects only the missing-arg
    // case. `''` IS valid — it addresses the unnamed prepared statement
    // slot (set via `\parse ''`).
    if (name === null) {
      // Upstream wipes any prior `\bind_named` state on this error so a
      // follow-on `\g` falls back to `pset.last_query` (the previous
      // successful query) instead of executing against a stale handle.
      stashOf(ctx.settings)[BIND_STATE_KEY] = undefined;
      return Promise.resolve(errResult(ctx, 'missing required argument'));
    }
    const values = readAllArgs(ctx);
    stashOf(ctx.settings)[BIND_STATE_KEY] = { name, values, byName: true };
    return Promise.resolve({ status: 'ok' });
  },
};

// ---------------------------------------------------------------------------
// \parse NAME — prepare current queryBuf as NAME.
// ---------------------------------------------------------------------------

export const cmdParse: BackslashCmdSpec = {
  name: 'parse',
  helpKey: 'parse',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const name = ctx.nextArg('normal');
    // Upstream `exec_command_parse` rejects only the missing-arg case
    // with `missing required argument`. An explicit empty string `''`
    // IS valid — it's the "unnamed" prepared statement slot, addressable
    // later via `\bind_named ''`.
    if (name === null) {
      return errResult(ctx, 'missing required argument');
    }
    // Upstream `exec_command_parse` passes the query buffer verbatim to
    // `PQsendPrepare`, with no trim — the server then stores the bytes
    // exactly in `pg_prepared_statements.statement`. Trimming here would
    // strip trailing whitespace that the conformance corpus (and any
    // `LINE 1:` ErrorResponse echo) expects to round-trip byte-for-byte.
    // The empty-buffer guard still uses a trimmed view so a whitespace-
    // only buffer reports `no query buffer` like upstream does.
    const sql = ctx.queryBuf;
    if (sql.trim().length === 0) {
      return errResult(ctx, 'no query buffer');
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }
    // In pipeline mode, route the Parse through the active session so
    // it gets queued behind the in-flight P/B/E ops (and the server
    // defers any ParseError until the next Sync). Doing a `db.prepare`
    // here would issue its own Sync mid-pipeline, corrupting the
    // pipeline's reply ordering — the conformance corpus exercises a
    // `\parse '' \parse '' \parse pipeline_1` triple-Parse and
    // expects the third Parse's `could not determine data type` error
    // to surface AT `\endpipeline` time, not synchronously here.
    const pipelineActive = getPipelineState(ctx.settings);
    if (pipelineActive !== null) {
      try {
        await pipelineActive.session.parse(name, sql, []);
        ctx.settings.lastQuery = sql;
        // Upstream `exec_command_parse` bumps `pset.piped_commands` after
        // PQsendPrepare succeeds — the Parse is one queued command.
        bumpCounter(ctx.settings, 'PIPELINE_COMMAND_COUNT', 1);
        return { status: 'reset-buf', newBuf: '' };
      } catch (err) {
        return errResult(ctx, errorToMessage(err));
      }
    }
    try {
      const ps = await ctx.settings.db.prepare(name, sql);
      // Cache for `\bind_named NAME \g` lookup later. Upstream tracks
      // server-side prepared statements by name in `pset.psqlScanState`-
      // adjacent state; we keep a local map so a follow-on `\g` can
      // bind + execute without re-parsing.
      stashPrepared(ctx.settings, name, ps);
      // Upstream `exec_command_parse` also updates `pset.last_query` to
      // the prepared SQL so a subsequent `\g` (e.g. after a failed
      // `\bind_named NAME` that wipes bind state) re-runs the parsed
      // text via the simple-query path. Without this, our `\g` would
      // either no-op or fall back to a stale prior query, missing the
      // "ERROR: there is no parameter $1" the conformance corpus
      // expects from `SELECT $1, $2` executed without bind params.
      ctx.settings.lastQuery = sql;
      return { status: 'reset-buf', newBuf: '' };
    } catch (err) {
      return errResult(ctx, errorToMessage(err));
    }
  },
};

// ---------------------------------------------------------------------------
// \close_prepared NAME
// ---------------------------------------------------------------------------

export const cmdClosePrepared: BackslashCmdSpec = {
  name: 'close_prepared',
  helpKey: 'close_prepared',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const name = ctx.nextArg('normal');
    // Empty string `''` is the valid unnamed prepared statement.
    if (name === null) {
      return errResult(ctx, 'missing required argument');
    }
    const db = ctx.settings.db;
    if (!db) {
      return errResult(ctx, 'no connection to the server');
    }
    try {
      // Upstream psql just issues `Close('S', name) + Sync` directly; the
      // server treats Close on a missing name as a no-op (CloseComplete
      // without diagnostics), so we don't need to know whether the
      // statement exists. A previous implementation faked a
      // `prepare(name, 'SELECT 1')` to reach the same Close, which broke
      // when the name was already prepared on the server (Parse fails
      // with `prepared statement "NAME" already exists`).
      if (db.closePreparedStatement) {
        await db.closePreparedStatement(name);
      } else {
        // Backwards-compat path for Connection mocks that don't
        // implement the dedicated entry point. The real PgConnection
        // always provides closePreparedStatement; this branch only
        // fires under unit tests with bespoke Connection mocks.
        const stmt = await db.prepare(name, 'SELECT 1');
        await stmt.close();
      }
      // Drop any cached binding so a later `\bind_named NAME \g` errors
      // cleanly instead of using a stale handle.
      dropPrepared(ctx.settings, name);
      return { status: 'ok' };
    } catch (err) {
      return errResult(ctx, errorToMessage(err));
    }
  },
};

// ---------------------------------------------------------------------------
// \startpipeline / \endpipeline
// ---------------------------------------------------------------------------

export const cmdStartPipeline: BackslashCmdSpec = {
  name: 'startpipeline',
  helpKey: 'startpipeline',
  run(ctx: BackslashContext): Promise<BackslashResult> {
    if (!ctx.settings.db) {
      return Promise.resolve(errResult(ctx, 'no connection to the server'));
    }
    // Vanilla psql 18.4 treats a duplicate `\startpipeline` as a silent
    // no-op (no warning on stdout OR stderr) — verified empirically:
    // `psql --no-psqlrc --echo-all --quiet -X -c '\startpipeline
    // \startpipeline \endpipeline' 2>&1` prints only the three echoed
    // lines. Our prior `errResult('pipeline already active')` was a
    // divergence; match upstream's quiet path.
    if (getPipelineState(ctx.settings) !== null) {
      return Promise.resolve({ status: 'ok' });
    }
    try {
      const session = wrapSessionForCounters(
        ctx.settings.db.pipeline(),
        ctx.settings,
      );
      stashOf(ctx.settings)[PIPELINE_KEY] = {
        session,
        pending: [],
        drainedCount: 0,
      };
      ctx.settings.sendMode = 'extended-pipeline';
      // Upstream `exec_command_startpipeline` calls SetVariable for the three
      // counter vars (zeroing whatever the prior pipeline left behind).
      resetPipelineCounters(ctx.settings);
      return Promise.resolve({ status: 'ok' });
    } catch (err) {
      return Promise.resolve(errResult(ctx, errorToMessage(err)));
    }
  },
};

export const cmdEndPipeline: BackslashCmdSpec = {
  name: 'endpipeline',
  helpKey: 'endpipeline',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const ps = getPipelineState(ctx.settings);
    if (!ps) {
      // Upstream `exec_command_endpipeline` writes the diagnostic via
      // `pg_log_error`; in psql 18.4 the line lands on stderr with NO
      // `psql:` / `\endpipeline:` prefix (verified empirically with
      // `psql --no-psqlrc --echo-all --quiet -X -c '\endpipeline'
      // 2>&1` — the only stderr line is the raw message). The
      // conformance corpus mirrors that bare form, so we bypass
      // `errResult` (which would inject `\endpipeline: `) and write
      // the line directly.
      ctx.settings.lastErrorResult = {
        message: 'cannot send pipeline when not in pipeline mode',
      };
      writeErr('cannot send pipeline when not in pipeline mode\n');
      return { status: 'error', errorWritten: true };
    }
    try {
      // Snapshot how many results were already surfaced by prior
      // `\getresults` calls — only the residual that the final Sync
      // inside `session.end()` flushes should be printed. Upstream
      // psql achieves this implicitly via `PQgetResult()` consuming
      // results from libpq's queue inside `\getresults`; we mirror
      // the semantics with an explicit cursor (`drainedCount`).
      const alreadyDrained = ps.drainedCount;
      // Hold a reference to the session BEFORE end() clears the stash —
      // we still need `lastError` after the pipeline has been torn down.
      // The session is `Pipeline` (interface) but the concrete impl
      // (`PipelineSession`) exposes per-Execute promise tracking; cast
      // and probe for the field so test mocks (which don't carry the
      // extra fields) still work — they get an empty snapshot and the
      // path degenerates to the previous `sets`-only rendering.
      const session = ps.session as PipelineSession & {
        results?: readonly Promise<ResultSet>[];
        lastError?: unknown;
      };
      // Capture per-Execute promises as a snapshot — `end()` settles
      // them but doesn't expose the per-op rejection records, which
      // we need to interleave errors at the correct ordinal position.
      const promiseSnapshot = Array.isArray(session.results)
        ? session.results.slice()
        : [];
      const sets = await ps.session.end();
      stashOf(ctx.settings)[PIPELINE_KEY] = undefined;
      ctx.settings.sendMode = 'extended-query';
      // Upstream `exec_command_endpipeline` zeroes the counters once the
      // pipeline has drained — mirrors the empirical behaviour of vanilla
      // psql 18.4 where `\echo :PIPELINE_*` reads "0" after `\endpipeline`.
      resetPipelineCounters(ctx.settings);
      // Walk the per-Execute promises in execute order, interleaving
      // ErrorResponse renderings with successful ResultSets. Upstream
      // psql 18.4 emits errors EXACTLY where the failed op sat in the
      // wire stream (see expected/psql_pipeline.out line 433: the
      // `bind message supplies 0 parameters` ERROR prints BEFORE the
      // second `\sendpipeline`'s `?column?` table because the failed
      // bind was the first Execute and the successful query was the
      // second). Plain "print all sets then error" would invert the
      // order. The snapshot was taken before `end()` settled the
      // promises, but Promise.allSettled is a no-op on already-settled
      // promises — `end()` awaits them itself — so this is safe.
      const settled = await Promise.allSettled(promiseSnapshot);
      let errorRendered = false;
      // When `promiseSnapshot` is empty (test mocks that don't track
      // per-Execute promises, or implementations that don't expose
      // `results`), fall back to printing the `sets` returned by
      // `end()` directly. This preserves the historical behaviour for
      // mocks while keeping the in-order interleaving for the real
      // PipelineSession.
      const entries =
        settled.length > 0
          ? settled
          : sets.map(
              (rs): PromiseSettledResult<ResultSet> => ({
                status: 'fulfilled',
                value: rs,
              }),
            );
      for (let i = alreadyDrained; i < entries.length; i++) {
        const r = entries[i];
        if (r.status === 'fulfilled') {
          const rs = r.value;
          if (rs.fields.length > 0) {
            await alignedPrinter.printQuery(
              rs,
              ctx.settings.popt,
              process.stdout,
            );
          }
        } else if (!errorRendered) {
          // Render only the FIRST rejection inline — subsequent ops
          // in an aborted pipeline reject with the same sticky error
          // (or with `Pipeline aborted, command did not run`, which
          // the conformance corpus already suppresses for empty-buffer
          // sentinel cases). Matching the vanilla "one ERROR, then
          // recovery" rhythm.
          renderPipelineError(r.reason);
          errorRendered = true;
        }
      }
      // Fallback: if `session.lastError` was set but no per-op
      // rejection was observed (can happen when the error came from
      // the trailing Sync rather than a specific Execute), render it
      // here. Otherwise the diagnostic would be lost.
      if (!errorRendered) {
        const lastErr = session.lastError;
        if (lastErr !== null && lastErr !== undefined) {
          renderPipelineError(lastErr);
        }
      }
      return { status: 'ok' };
    } catch (err) {
      stashOf(ctx.settings)[PIPELINE_KEY] = undefined;
      ctx.settings.sendMode = 'extended-query';
      // Even on a failed `\endpipeline` (e.g. server hung up mid-drain),
      // mirror upstream and clear the counters — the pipeline state is
      // gone, so any non-zero value would be misleading.
      resetPipelineCounters(ctx.settings);
      return errResult(ctx, errorToMessage(err));
    }
  },
};

// ---------------------------------------------------------------------------
// \syncpipeline / \flushrequest / \flush
// ---------------------------------------------------------------------------

export const cmdSyncPipeline: BackslashCmdSpec = {
  name: 'syncpipeline',
  helpKey: 'syncpipeline',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const ps = getPipelineState(ctx.settings);
    if (!ps) return errResult(ctx, 'no pipeline active');
    try {
      await ps.session.sync();
      // Upstream `exec_command_syncpipeline`:
      //   piped_results += piped_commands;
      //   piped_commands = 0;
      //   piped_syncs++;
      // The pending commands have transitioned to "queued results" on the
      // server, and Sync is itself counted as a piped command boundary.
      const queued = readCounter(ctx.settings, 'PIPELINE_COMMAND_COUNT');
      setCounter(ctx.settings, 'PIPELINE_COMMAND_COUNT', 0);
      bumpCounter(ctx.settings, 'PIPELINE_RESULT_COUNT', queued);
      bumpCounter(ctx.settings, 'PIPELINE_SYNC_COUNT', 1);
      return { status: 'ok' };
    } catch (err) {
      return errResult(ctx, errorToMessage(err));
    }
  },
};

export const cmdFlushRequest: BackslashCmdSpec = {
  name: 'flushrequest',
  helpKey: 'flushrequest',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const ps = getPipelineState(ctx.settings);
    if (!ps) return errResult(ctx, 'no pipeline active');
    try {
      await ps.session.flush();
      // Upstream `exec_command_flushrequest`:
      //   piped_results += piped_commands;
      //   piped_commands = 0;
      // The pending commands move to "queued results" but SYNC isn't issued.
      const queued = readCounter(ctx.settings, 'PIPELINE_COMMAND_COUNT');
      setCounter(ctx.settings, 'PIPELINE_COMMAND_COUNT', 0);
      bumpCounter(ctx.settings, 'PIPELINE_RESULT_COUNT', queued);
      return { status: 'ok' };
    } catch (err) {
      return errResult(ctx, errorToMessage(err));
    }
  },
};

export const cmdFlush: BackslashCmdSpec = {
  name: 'flush',
  helpKey: 'flush',
  run(ctx: BackslashContext): Promise<BackslashResult> {
    return cmdFlushRequest.run(ctx);
  },
};

// ---------------------------------------------------------------------------
// \sendpipeline — submit current buffer with stashed bind params.
// ---------------------------------------------------------------------------

export const cmdSendPipeline: BackslashCmdSpec = {
  name: 'sendpipeline',
  helpKey: 'sendpipeline',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const ps = getPipelineState(ctx.settings);
    if (!ps) {
      // Upstream wording (psql 18.4): "\\sendpipeline not allowed
      // outside of pipeline mode". Verified empirically; no
      // `\sendpipeline: ` prefix on stderr.
      ctx.settings.lastErrorResult = {
        message: '\\sendpipeline not allowed outside of pipeline mode',
      };
      writeErr('\\sendpipeline not allowed outside of pipeline mode\n');
      return { status: 'error', errorWritten: true };
    }
    const bind = consumeBindState(ctx.settings);
    // Upstream `exec_command_sendpipeline` (in pipeline mode) requires
    // a preceding `\bind` or `\bind_named`. Without it, the error is
    // "\sendpipeline must be used after \bind or \bind_named", emitted
    // BEFORE the empty-buffer check. The conformance test exercises
    // both `\sendpipeline` (no buffer, no bind) and `SELECT 1
    // \sendpipeline` (with buffer, no bind) — both must produce the
    // same diagnostic, so order matters here.
    if (bind === null) {
      ctx.settings.lastErrorResult = {
        message: '\\sendpipeline must be used after \\bind or \\bind_named',
      };
      writeErr('\\sendpipeline must be used after \\bind or \\bind_named\n');
      return { status: 'error', errorWritten: true };
    }
    const sql = ctx.queryBuf.trim();
    const stmtName = bind.name;
    const params = bind.values;
    // `\bind_named NAME` re-uses a server-side prep stmt, so an empty
    // buffer is fine — we skip the Parse and just Bind + Execute. The
    // anonymous-`\bind` path still needs a buffer because we must
    // Parse the SQL first.
    if (!bind.byName && sql.length === 0) {
      return errResult(ctx, 'no query buffer');
    }

    try {
      // We send the full P/B/E sequence without an intervening Sync — the
      // user is expected to call \syncpipeline or \endpipeline to commit.
      // For `\bind_named`, skip Parse (the prep stmt already exists on
      // the server, named by the user). For anonymous `\bind`, queue
      // an unnamed Parse so the SQL is parsed on the server in this
      // batch.
      if (!bind.byName) {
        await ps.session.parse('', sql, []);
      }
      await ps.session.bind(stmtName, params);
      const exec = (async (): Promise<ResultSet> => {
        await ps.session.execute('', 0);
        // PipelineSession.execute resolves with void on the public API; the
        // session internally tracks the ResultSet and surfaces it in end().
        return {
          command: '',
          rowCount: null,
          oid: null,
          fields: [],
          rows: [],
          notices: [],
        };
      })();
      ps.pending.push(exec);
      return { status: 'reset-buf', newBuf: '' };
    } catch (err) {
      return errResult(ctx, errorToMessage(err));
    }
  },
};

// ---------------------------------------------------------------------------
// \getresults [N] — drain N pending results (or all if N omitted).
// ---------------------------------------------------------------------------

export const cmdGetResults: BackslashCmdSpec = {
  name: 'getresults',
  helpKey: 'getresults',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const ps = getPipelineState(ctx.settings);
    const arg = ctx.nextArg('normal');
    // Upstream `exec_command_getresults` parses the optional count BEFORE
    // checking pipeline state, so an invalid count surfaces even when
    // there's no pipeline active. The wording matches upstream verbatim
    // ("invalid number of requested results").
    let requested: number | null = null;
    if (arg !== null && arg.length > 0) {
      const parsed = parseInt(arg, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return errResult(ctx, 'invalid number of requested results');
      }
      requested = parsed;
    }
    // No active pipeline → upstream prints `No pending results to get`
    // (the "no-op idle" message), NOT a hard "no pipeline active" error.
    // This matches the conformance test that runs `\getresults` BOTH
    // outside of `\startpipeline / \endpipeline` brackets and right
    // after `\endpipeline`.
    if (!ps) {
      process.stdout.write('No pending results to get\n');
      return { status: 'ok' };
    }
    // Available items to drain = PIPELINE_SYNC_COUNT + PIPELINE_RESULT_COUNT.
    // Sync markers and data-result entries both occupy slots in libpq's
    // pipeline result queue; vanilla's `\getresults N` walks the queue
    // FIFO, draining either kind. A `\sendpipeline` queued on the
    // client but not yet `\flushrequest`-ed / `\syncpipeline`-ed does
    // NOT count — those commands have a still-pending Execute promise
    // but the server hasn't been told to flush replies. Verified
    // empirically with vanilla psql 18.4: SQL like
    //   \syncpipeline \syncpipeline SELECT $1 \bind 1 \sendpipeline
    //   \flushrequest \getresults 1
    // prints nothing on the first \getresults 1 (SyncMarker drained,
    // SYNC_COUNT: 2 → 1), the second prints nothing (SYNC_COUNT: 1 →
    // 0), and the third prints the SELECT result.
    const syncAvailable = readCounter(ctx.settings, 'PIPELINE_SYNC_COUNT');
    const resultAvailable = readCounter(ctx.settings, 'PIPELINE_RESULT_COUNT');
    const available = syncAvailable + resultAvailable;
    if (available === 0) {
      process.stdout.write('No pending results to get\n');
      return { status: 'ok' };
    }
    // `\getresults 0` and bare `\getresults` mean "all pending"
    // (upstream semantics).
    const n =
      requested === null || requested === 0
        ? available
        : Math.min(requested, available);
    // Pull the next `n` ResultSet promises from the session-tracked
    // list of per-op results (which interleaves Sync markers from
    // `session.sync()` with data results from `session.execute()`).
    // `drainedCount` advances by `n` so a follow-on `\endpipeline`
    // knows to skip what we've already printed.
    const session = ps.session as PipelineSession & {
      results?: readonly Promise<ResultSet>[];
    };
    const results: readonly Promise<ResultSet>[] = Array.isArray(
      session.results,
    )
      ? session.results
      : [];
    const start = ps.drainedCount;
    const end = start + n;
    const slice = results.slice(start, end);
    ps.drainedCount = end;
    // Keep `ps.pending` in sync for any legacy callers that read its
    // length — splice off the consumed count. The spliced promises are
    // synthetic placeholders (real ResultSets live on `session.results`),
    // so we discard the return value.
    void ps.pending.splice(0, n);
    try {
      const settled = await Promise.allSettled(slice);
      // Walk in order, decrementing the appropriate counter per drained
      // entry. Sync markers are zero-fields ResultSets (pushed by
      // `session.sync()`); data results carry the real RowDescription.
      let syncsDrained = 0;
      let resultsDrained = 0;
      let walkedItems = 0;
      for (const r of settled) {
        walkedItems++;
        if (r.status !== 'fulfilled') {
          // Rejected promise — most likely an Execute that errored
          // server-side. Treat as a data-result slot (it consumes one
          // PIPELINE_RESULT_COUNT entry), but we don't print it inline
          // here (the conformance corpus expects pipeline ERRORs to
          // surface at `\endpipeline` time, not at `\getresults`).
          resultsDrained++;
          continue;
        }
        const rs = r.value;
        if (rs.fields.length === 0) {
          // Sync marker.
          syncsDrained++;
          continue;
        }
        resultsDrained++;
        await alignedPrinter.printQuery(rs, ctx.settings.popt, process.stdout);
      }
      // Fallback when `session.results` wasn't tracked (test mocks):
      // decrement RESULT_COUNT first, then SYNC_COUNT. Real
      // PipelineSession populates `results` so the walk above already
      // attributed each drain to the right counter.
      if (walkedItems === 0) {
        const ddata = Math.min(n, resultAvailable);
        resultsDrained = ddata;
        syncsDrained = n - ddata;
      }
      // Decrement counters. Upstream `exec_command_getresults` does the
      // same accounting: PIPELINE_SYNC_COUNT and PIPELINE_RESULT_COUNT
      // are decremented by the actually-consumed items in each
      // category. Capped at 0 to be defensive.
      bumpCounter(ctx.settings, 'PIPELINE_SYNC_COUNT', -syncsDrained);
      bumpCounter(ctx.settings, 'PIPELINE_RESULT_COUNT', -resultsDrained);
      // Upstream rule: when the queue is fully drained, SYNC_COUNT
      // also resets to 0 (the pipeline is back to "no Sync
      // outstanding") — verified empirically. A partial drain leaves
      // it unchanged.
      if (
        readCounter(ctx.settings, 'PIPELINE_RESULT_COUNT') === 0 &&
        readCounter(ctx.settings, 'PIPELINE_SYNC_COUNT') === 0
      ) {
        // Already 0 — no-op.
      } else if (readCounter(ctx.settings, 'PIPELINE_RESULT_COUNT') === 0) {
        setCounter(ctx.settings, 'PIPELINE_SYNC_COUNT', 0);
      }
      return { status: 'ok' };
    } catch (err) {
      return errResult(ctx, errorToMessage(err));
    }
  },
};

// ---------------------------------------------------------------------------
// \gdesc — describe the buffered query without executing it.
//
// The implementation lives in `./cmd_io.ts` (it shares the printer-routing
// machinery used by `\g` / `\gx` / `\watch`); we re-export the spec here
// so the existing pipeline test (which imports `cmdGdesc` from this
// module) continues to compile. Registration is left to `cmd_io.ts`'s
// `registerIoCommands` so we don't double-register.
// ---------------------------------------------------------------------------

export { cmdGdesc } from './cmd_io.js';

// ---------------------------------------------------------------------------
// Registration entry point.
// ---------------------------------------------------------------------------

export const registerPipelineCommands = (registry: BackslashRegistry): void => {
  registry.register(cmdBind);
  registry.register(cmdBindNamed);
  registry.register(cmdParse);
  registry.register(cmdClosePrepared);
  registry.register(cmdStartPipeline);
  registry.register(cmdEndPipeline);
  registry.register(cmdSyncPipeline);
  registry.register(cmdFlushRequest);
  registry.register(cmdFlush);
  registry.register(cmdSendPipeline);
  registry.register(cmdGetResults);
};
