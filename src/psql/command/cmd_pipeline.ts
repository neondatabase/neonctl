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
  /** Promises returned by send-style commands; drained by `\getresults`. */
  pending: Promise<ResultSet | undefined>[];
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
// Helpers
// ---------------------------------------------------------------------------

const errResult = (ctx: BackslashContext, message: string): BackslashResult => {
  ctx.settings.lastErrorResult = { message };
  writeErr(`\\${ctx.cmdName}: ${message}\n`);
  // Tell mainloop the diagnostic is already on stderr so it doesn't add
  // a `psql: ERROR:  <msg>` fallback line.
  return { status: 'error', errorWritten: true };
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
    const sql = ctx.queryBuf.trim();
    if (sql.length === 0) {
      return errResult(ctx, 'no query buffer');
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
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
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
    if (getPipelineState(ctx.settings) !== null) {
      return Promise.resolve(errResult(ctx, 'pipeline already active'));
    }
    try {
      const session = ctx.settings.db.pipeline();
      stashOf(ctx.settings)[PIPELINE_KEY] = {
        session,
        pending: [],
      };
      ctx.settings.sendMode = 'extended-pipeline';
      return Promise.resolve({ status: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Promise.resolve(errResult(ctx, msg));
    }
  },
};

export const cmdEndPipeline: BackslashCmdSpec = {
  name: 'endpipeline',
  helpKey: 'endpipeline',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const ps = getPipelineState(ctx.settings);
    if (!ps) {
      return errResult(ctx, 'no pipeline active');
    }
    try {
      const sets = await ps.session.end();
      stashOf(ctx.settings)[PIPELINE_KEY] = undefined;
      ctx.settings.sendMode = 'extended-query';
      // Render each ResultSet through the active printer so the
      // pipeline's queued queries surface their output. Empty-result
      // sets (CREATE/INSERT/etc.) still go through so command tags
      // emit. Upstream's `\endpipeline` calls `ProcessResult` per
      // queued result in the same way.
      for (const rs of sets) {
        if (rs.fields.length > 0) {
          await alignedPrinter.printQuery(
            rs,
            ctx.settings.popt,
            process.stdout,
          );
        }
      }
      return { status: 'ok' };
    } catch (err) {
      stashOf(ctx.settings)[PIPELINE_KEY] = undefined;
      ctx.settings.sendMode = 'extended-query';
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
      return { status: 'ok' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
      return { status: 'ok' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
    if (!ps) return errResult(ctx, 'no pipeline active');
    const sql = ctx.queryBuf.trim();
    if (sql.length === 0) return errResult(ctx, 'no query buffer');

    const bind = consumeBindState(ctx.settings);
    const stmtName = bind?.name ?? '';
    const params = bind?.values ?? [];

    try {
      // We send the full P/B/E sequence without an intervening Sync — the
      // user is expected to call \syncpipeline or \endpipeline to commit.
      if (stmtName === '') {
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
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
    if (!ps) return errResult(ctx, 'no pipeline active');
    const arg = ctx.nextArg('normal');
    let n = ps.pending.length;
    if (arg !== null && arg.length > 0) {
      const parsed = parseInt(arg, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return errResult(ctx, `invalid count: ${arg}`);
      }
      n = Math.min(parsed, ps.pending.length);
    }
    const drained = ps.pending.splice(0, n);
    try {
      await Promise.all(drained);
      return { status: 'ok' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
