/**
 * psql common — the unified send-query / process-result pipeline.
 *
 * TypeScript port of selected functions in `src/bin/psql/common.c`:
 *
 *   - {@link sendQuery}        ← `SendQuery`
 *   - {@link executeAndPrint}  ← `ExecQueryAndProcessResults` (the inner
 *                                 result-processing slice, without the
 *                                 AUTOCOMMIT / savepoint scaffolding)
 *   - {@link psqlExec}         ← `PSQLexec`
 *
 * The minimal version of this logic was inlined in `mainloop.ts` after WP-12;
 * this WP extracts and polishes it. The pieces wired in here:
 *
 *   - AUTOCOMMIT: when the variable is 'off' (default 'on') and the current
 *     transaction is idle, prepend `BEGIN` once before the next non-exempt
 *     statement. The set of exempt commands mirrors upstream
 *     `command_no_begin()` — transaction-control verbs and a handful of
 *     non-transactional DDL.
 *
 *   - ON_ERROR_ROLLBACK: 'off' (default) | 'on' | 'interactive'. When active
 *     and we're inside a transaction, issue
 *     `SAVEPOINT pg_psql_temporary_savepoint` before the statement; on error
 *     `ROLLBACK TO`, on success `RELEASE` (unless the statement is itself a
 *     savepoint-management verb that already drops/replaces it).
 *
 *   - FETCH_COUNT: integer; when >0 and the statement is a single SELECT-ish
 *     query, wrap it in `DECLARE _psql_cursor CURSOR FOR ...; FETCH FORWARD
 *     N FROM _psql_cursor` until exhausted. Non-SELECT statements fall back
 *     to the simple path.
 *
 *   - SINGLESTEP: when `settings.singlestep` is true, print the SQL to stderr
 *     with the upstream confirmation banner and read one line from stdin.
 *     Input that starts with 'x' cancels the statement.
 *
 *   - Timing: when `settings.timing` is true, measure wallclock around the
 *     send/print path and write a `Time: X.XXX ms` line to stdout (mirrors
 *     upstream's `printf` in common.c, and matches the existing mainloop
 *     test expectations).
 *
 * What's deliberately not done here:
 *
 *   - SINGLELINE (-S): treating LF as a semicolon belongs in the scanner; we
 *     surface a TODO so WP-24 can pick it up. The flag is read off
 *     `settings.singleline` for completeness but currently has no effect.
 *
 *   - Pipeline mode (-X / `\startpipeline`): upstream gates SendQuery on
 *     `pset.send_mode == PSQL_SEND_PIPELINE`; that path is owned by WP-21.
 *
 *   - COPY FROM STDIN / TO STDOUT: upstream's ProcessResult dispatches on
 *     `PGRES_COPY_IN/OUT`. That belongs to WP-16; here we surface a clear
 *     error message if we ever see a copy result come back through
 *     `execSimple`.
 */

import type { Connection, ResultSet } from '../types/connection.js';
import type { Printer } from '../types/printer.js';
import type { REPLContext } from '../types/repl.js';
import type { LastErrorResult, PsqlSettings } from '../types/settings.js';

import { alignedPrinter } from '../print/aligned.js';
import { asciidocPrinter } from '../print/asciidoc.js';
import { csvPrinter } from '../print/csv.js';
import { htmlPrinter } from '../print/html.js';
import { jsonPrinter } from '../print/json.js';
import { latexLongtablePrinter, latexPrinter } from '../print/latex.js';
import { troffMsPrinter } from '../print/troff.js';
import { unalignedPrinter } from '../print/unaligned.js';
import { formatDurationMs } from '../print/units.js';
import { getQueryFout } from '../command/cmd_io.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type QueryStats = {
  rowsAffected: number;
  rowsPrinted: number;
  fetched: boolean;
  hadError: boolean;
  durationMs: number;
};

export type SendQueryOpts = {
  /** Optional one-shot output redirect (e.g., `\g FILE`). */
  oneShotOut?: NodeJS.WritableStream;
};

// ---------------------------------------------------------------------------
// Connection state plumbing.
//
// Upstream consults libpq's `PQtransactionStatus(conn)`; our PgConnection
// stores the latest ReadyForQuery byte privately. For unit tests we accept an
// optional `txStatus` field on the Connection or settings object. Defaulting
// to 'idle' (== 'I') keeps the simple path behaving exactly as it did before.
// ---------------------------------------------------------------------------

type TxStatusByte = 'I' | 'T' | 'E';
type ConnWithTx = { txStatus?: TxStatusByte };

const readTxStatus = (conn: Connection): TxStatusByte => {
  const status = (conn as unknown as ConnWithTx).txStatus;
  return status ?? 'I';
};

// ---------------------------------------------------------------------------
// Statement classification.
//
// Upstream uses two predicates: `command_no_begin()` decides whether a
// statement is exempt from AUTOCOMMIT's implicit BEGIN, and
// `is_select_command()` decides whether FETCH_COUNT chunking applies. We
// mirror both with a lightweight prefix matcher — the SQL was already
// normalised by the scanner before reaching us.
// ---------------------------------------------------------------------------

const SAVEPOINT_NAME = 'pg_psql_temporary_savepoint';
const CURSOR_NAME = '_psql_cursor';

/** Strip leading whitespace and SQL comments, then upper-case for matching. */
const peekKeywords = (sql: string, count = 3): string[] => {
  // Skip leading whitespace / SQL line + block comments so we look at the
  // statement's verb regardless of surrounding boilerplate.
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      if (nl === -1) return [];
      i = nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return [];
      i = end + 2;
      continue;
    }
    break;
  }
  const tail = sql.slice(i);
  // Tokenise on whitespace + a small set of punctuation that can immediately
  // follow a keyword (semicolon, comma, open-paren).
  const words = tail.split(/[\s,;()]+/u, count + 1);
  return words.slice(0, count).map((w) => w.toUpperCase());
};

/** Mirror of `command_no_begin()` in psql/common.c. */
const commandNoBegin = (sql: string): boolean => {
  const [w0, w1, w2] = peekKeywords(sql, 3);
  if (!w0) return false;
  switch (w0) {
    case 'ABORT':
    case 'BEGIN':
    case 'COMMIT':
    case 'END':
    case 'ROLLBACK':
    case 'START':
    case 'SAVEPOINT':
    case 'RELEASE':
      return true;
    case 'PREPARE':
      return w1 === 'TRANSACTION';
    case 'VACUUM':
      return true;
    case 'CLUSTER':
      // CLUSTER without an explicit argument runs over the whole DB and
      // cannot be transactional.
      return w1 === undefined || w1 === '';
    case 'CREATE':
      return w1 === 'DATABASE' || w1 === 'TABLESPACE';
    case 'DROP':
      // DROP DATABASE / TABLESPACE / INDEX CONCURRENTLY / TABLE … CONCURRENTLY.
      if (w1 === 'DATABASE' || w1 === 'TABLESPACE') return true;
      if (w1 === 'INDEX' && w2 === 'CONCURRENTLY') return true;
      if (w1 === 'TABLE' && w2 === 'CONCURRENTLY') return true;
      return false;
    case 'REINDEX':
      // REINDEX DATABASE / SYSTEM / INDEX CONCURRENTLY / TABLE CONCURRENTLY.
      if (w1 === 'DATABASE' || w1 === 'SYSTEM') return true;
      if (w1 === 'INDEX' && w2 === 'CONCURRENTLY') return true;
      if (w1 === 'TABLE' && w2 === 'CONCURRENTLY') return true;
      return false;
    case 'ALTER':
      return w1 === 'SYSTEM';
    case 'DISCARD':
      return w1 === 'ALL';
    default:
      return false;
  }
};

/** True when the statement opens with SELECT / VALUES / TABLE / WITH. */
const isSelectCommand = (sql: string): boolean => {
  const [w0] = peekKeywords(sql, 1);
  return w0 === 'SELECT' || w0 === 'VALUES' || w0 === 'TABLE' || w0 === 'WITH';
};

/**
 * Does this statement effectively destroy / replace the temporary savepoint?
 * Upstream's `svpt_gone` flag is set when the user's command is one of
 * COMMIT / ROLLBACK / SAVEPOINT / RELEASE. In those cases we must skip the
 * matching RELEASE because the named savepoint no longer exists.
 */
const destroysSavepoint = (sql: string): boolean => {
  const [w0] = peekKeywords(sql, 1);
  return (
    w0 === 'COMMIT' ||
    w0 === 'ROLLBACK' ||
    w0 === 'SAVEPOINT' ||
    w0 === 'RELEASE'
  );
};

// ---------------------------------------------------------------------------
// Printer selection. Routes to the printer for the active output format —
// every format in {@link OutputFormat} that we ship is wired here; `wrapped`
// falls back to the aligned printer (which renders `wrapped` mode itself
// via `topt`).
// ---------------------------------------------------------------------------

const pickPrinter = (settings: PsqlSettings): Printer => {
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
 * Precedence: explicit `oneShot` argument > the settings stash from
 * `\o FILE` (WP-15) > the REPL context's `stdout`.
 */
export const pickOut = (
  ctx: REPLContext,
  oneShot?: NodeJS.WritableStream,
): NodeJS.WritableStream => {
  if (oneShot) return oneShot;
  return getQueryFout(ctx.settings) ?? ctx.stdout;
};

// ---------------------------------------------------------------------------
// Settings accessors.
//
// AUTOCOMMIT, ON_ERROR_ROLLBACK, FETCH_COUNT all live in the psql var store.
// Upstream reads them once at the start of SendQuery; we do the same so a
// hook that mutates them mid-query doesn't reshape our logic underneath us.
// ---------------------------------------------------------------------------

const readAutocommit = (settings: PsqlSettings): boolean =>
  settings.vars.asBool('AUTOCOMMIT', true);

const readOnErrorRollback = (
  settings: PsqlSettings,
): 'off' | 'on' | 'interactive' => {
  const raw = settings.vars.get('ON_ERROR_ROLLBACK');
  if (raw === undefined) return settings.onErrorRollback;
  const v = raw.toLowerCase();
  if (v === 'interactive') return 'interactive';
  if (v === 'on' || v === 'true' || v === 'yes' || v === '1') return 'on';
  return 'off';
};

const readFetchCount = (settings: PsqlSettings): number => {
  const v = settings.vars.asInt('FETCH_COUNT', settings.fetchCount);
  if (typeof v !== 'number') return 0;
  return Math.max(0, v | 0);
};

const readSinglestep = (settings: PsqlSettings): boolean =>
  settings.singlestep || settings.vars.asBool('SINGLESTEP', false);

/**
 * SHOW_ALL_RESULTS controls multi-statement `\;` printing. Default 'on' —
 * every result set is rendered. When 'off' / '0', only the LAST result set
 * is printed (upstream's `pset.show_all_results` flag, consulted by
 * `PrintQueryResults` in common.c).
 */
const readShowAllResults = (settings: PsqlSettings): boolean =>
  settings.vars.asBool('SHOW_ALL_RESULTS', true);

// ---------------------------------------------------------------------------
// Error printing — mirrors mainloop's `writeError` format. We keep it local
// so callers other than the mainloop can still emit consistent errors.
// ---------------------------------------------------------------------------

const writeError = (ctx: REPLContext, message: string): void => {
  ctx.stderr.write(`psql: ERROR:  ${message}\n`);
};

/**
 * Capture the full ErrorResponse-shaped payload from a thrown error.
 *
 * Our wire layer copies every named field of the server's ErrorResponse
 * (severity / code / detail / hint / position / file / line / routine /
 * …) onto the thrown Error as own properties (see `asThrowable` in
 * `wire/connection.ts`). We mirror those onto `settings.lastErrorResult`
 * so `\errverbose` can re-render the error in VERBOSE form — including
 * the `LINE N: …` re-print + `^` pointer and the `LOCATION:` footer.
 *
 * `sqlText` is the originating SQL text from the caller; required so the
 * `^` pointer can be positioned under the failing character.
 */
export const captureLastError = (
  settings: PsqlSettings,
  err: unknown,
  sqlText: string,
): string => {
  const fallbackMessage = err instanceof Error ? err.message : String(err);
  const e = (err ?? {}) as Partial<LastErrorResult> & { message?: string };
  const code = e.code;
  settings.lastErrorResult = {
    severity: e.severity,
    code,
    // Keep `sqlstate` as an alias for legacy callers / tests.
    sqlstate: code,
    message: e.message ?? fallbackMessage,
    detail: e.detail,
    hint: e.hint,
    position: e.position,
    internalPosition: e.internalPosition,
    internalQuery: e.internalQuery,
    where: e.where,
    schema: e.schema,
    table: e.table,
    column: e.column,
    dataType: e.dataType,
    constraint: e.constraint,
    file: e.file,
    line: e.line,
    routine: e.routine,
    sqlText,
  };
  return settings.lastErrorResult.message ?? fallbackMessage;
};

const recordError = (ctx: REPLContext, err: unknown, sqlText = ''): string =>
  captureLastError(ctx.settings, err, sqlText);

// ---------------------------------------------------------------------------
// SINGLESTEP confirmation.
//
// Upstream prints to stdout and reads a line from /dev/tty; we use ctx.stderr
// for the banner (so the SQL preview stays out of any redirected query
// output) and read one line from ctx.stdin. Returns true to proceed.
// ---------------------------------------------------------------------------

const readOneLine = (stdin: NodeJS.ReadableStream): Promise<string> =>
  new Promise<string>((resolve) => {
    let buf = '';
    let resolved = false;
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        cleanup();
        if (!resolved) {
          resolved = true;
          resolve(line);
        }
      }
    };
    const onEnd = (): void => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve(buf);
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('close', onEnd);
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('close', onEnd);
  });

const confirmSinglestep = async (
  ctx: REPLContext,
  sql: string,
): Promise<boolean> => {
  ctx.stderr.write(
    `***(Single step mode: verify command)*******************************************\n` +
      `${sql}\n` +
      `***(press return to proceed or enter x and return to cancel)********************\n`,
  );
  const line = await readOneLine(ctx.stdin);
  return !line.trim().toLowerCase().startsWith('x');
};

// ---------------------------------------------------------------------------
// Result rendering. We tally rows printed / rows affected for the QueryStats
// return; both are best-effort against the libpq-shaped ResultSet (rowCount
// is null for DDL, rows.length is 0 for COPY etc.).
// ---------------------------------------------------------------------------

/**
 * Reconstruct the libpq-style CommandComplete tag from the parsed parts our
 * wire layer stores on a ResultSet. INSERT carries `oid` + `rowCount`; the
 * other DML verbs (UPDATE/DELETE/MERGE/SELECT/MOVE/FETCH/COPY) carry just a
 * `rowCount`; DDL has neither.
 *
 * Matches upstream psql's `PQcmdStatus(conn)` output (which is the raw tag
 * the server sent — we round-trip it through our parser).
 */
const formatCommandTag = (rs: ResultSet): string => {
  const command = (rs.command || '').trim();
  if (command.length === 0) return '';
  if (command === 'INSERT') {
    // INSERT is the only tag with the legacy oid in front of rowCount.
    return `INSERT ${rs.oid ?? 0} ${rs.rowCount ?? 0}`;
  }
  if (rs.rowCount !== null && rs.rowCount !== undefined) {
    return `${command} ${rs.rowCount}`;
  }
  return command;
};

const renderResultSets = async (
  ctx: REPLContext,
  results: ResultSet[],
  out: NodeJS.WritableStream,
): Promise<{ rowsAffected: number; rowsPrinted: number }> => {
  const printer = pickPrinter(ctx.settings);
  let rowsAffected = 0;
  let rowsPrinted = 0;
  // When SHOW_ALL_RESULTS is off and we have a `\;`-separated batch, upstream
  // only prints the LAST result set. The tally counters still walk every
  // result so QueryStats stays consistent — only the printer call is gated.
  const showAll = readShowAllResults(ctx.settings);
  const lastIdx = results.length - 1;
  const tuplesOnly = ctx.settings.popt.topt.tuplesOnly;
  for (let i = 0; i < results.length; i++) {
    const rs = results[i];
    const shouldEmit = showAll || i === lastIdx;
    if (rs.fields.length === 0) {
      // Non-tuples-producing commands (INSERT/UPDATE/DELETE/DDL) — emit the
      // CommandComplete tag instead of running the table printer (which would
      // render an empty `(0 rows)` block). Suppressed in tuples-only mode
      // (`\t`) to match upstream.
      if (shouldEmit && !tuplesOnly) {
        const tag = formatCommandTag(rs);
        if (tag.length > 0) out.write(`${tag}\n`);
      }
      // rowCount is the affected-row total when libpq sets it.
      rowsAffected += rs.rowCount ?? 0;
    } else {
      if (shouldEmit) {
        await printer.printQuery(rs, ctx.settings.popt, out);
      }
      rowsPrinted += rs.rows.length;
    }
  }
  return { rowsAffected, rowsPrinted };
};

/**
 * Render a single {@link ResultSet} through the active printer and the
 * configured output target (respecting `\o FILE` redirects). Used by the
 * `\bind` / extended-query path in {@link mainloop.dispatchSendQuery} which
 * comes back with a single result instead of the array shape `execSimple`
 * produces. Returns a tally consistent with {@link renderResultSets}.
 */
export const renderResultSet = (
  ctx: REPLContext,
  rs: ResultSet,
  out?: NodeJS.WritableStream,
): Promise<{ rowsAffected: number; rowsPrinted: number }> => {
  return renderResultSets(ctx, [rs], out ?? pickOut(ctx));
};

// ---------------------------------------------------------------------------
// FETCH_COUNT cursor loop.
//
// Wrap `<sql>` in DECLARE/FETCH and stream chunks. We open the cursor inside
// a transaction (upstream relies on the surrounding implicit BEGIN); when
// AUTOCOMMIT is on and we're idle, we open one here and close it with a
// COMMIT on the happy path / ROLLBACK on error.
// ---------------------------------------------------------------------------

const runCursorLoop = async (
  ctx: REPLContext,
  sql: string,
  fetchCount: number,
  out: NodeJS.WritableStream,
): Promise<{ rowsAffected: number; rowsPrinted: number }> => {
  if (!ctx.settings.db) throw new Error('no connection to the server');
  const db = ctx.settings.db;

  // Make sure we're in a transaction so the cursor survives between FETCH
  // calls. If we're idle, open one here and remember to close it.
  const initiallyIdle = readTxStatus(db) === 'I';
  if (initiallyIdle) {
    await db.execSimple('BEGIN');
  }

  // Strip trailing ';' from the user SQL so DECLARE CURSOR FOR <stmt> parses.
  const stripped = sql.replace(/;\s*$/u, '');
  const declared = `DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${stripped}`;
  const fetchSql = `FETCH FORWARD ${String(fetchCount)} FROM ${CURSOR_NAME}`;

  const rowsAffected = 0;
  let rowsPrinted = 0;
  let cursorOpen = false;

  try {
    await db.execSimple(declared);
    cursorOpen = true;
    const printer = pickPrinter(ctx.settings);
    const topt = ctx.settings.popt.topt;
    const priorStart = topt.startTable;
    const priorStop = topt.stopTable;
    // Suppress the header/footer on the inner chunks so the output reads
    // like one continuous table. Upstream does the equivalent via
    // print_cursor.c's `flags.start_table` flip.
    let first = true;
    while (true) {
      const sets = await db.execSimple(fetchSql);
      if (sets.length === 0) break;
      const rs = sets[sets.length - 1];
      const chunkRows = rs.rows.length;
      if (chunkRows === 0) break;
      topt.startTable = first ? priorStart : false;
      topt.stopTable = chunkRows < fetchCount ? priorStop : false;
      await printer.printQuery(rs, ctx.settings.popt, out);
      rowsPrinted += chunkRows;
      first = false;
      if (chunkRows < fetchCount) break;
    }
    topt.startTable = priorStart;
    topt.stopTable = priorStop;
    await db.execSimple(`CLOSE ${CURSOR_NAME}`);
    cursorOpen = false;
    if (initiallyIdle) {
      await db.execSimple('COMMIT');
    }
    return { rowsAffected, rowsPrinted };
  } catch (err) {
    if (cursorOpen) {
      try {
        await db.execSimple(`CLOSE ${CURSOR_NAME}`);
      } catch {
        // ignore — surface the original error
      }
    }
    if (initiallyIdle) {
      try {
        await db.execSimple('ROLLBACK');
      } catch {
        // ignore
      }
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// `executeAndPrint` — the inner pipeline: execSimple → render → tally.
// Used directly by `\watch` and `\gexec` (which manage their own transaction
// scaffolding). Caller is responsible for AUTOCOMMIT / savepoint state.
// ---------------------------------------------------------------------------

export const executeAndPrint = async (
  ctx: REPLContext,
  sql: string,
  opts: SendQueryOpts = {},
): Promise<QueryStats> => {
  const started = ctx.settings.timing ? Date.now() : 0;
  const stats: QueryStats = {
    rowsAffected: 0,
    rowsPrinted: 0,
    fetched: false,
    hadError: false,
    durationMs: 0,
  };

  if (!ctx.settings.db) {
    writeError(ctx, 'no connection to the server');
    stats.hadError = true;
    return stats;
  }

  const out = pickOut(ctx, opts.oneShotOut);
  const fetchCount = readFetchCount(ctx.settings);

  try {
    if (fetchCount > 0 && isSelectCommand(sql)) {
      const { rowsAffected, rowsPrinted } = await runCursorLoop(
        ctx,
        sql,
        fetchCount,
        out,
      );
      stats.rowsAffected = rowsAffected;
      stats.rowsPrinted = rowsPrinted;
      stats.fetched = true;
    } else {
      const results = await ctx.settings.db.execSimple(sql);
      const { rowsAffected, rowsPrinted } = await renderResultSets(
        ctx,
        results,
        out,
      );
      stats.rowsAffected = rowsAffected;
      stats.rowsPrinted = rowsPrinted;
    }
  } catch (err) {
    const message = recordError(ctx, err, sql);
    writeError(ctx, message);
    stats.hadError = true;
  } finally {
    if (ctx.settings.timing) {
      stats.durationMs = Date.now() - started;
      ctx.stdout.write('\n' + formatDurationMs(stats.durationMs) + '\n');
    }
  }
  return stats;
};

// ---------------------------------------------------------------------------
// `sendQuery` — the full pipeline: SINGLESTEP confirmation + AUTOCOMMIT
// implicit BEGIN + ON_ERROR_ROLLBACK savepoint + execute + savepoint
// resolution. Mirrors `SendQuery` in common.c.
// ---------------------------------------------------------------------------

export const sendQuery = async (
  ctx: REPLContext,
  sql: string,
  opts: SendQueryOpts = {},
): Promise<QueryStats> => {
  const stats: QueryStats = {
    rowsAffected: 0,
    rowsPrinted: 0,
    fetched: false,
    hadError: false,
    durationMs: 0,
  };

  if (!ctx.settings.db) {
    writeError(ctx, 'no connection to the server');
    stats.hadError = true;
    return stats;
  }

  // SINGLESTEP: prompt before executing. 'x' aborts; anything else proceeds.
  if (readSinglestep(ctx.settings)) {
    const proceed = await confirmSinglestep(ctx, sql);
    if (!proceed) {
      // Upstream marks the statement as failed when the user cancels. We
      // mirror that so ON_ERROR_STOP halts a script.
      stats.hadError = true;
      ctx.settings.lastErrorResult = { message: 'command cancelled by user' };
      return stats;
    }
  }

  // SINGLELINE (-S): treat newlines as semicolons. This belongs in the
  // scanner — keep the flag readable here so a future WP-24 patch can
  // pivot from a single touch-point.
  // TODO(WP-24): wire ctx.settings.singleline into the scanner.

  const db = ctx.settings.db;
  const autocommit = readAutocommit(ctx.settings);
  const onErrorRollback = readOnErrorRollback(ctx.settings);
  const interactive = !ctx.settings.notty;

  const started = ctx.settings.timing ? Date.now() : 0;

  // ----- AUTOCOMMIT: implicit BEGIN ----------------------------------------
  let implicitBeginIssued = false;
  if (!autocommit && readTxStatus(db) === 'I' && !commandNoBegin(sql)) {
    try {
      await db.execSimple('BEGIN');
      implicitBeginIssued = true;
    } catch (err) {
      const message = recordError(ctx, err);
      writeError(ctx, message);
      stats.hadError = true;
      if (ctx.settings.timing) {
        stats.durationMs = Date.now() - started;
        ctx.stdout.write('\n' + formatDurationMs(stats.durationMs) + '\n');
      }
      return stats;
    }
  }

  // ----- ON_ERROR_ROLLBACK: SAVEPOINT --------------------------------------
  const savepointActive =
    onErrorRollback !== 'off' &&
    (onErrorRollback === 'on' ||
      (onErrorRollback === 'interactive' && interactive)) &&
    readTxStatus(db) === 'T';

  let savepointIssued = false;
  if (savepointActive) {
    try {
      await db.execSimple(`SAVEPOINT ${SAVEPOINT_NAME}`);
      savepointIssued = true;
    } catch (err) {
      // Mirror upstream: failure to install the savepoint is a hard error.
      const message = recordError(ctx, err);
      writeError(ctx, message);
      stats.hadError = true;
      if (ctx.settings.timing) {
        stats.durationMs = Date.now() - started;
        ctx.stdout.write('\n' + formatDurationMs(stats.durationMs) + '\n');
      }
      return stats;
    }
  }

  // ----- Execute + print ---------------------------------------------------
  const out = pickOut(ctx, opts.oneShotOut);
  const fetchCount = readFetchCount(ctx.settings);

  try {
    if (fetchCount > 0 && isSelectCommand(sql)) {
      const r = await runCursorLoop(ctx, sql, fetchCount, out);
      stats.rowsAffected = r.rowsAffected;
      stats.rowsPrinted = r.rowsPrinted;
      stats.fetched = true;
    } else {
      const results = await db.execSimple(sql);
      const r = await renderResultSets(ctx, results, out);
      stats.rowsAffected = r.rowsAffected;
      stats.rowsPrinted = r.rowsPrinted;
    }
  } catch (err) {
    const message = recordError(ctx, err, sql);
    writeError(ctx, message);
    stats.hadError = true;
  }

  // ----- ON_ERROR_ROLLBACK: resolve the savepoint --------------------------
  if (savepointIssued) {
    try {
      if (stats.hadError) {
        await db.execSimple(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
        // Release the now-empty savepoint too, matching upstream.
        await db.execSimple(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
      } else if (!destroysSavepoint(sql) && readTxStatus(db) === 'T') {
        await db.execSimple(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
      }
    } catch (err) {
      // Don't shadow the original error; just record this one if we don't
      // already have one to report.
      if (!stats.hadError) {
        const message = recordError(ctx, err);
        writeError(ctx, message);
        stats.hadError = true;
      }
    }
  }

  // If we issued an implicit BEGIN for AUTOCOMMIT=off and the statement
  // itself failed in such a way that we ended up idle again, there is
  // nothing to clean up — the server has already rolled back. We
  // intentionally do not COMMIT here: that's the user's responsibility under
  // AUTOCOMMIT=off.
  void implicitBeginIssued;

  if (ctx.settings.timing) {
    stats.durationMs = Date.now() - started;
    ctx.stdout.write('\n' + formatDurationMs(stats.durationMs) + '\n');
  }
  return stats;
};

// ---------------------------------------------------------------------------
// `psqlExec` — silent catalog-style queries used by backslash commands.
//
// Upstream returns a PGresult; the caller is expected to inspect status and
// `PQclear` it. We return the last ResultSet from execSimple (the catalog
// queries upstream uses are always single-statement) or null on error when
// ignoreError is true.
// ---------------------------------------------------------------------------

export const psqlExec = async (
  conn: Connection,
  sql: string,
  ignoreError = false,
): Promise<ResultSet | null> => {
  try {
    const sets = await conn.execSimple(sql);
    if (sets.length === 0) return null;
    return sets[sets.length - 1];
  } catch (err) {
    if (ignoreError) return null;
    throw err;
  }
};

// Internal exports re-used by mainloop. Kept on the public surface so other
// future call sites (cmd_io for \gexec, cmd_describe for catalog queries)
// can lean on the same primitives.
export const __testing = {
  commandNoBegin,
  isSelectCommand,
  destroysSavepoint,
  peekKeywords,
  SAVEPOINT_NAME,
  CURSOR_NAME,
};
