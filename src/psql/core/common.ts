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
 *   - SINGLELINE (-S): treating LF as a semicolon is a scanner concern, so it
 *     lives there — `scanSql` honours `ScanOptions.singleline` and the mainloop
 *     passes `settings.singleline` through on each pass. `sendQuery` itself
 *     needs no SINGLELINE branch; by the time a statement reaches here the
 *     scanner has already drawn the boundary.
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
import { openPager, shouldPage } from '../print/pager.js';
import { getQueryFout } from '../command/cmd_io.js';
import { formatErrorReport, psqlErrorPrefix } from '../command/cmd_meta.js';

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

/**
 * Strip leading whitespace and `--` line / slash-star block comments from
 * `sql`. Mirrors what upstream psql's scanner advances past before handing a
 * statement to `PQexec` — the server-reported error `position` is a 1-based
 * offset into THAT trimmed buffer, so the `LINE N:` re-print computed from
 * `count('\n')` in `sql.slice(0, position - 1)` aligns with vanilla output
 * only when the same leading prelude is stripped here too.
 *
 * Block comments support nested depths (PG extension). Embedded comments
 * mid-statement are intentionally NOT stripped — they participate in the
 * line count of the executing statement, same as upstream.
 *
 * Exported for cmd_io / cmd_pipeline so backslash commands that capture or
 * inspect `queryBuf` see the same shape that the wire and `lastQuery`
 * receive.
 */
export const stripLeadingCommentsAndWS = (sql: string): string => {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql.charCodeAt(i);
    // Whitespace per psql_scan: space, tab, CR, LF, form-feed, vertical-tab.
    if (
      c === 0x20 ||
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0d ||
      c === 0x0c ||
      c === 0x0b
    ) {
      i++;
      continue;
    }
    // `--` line comment: consume up to (but not including) the next \n.
    if (c === 0x2d && sql.charCodeAt(i + 1) === 0x2d) {
      i += 2;
      while (i < n && sql.charCodeAt(i) !== 0x0a) i++;
      continue;
    }
    // `/* … */` block comment with nested depth tracking.
    if (c === 0x2f && sql.charCodeAt(i + 1) === 0x2a) {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql.charCodeAt(i) === 0x2f && sql.charCodeAt(i + 1) === 0x2a) {
          depth++;
          i += 2;
        } else if (
          sql.charCodeAt(i) === 0x2a &&
          sql.charCodeAt(i + 1) === 0x2f
        ) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    break;
  }
  return i === 0 ? sql : sql.slice(i);
};

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
//
// `writeError` handles client-side diagnostics (e.g., "no connection to the
// server") that have no server-side ErrorResponse payload — we emit a single
// `psql: ERROR:  <msg>` line.
//
// `writeQueryError` is used after a thrown query error has been captured
// into `settings.lastErrorResult` by `recordError` / `captureLastError`. It
// dispatches through {@link formatErrorReport} so the verbosity and
// SHOW_CONTEXT settings decide whether to surface the SQLSTATE / LINE /
// caret / DETAIL / HINT / CONTEXT / LOCATION layers. Matches upstream
// psql's `pg_log_error` shape in `src/bin/psql/common.c`.
// ---------------------------------------------------------------------------

const writeError = (ctx: REPLContext, message: string): void => {
  ctx.stderr.write(`psql: ERROR:  ${message}\n`);
};

/**
 * Render the verbosity-aware error report for the most recently captured
 * query error and write it to `ctx.stderr`. The leading severity line gets
 * the same `psql:[<file>:<n>]:` diagnostic prefix that upstream's
 * `pg_log_pre_callback` prepends — matching the format the regression-
 * derived conformance suite expects (e.g. `psql:<stdin>:N: ERROR: ...`).
 * Subsequent layers (`LINE N: ...`, caret, `DETAIL: ...`, ...) follow on
 * their own lines per {@link formatErrorReport}, unprefixed, to match
 * libpq's `PQresultErrorMessage` output shape. When the captured error is
 * missing (defensive — callers should always pair this with a preceding
 * `recordError`) we fall back to the plain client-side {@link writeError}
 * form so we never swallow the message entirely.
 *
 * Exported so the bind-path in mainloop can share the renderer.
 */
export const writeQueryError = (
  ctx: REPLContext,
  fallbackMessage: string,
): void => {
  const e = ctx.settings.lastErrorResult;
  if (!e || (!e.message && !e.code && !e.sqlstate)) {
    writeError(ctx, fallbackMessage);
    return;
  }
  const lines = formatErrorReport(
    e,
    ctx.settings.verbosity,
    ctx.settings.showContext,
  );
  const prefix = psqlErrorPrefix(ctx.settings);
  const prefixed = [prefix + lines[0], ...lines.slice(1)];
  ctx.stderr.write(prefixed.join('\n') + '\n');
};

/**
 * Strip leading whitespace from a query and rebase a 1-based server position
 * to match. Mirrors upstream psql/mainloop.c's behaviour: a line containing
 * only a backslash command does not leave a `\n` in the query buffer, so the
 * subsequent SQL statement starts at "line 1" of its own context rather than
 * inheriting a blank line. Our mainloop doesn't perform that strip, so the
 * captured `sqlText` sometimes has a leading `\n` (e.g. after `\set
 * FETCH_COUNT 1\nSELECT error;`). Without this normalisation, `\errverbose`
 * would render `LINE 2: SELECT error;` where upstream renders `LINE 1: …`.
 *
 * Returns the trimmed text and the rebased position. If the rebased
 * position would land outside the trimmed text, it is dropped so the
 * formatter skips the `LINE`/caret block instead of mis-pointing.
 */
const normaliseSqlAndPosition = (
  sqlText: string,
  position: string | undefined,
): { sqlText: string; position: string | undefined } => {
  let leading = 0;
  while (leading < sqlText.length) {
    const ch = sqlText.charCodeAt(leading);
    // Match psql_scan's whitespace set: space, tab, CR, LF, form-feed.
    if (
      ch !== 0x20 &&
      ch !== 0x09 &&
      ch !== 0x0a &&
      ch !== 0x0d &&
      ch !== 0x0c
    ) {
      break;
    }
    leading++;
  }
  if (leading === 0) return { sqlText, position };

  const trimmed = sqlText.slice(leading);
  if (typeof position !== 'string') return { sqlText: trimmed, position };

  const original = parseInt(position, 10);
  if (!Number.isFinite(original) || original <= 0) {
    return { sqlText: trimmed, position };
  }
  const rebased = original - leading;
  if (rebased <= 0 || rebased > trimmed.length) {
    return { sqlText: trimmed, position: undefined };
  }
  return { sqlText: trimmed, position: String(rebased) };
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
 * `^` pointer can be positioned under the failing character. Leading
 * whitespace is stripped (and `position` is rebased) so the `LINE N`
 * counter reflects offsets within the user's statement rather than any
 * buffer noise carried over from prior backslash commands.
 */
export const captureLastError = (
  settings: PsqlSettings,
  err: unknown,
  sqlText: string,
): string => {
  const fallbackMessage = err instanceof Error ? err.message : String(err);
  const e = (err ?? {}) as Partial<LastErrorResult> & { message?: string };
  const code = e.code;
  const normalised = normaliseSqlAndPosition(sqlText, e.position);
  settings.lastErrorResult = {
    severity: e.severity,
    code,
    // Keep `sqlstate` as an alias for legacy callers / tests.
    sqlstate: code,
    message: e.message ?? fallbackMessage,
    detail: e.detail,
    hint: e.hint,
    position: normalised.position,
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
    sqlText: normalised.sqlText,
  };
  return settings.lastErrorResult.message ?? fallbackMessage;
};

const recordError = (ctx: REPLContext, err: unknown, sqlText = ''): string =>
  captureLastError(ctx.settings, err, sqlText);

/**
 * Update the per-statement diagnostic psql variables that upstream's
 * `SetResultVariables` / `SetErrorVariables` in `src/bin/psql/common.c`
 * maintains. Called after every dispatched statement (success and error
 * paths) so `\echo :LAST_ERROR_MESSAGE` and friends produce the same
 * values vanilla psql does.
 *
 *   - `SQLSTATE`         SQLSTATE of the *most recent* statement —
 *                        `"00000"` on success, the server-reported code
 *                        on error (defaults to `"XX000"` when missing).
 *   - `ERROR`            `"true"` if the most recent statement failed,
 *                        else `"false"`.
 *   - `ROW_COUNT`        affected/returned row count of the most recent
 *                        statement (from libpq's `PQcmdTuples`). `"0"`
 *                        on error.
 *   - `LAST_ERROR_*`     sticky — only mutated on error. Mirrors
 *                        upstream's "preserve until the next failure"
 *                        contract so a successful statement does not
 *                        clobber the prior error info.
 *
 * Exported so mainloop's bind / pipeline paths (which bypass {@link
 * sendQuery}) can share the same updater.
 */
export const refreshErrorVars = (
  settings: PsqlSettings,
  outcome: { kind: 'success'; rowCount?: number | null } | { kind: 'error' },
): void => {
  const { vars } = settings;
  if (outcome.kind === 'error') {
    const last = settings.lastErrorResult;
    const code = last?.code ?? last?.sqlstate ?? 'XX000';
    const message = last?.message ?? '';
    vars.set('LAST_ERROR_MESSAGE', message);
    vars.set('LAST_ERROR_SQLSTATE', code);
    vars.set('SQLSTATE', code);
    vars.set('ERROR', 'true');
    vars.set('ROW_COUNT', '0');
    return;
  }
  vars.set('SQLSTATE', '00000');
  vars.set('ERROR', 'false');
  const rc = outcome.rowCount ?? 0;
  vars.set('ROW_COUNT', String(rc));
};

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

/**
 * Decide whether the pager should activate for the given batch of result
 * sets. We page when ANY of the sets-that-will-be-printed (i.e. tuples-
 * producing, and not gated out by SHOW_ALL_RESULTS) crosses the threshold.
 * The decision is centralised here so callers can override individual
 * decision inputs (e.g. tests that inject a fake `output`).
 */
const pickPagerDecision = (
  ctx: REPLContext,
  results: ResultSet[],
  out: NodeJS.WritableStream,
): boolean => {
  const popt = ctx.settings.popt.topt;
  // Pager off → never page (cheap exit, no looping needed).
  if (popt.pager === 'off') return false;
  // `\o FILE` (or `\g FILE`) wins over pager. If the queryFout is set, the
  // pager must not activate even when popt.pager === 'always'.
  const redirectedOutput = getQueryFout(ctx.settings) !== null;
  if (redirectedOutput) return false;

  const showAll = readShowAllResults(ctx.settings);
  const lastIdx = results.length - 1;
  for (let i = 0; i < results.length; i++) {
    const rs = results[i];
    if (rs.fields.length === 0) continue;
    if (!(showAll || i === lastIdx)) continue;
    const decision = shouldPage({
      pager: popt.pager,
      pagerMinLines: popt.pagerMinLines,
      rowCount: rs.rows.length,
      colCount: rs.fields.length,
      output: out,
      redirectedOutput,
    });
    if (decision) return true;
  }
  return false;
};

const renderResultSets = async (
  ctx: REPLContext,
  results: ResultSet[],
  out: NodeJS.WritableStream,
): Promise<{
  rowsAffected: number;
  rowsPrinted: number;
  lastRowCount: number | null;
}> => {
  const printer = pickPrinter(ctx.settings);
  let rowsAffected = 0;
  let rowsPrinted = 0;
  // When SHOW_ALL_RESULTS is off and we have a `\;`-separated batch, upstream
  // only prints the LAST result set. The tally counters still walk every
  // result so QueryStats stays consistent — only the printer call is gated.
  const showAll = readShowAllResults(ctx.settings);
  const lastIdx = results.length - 1;
  const tuplesOnly = ctx.settings.popt.topt.tuplesOnly;

  // Pager wrapping. If the active topt.pager + heuristics call for it, route
  // the printer through a spawned pager (PAGER / PSQL_PAGER, default `less`
  // on POSIX). The pager is opened ONCE per renderResultSets call so a `\;`
  // batch ends up in a single pager session, matching upstream. SIGPIPE /
  // EPIPE handling lives inside the pager module.
  const wantPager = pickPagerDecision(ctx, results, out);
  const pager = wantPager
    ? openPager({
        pager: ctx.settings.popt.topt.pager,
        pagerMinLines: ctx.settings.popt.topt.pagerMinLines,
        stdout: out,
        // shouldPage already verified pager-on conditions; force-spawn at
        // the openPager level by re-passing the topt setting.
      })
    : null;
  const sink: NodeJS.WritableStream = pager?.spawned ? pager.out : out;

  try {
    for (let i = 0; i < results.length; i++) {
      const rs = results[i];
      const shouldEmit = showAll || i === lastIdx;
      if (rs.copyOutBytes && rs.copyOutBytes.length > 0) {
        // `COPY ... TO STDOUT` segment of a `\;`-chained batch — emit the
        // accumulated CopyData payloads at the result's position in the
        // chain (upstream `handleCopyOut` writes the bytes to
        // `pset.queryFout`, which under a normal dispatch is the active
        // stdout). Render unconditionally regardless of SHOW_ALL_RESULTS:
        // upstream gates `\;`-chain row tables on `show_all_results`, but
        // the COPY data flows directly to the output stream and is not
        // affected by the flag. Matches the regress baseline ordering for
        // `... \; COPY x TO STDOUT \; ...`.
        for (const chunk of rs.copyOutBytes) {
          sink.write(chunk);
        }
      }
      if (rs.fields.length === 0) {
        // Non-tuples-producing commands (INSERT/UPDATE/DELETE/DDL) — emit the
        // CommandComplete tag instead of running the table printer (which
        // would render an empty `(0 rows)` block). Suppressed in tuples-only
        // mode (`\t`) and in `--quiet` mode to match upstream
        // (PSQLexec calls SetResultVariables which only prints the tag
        // when !pset.quiet). Also suppressed when the result represents a
        // COPY-out segment whose bytes we already streamed above —
        // upstream's `handleCopyOut` doesn't emit the `COPY N` tag on the
        // queryFout stream; the tag goes to the status stream which we
        // route through the diagnostic vars rather than stdout.
        if (
          shouldEmit &&
          !tuplesOnly &&
          !ctx.settings.quiet &&
          !rs.copyOutBytes
        ) {
          const tag = formatCommandTag(rs);
          if (tag.length > 0) sink.write(`${tag}\n`);
        }
        // rowCount is the affected-row total when libpq sets it.
        rowsAffected += rs.rowCount ?? 0;
      } else {
        if (shouldEmit) {
          await printer.printQuery(rs, ctx.settings.popt, sink);
        }
        rowsPrinted += rs.rows.length;
      }
    }
  } finally {
    if (pager?.spawned) {
      // End the pager stdin and wait for it to exit. We swallow errors here:
      // the user may have closed the pager early (SIGPIPE → EPIPE) and our
      // callers should not see that as a query failure.
      try {
        await pager.close();
      } catch {
        // ignore
      }
    }
  }
  // libpq's `PQcmdTuples(lastResult)` semantic: ROW_COUNT mirrors the LAST
  // result set's affected-row count (or returned-row count for tuples-
  // producing commands). For SELECT-shaped results the wire layer doesn't
  // populate rs.rowCount until CommandComplete arrives, but the array shape
  // (`rs.rows.length`) is the authoritative count.
  const lastRowCount =
    results.length === 0
      ? null
      : (() => {
          const rs = results[results.length - 1];
          if (rs.fields.length > 0) return rs.rows.length;
          return rs.rowCount ?? null;
        })();
  return { rowsAffected, rowsPrinted, lastRowCount };
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
): Promise<{
  rowsAffected: number;
  rowsPrinted: number;
  lastRowCount: number | null;
}> => {
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

/**
 * Re-base a server-side `position` field so it points into the user's
 * original SQL rather than the synthetic statement we actually sent.
 *
 * The FETCH_COUNT path sends `DECLARE _psql_cursor NO SCROLL CURSOR FOR
 * <userSql>` for the DECLARE leg and `FETCH FORWARD N FROM _psql_cursor`
 * for each fetch. Server error positions (`P` field) come back in the
 * coordinates of whatever query we sent:
 *
 *   - DECLARE-time parser/planner errors carry a position into the DECLARE
 *     statement. We subtract the length of the prefix (`DECLARE … FOR `)
 *     so the caret lands under the failing token in `userSql`.
 *
 *   - FETCH-time runtime errors come from executing the cursor's underlying
 *     query (which IS `userSql`). The server reports the position relative
 *     to that underlying query, so it's already in `userSql` coordinates
 *     and we leave it alone.
 *
 * If we can't rebase a DECLARE-coord position into `userSql` bounds, we
 * strip it rather than render a caret pointing past end-of-line.
 */
const rebasePositionForCursor = (
  err: unknown,
  wrapper: string,
  userSql: string,
): void => {
  if (!err || typeof err !== 'object') return;
  const e = err as { position?: string };
  if (typeof e.position !== 'string') return;
  const original = parseInt(e.position, 10);
  if (!Number.isFinite(original) || original <= 0) return;

  // Find the user's SQL inside the wrapper. If the wrapper *contains* the
  // user's SQL verbatim (the DECLARE case), the prefix length tells us how
  // far to shift. The trailing `;` is stripped before wrapping, so we
  // search for the stripped form.
  const stripped = userSql.replace(/;\s*$/u, '');
  const offset = wrapper.indexOf(stripped);
  if (offset === -1) {
    // FETCH-leg failures: the wrapper is `FETCH FORWARD …` and the server
    // reports the position relative to the cursor's underlying query
    // (i.e. `userSql`), not the FETCH text. Leave the position alone —
    // assuming it's already in user-sql coordinates is the right call,
    // and if it isn't, the LINE/caret renderer clamps gracefully.
    return;
  }

  const rebased = original - offset;
  if (rebased <= 0 || rebased > userSql.length) {
    // Position points outside the user's SQL — likely the parser blamed
    // something inside the wrapper. Drop the field so the formatter skips
    // the `LINE`/caret block instead of mis-pointing.
    delete e.position;
    return;
  }
  e.position = String(rebased);
};

const runCursorLoop = async (
  ctx: REPLContext,
  sql: string,
  fetchCount: number,
  out: NodeJS.WritableStream,
): Promise<{
  rowsAffected: number;
  rowsPrinted: number;
  lastRowCount: number;
}> => {
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
  // Track which synthetic statement is currently running so the catch block
  // can rebase the server-side `position` into the user's SQL coordinates
  // before throwing. Without this, `\errverbose` renders `LINE 1: <user-sql>`
  // with the caret pointing past end-of-line.
  let currentWrapper = declared;

  const printer = pickPrinter(ctx.settings);
  // Upstream's print_cursor.c walks the cursor in chunks and toggles libpq's
  // `flag.start_table` / `flag.stop_table` so the table renders as one
  // continuous block — header on the first chunk, footer on the last. Our
  // `aligned` printer doesn't (yet) honour those toggles, so we merge every
  // chunk into a single synthetic ResultSet and hand it to the printer once.
  // The user-facing output is identical to the non-chunked path, which is
  // what the regress baseline expects (one `(19 rows)` footer instead of
  // `(10 rows)` + `(9 rows)`).
  let merged: ResultSet | null = null;
  try {
    await db.execSimple(declared);
    cursorOpen = true;
    while (true) {
      currentWrapper = fetchSql;
      const sets = await db.execSimple(fetchSql);
      if (sets.length === 0) break;
      const rs = sets[sets.length - 1];
      const chunkRows = rs.rows.length;
      if (chunkRows === 0) break;
      if (merged === null) {
        merged = {
          command: rs.command,
          fields: rs.fields,
          rows: rs.rows.slice(),
          rowCount: rs.rowCount,
          oid: rs.oid,
          notices: rs.notices,
        };
      } else {
        for (const row of rs.rows) merged.rows.push(row);
      }
      rowsPrinted += chunkRows;
      if (chunkRows < fetchCount) break;
    }
    if (merged !== null) {
      // Patch the merged rowCount to reflect the actual aggregated row
      // total so command-tag / `(N rows)` footers match the upstream
      // single-statement output.
      merged.rowCount = merged.rows.length;
      await printer.printQuery(merged, ctx.settings.popt, out);
    }
    await db.execSimple(`CLOSE ${CURSOR_NAME}`);
    cursorOpen = false;
    if (initiallyIdle) {
      await db.execSimple('COMMIT');
    }
    return { rowsAffected, rowsPrinted, lastRowCount: rowsPrinted };
  } catch (err) {
    // Flush whatever chunks we successfully fetched before the error so the
    // partial output lands ahead of the ERROR line. Mirrors upstream
    // print_cursor.c: each chunk renders incrementally — when a later FETCH
    // raises (e.g. division by zero on row 16 of a 10-row chunked stream),
    // the first chunk's rows have already been printed. We accumulate into
    // a single merged ResultSet here, so the partial flush is "print the
    // merged buffer once, without the `(N rows)` footer the happy-path
    // emits when the cursor completes cleanly". The footer is suppressed
    // because the table is conceptually incomplete (upstream renders no
    // `(N rows)` for the truncated chunk either).
    if (merged !== null) {
      merged.rowCount = merged.rows.length;
      const partialOpts = {
        ...ctx.settings.popt,
        // `stopTable: false` mirrors upstream `print_cursor.c`'s
        // mid-error flush: no `(N rows)` auto-footer, no trailing
        // blank — the ERROR line should land flush against the last
        // data row, not separated by an extra empty line.
        topt: {
          ...ctx.settings.popt.topt,
          defaultFooter: false,
          stopTable: false,
        },
      };
      try {
        await printer.printQuery(merged, partialOpts, out);
      } catch {
        // ignore — surface the original error
      }
    }
    // Rebase the server-reported `position` from the synthetic wrapper's
    // coordinates into the user's SQL coordinates in place. Server error
    // positions come back relative to whatever statement we sent (DECLARE
    // `… FOR <user-sql>` or FETCH FORWARD `…`). Without this rewrite, the
    // caller's `recordError(ctx, err, sql)` would stash a position that
    // points past the end of `sql`, and `\errverbose` would render
    // `LINE 1: <user-sql>` with the `^` caret in the wrong column.
    rebasePositionForCursor(err, currentWrapper, sql);
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
  sqlRaw: string,
  opts: SendQueryOpts = {},
): Promise<QueryStats> => {
  // Strip leading whitespace + `--` line / slash-star block comments before
  // the wire send so server-reported `position` (1-based offset) and
  // `LINE N:` re-prints align with upstream — vanilla psql's scanner
  // advances past the same prelude before handing the buffer to `PQexec`.
  const sql = stripLeadingCommentsAndWS(sqlRaw);
  const started = ctx.settings.timing ? performance.now() : 0;
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

  let lastRowCount: number | null = null;
  try {
    if (fetchCount > 0 && isSelectCommand(sql)) {
      const r = await runCursorLoop(ctx, sql, fetchCount, out);
      stats.rowsAffected = r.rowsAffected;
      stats.rowsPrinted = r.rowsPrinted;
      stats.fetched = true;
      lastRowCount = r.lastRowCount;
    } else {
      const results = await ctx.settings.db.execSimple(sql);
      const r = await renderResultSets(ctx, results, out);
      stats.rowsAffected = r.rowsAffected;
      stats.rowsPrinted = r.rowsPrinted;
      lastRowCount = r.lastRowCount;
    }
  } catch (err) {
    // `\;`-chained batches surface every result the server produced before
    // the ErrorResponse on the thrown Error's `partialResults` field (set
    // by the wire layer's ReadyForQuery handler). Render them in order
    // before printing the error itself so the user sees the same shape
    // upstream `PQgetResult` walks produce.
    const partial = (err as Error & { partialResults?: ResultSet[] })
      .partialResults;
    if (partial && partial.length > 0) {
      try {
        const r = await renderResultSets(ctx, partial, out);
        stats.rowsAffected = r.rowsAffected;
        stats.rowsPrinted = r.rowsPrinted;
      } catch {
        // Surface the original error; don't shadow it with a render failure.
      }
    }
    const message = recordError(ctx, err, sql);
    writeQueryError(ctx, message);
    stats.hadError = true;
  } finally {
    if (ctx.settings.timing) {
      stats.durationMs = performance.now() - started;
      ctx.stdout.write('\n' + formatDurationMs(stats.durationMs) + '\n');
    }
  }
  // Mirror upstream's `SetResultVariables` / `SetErrorVariables` call at the
  // tail of `SendQuery`: refresh the per-statement diagnostic psql vars so
  // `\echo :SQLSTATE` and friends see the most recent outcome. ROW_COUNT
  // tracks libpq's `PQcmdTuples` on the LAST result of a `\;` batch.
  refreshErrorVars(
    ctx.settings,
    stats.hadError
      ? { kind: 'error' }
      : { kind: 'success', rowCount: lastRowCount },
  );
  return stats;
};

// ---------------------------------------------------------------------------
// `sendQuery` — the full pipeline: SINGLESTEP confirmation + AUTOCOMMIT
// implicit BEGIN + ON_ERROR_ROLLBACK savepoint + execute + savepoint
// resolution. Mirrors `SendQuery` in common.c.
// ---------------------------------------------------------------------------

export const sendQuery = async (
  ctx: REPLContext,
  sqlRaw: string,
  opts: SendQueryOpts = {},
): Promise<QueryStats> => {
  // Strip leading whitespace + `--` line / slash-star block comments before
  // the wire send AND before storing into `pset.last_query`. Vanilla psql's
  // scanner advances past the same prelude before handing the buffer to
  // `PQexec`, so server-reported `position` (1-based) and `LINE N:`
  // re-prints align with vanilla only after we trim here. `\p` (which falls
  // back to `lastQuery`) also prints the stripped form so the regress
  // baseline's `\p` after `-- comment\nSELECT 1;` emits just `SELECT 1;`.
  const sql = stripLeadingCommentsAndWS(sqlRaw);
  const stats: QueryStats = {
    rowsAffected: 0,
    rowsPrinted: 0,
    fetched: false,
    hadError: false,
    durationMs: 0,
  };

  // Track the most recent SQL we're about to ship so `\g` / `\gx` with an
  // empty buffer can re-run it (upstream `pset.last_query`). Capture even
  // if the dispatch fails — upstream populates `last_query` before
  // `PSQLexec` and leaves it set on error.
  ctx.settings.lastQuery = sql;

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

  // SINGLELINE (-S): treating a newline as a semicolon is a scanner concern
  // and is wired through `scanSql`'s `ScanOptions.singleline` (the mainloop
  // forwards `ctx.settings.singleline` on each pass). No work is required in
  // `sendQuery`: the statement boundary has already been drawn before we get
  // here.

  const db = ctx.settings.db;
  const autocommit = readAutocommit(ctx.settings);
  const onErrorRollback = readOnErrorRollback(ctx.settings);
  const interactive = !ctx.settings.notty;

  const started = ctx.settings.timing ? performance.now() : 0;

  // ----- AUTOCOMMIT: implicit BEGIN ----------------------------------------
  let implicitBeginIssued = false;
  if (!autocommit && readTxStatus(db) === 'I' && !commandNoBegin(sql)) {
    try {
      await db.execSimple('BEGIN');
      implicitBeginIssued = true;
    } catch (err) {
      const message = recordError(ctx, err);
      writeQueryError(ctx, message);
      stats.hadError = true;
      if (ctx.settings.timing) {
        stats.durationMs = performance.now() - started;
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
      writeQueryError(ctx, message);
      stats.hadError = true;
      if (ctx.settings.timing) {
        stats.durationMs = performance.now() - started;
        ctx.stdout.write('\n' + formatDurationMs(stats.durationMs) + '\n');
      }
      return stats;
    }
  }

  // ----- Execute + print ---------------------------------------------------
  const out = pickOut(ctx, opts.oneShotOut);
  const fetchCount = readFetchCount(ctx.settings);

  let lastRowCount: number | null = null;
  try {
    if (fetchCount > 0 && isSelectCommand(sql)) {
      const r = await runCursorLoop(ctx, sql, fetchCount, out);
      stats.rowsAffected = r.rowsAffected;
      stats.rowsPrinted = r.rowsPrinted;
      stats.fetched = true;
      lastRowCount = r.lastRowCount;
    } else {
      const results = await db.execSimple(sql);
      const r = await renderResultSets(ctx, results, out);
      stats.rowsAffected = r.rowsAffected;
      stats.rowsPrinted = r.rowsPrinted;
      lastRowCount = r.lastRowCount;
    }
  } catch (err) {
    // `\;`-chained batches surface every result the server produced before
    // the ErrorResponse on the thrown Error's `partialResults` field (set
    // by the wire layer's ReadyForQuery handler). Render them in order
    // before printing the error itself so the user sees the same shape
    // upstream `PQgetResult` walks produce.
    const partial = (err as Error & { partialResults?: ResultSet[] })
      .partialResults;
    if (partial && partial.length > 0) {
      try {
        const r = await renderResultSets(ctx, partial, out);
        stats.rowsAffected = r.rowsAffected;
        stats.rowsPrinted = r.rowsPrinted;
      } catch {
        // Surface the original error; don't shadow it with a render failure.
      }
    }
    const message = recordError(ctx, err, sql);
    writeQueryError(ctx, message);
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
        writeQueryError(ctx, message);
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

  // Mirror upstream `SendQuery` tail (common.c lines 1217-1218):
  //
  //   if (!OK && pset.echo == PSQL_ECHO_ERRORS)
  //     pg_log_info("STATEMENT:  %s", query);
  //
  // When ECHO=errors and the dispatch failed, emit a `STATEMENT:  <sql>`
  // line so the user can correlate the error with the input statement.
  // `pg_log_info` writes to stderr in upstream and strips one trailing
  // newline before tacking its own `\n` on the message — we mirror by
  // going through ctx.stderr and the explicit trim.
  if (stats.hadError && ctx.settings.echo === 'errors') {
    // Strip leading whitespace + `--`-style comments from queryBuf so the
    // STATEMENT echo matches upstream's shape. Upstream `psqlscan.l`'s
    // `{whitespace}` rule (which includes line comments) SUPPRESSES
    // queryBuf appends until non-whitespace content has been collected;
    // our scanner accumulates verbatim. The server still ignores the
    // leading noise for `LINE N:` counting, but the STATEMENT echo
    // re-prints the buffer as we hold it. Bring them in line by
    // stripping here. Also strip one trailing `\n` to match
    // `pg_log_info("STATEMENT:  %s", query)` (one-newline-strip +
    // explicit `\n` append).
    let stmt = sql;

    while (true) {
      const before = stmt.length;
      // Leading whitespace including form-feed (matches psqlscan's
      // {space} = [ \t\n\r\f]).
      stmt = stmt.replace(/^[ \t\n\r\f]+/, '');
      // Leading `--`-style line comment, up to (but not including) the
      // next newline. The trailing newline is then eaten by the next
      // whitespace pass.
      stmt = stmt.replace(/^--[^\n\r]*/, '');
      if (stmt.length === before) break;
    }
    if (stmt.endsWith('\n')) stmt = stmt.slice(0, -1);
    ctx.stderr.write(`STATEMENT:  ${stmt}\n`);
  }

  // Mirror upstream's `SetResultVariables` / `SetErrorVariables` call at the
  // tail of `SendQuery`. ROW_COUNT mirrors libpq's `PQcmdTuples` on the LAST
  // result of a `\;` batch; SQLSTATE / ERROR reset every statement; the
  // LAST_ERROR_* pair only changes on failure (sticky on success).
  refreshErrorVars(
    ctx.settings,
    stats.hadError
      ? { kind: 'error' }
      : { kind: 'success', rowCount: lastRowCount },
  );

  if (ctx.settings.timing) {
    stats.durationMs = performance.now() - started;
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
