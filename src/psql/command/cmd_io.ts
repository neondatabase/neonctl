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
import { promises as fsPromises, createWriteStream } from 'node:fs';
import * as path from 'node:path';

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

import { writeErr } from './shared.js';
import { enqueue as enqueueInput } from './inputQueue.js';

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
   * exit status (`exitCode`, `null` if the child died from a signal).
   * `\g | program` uses this so a non-zero exit propagates an error back
   * to the REPL, matching upstream `do_g` semantics. File targets resolve
   * with an object whose `exitCode` is omitted.
   */
  close: () => Promise<{ exitCode?: number | null }>;
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
  writeErr(`\\${ctx.cmdName}: ${message}\n`);
  return { status: 'error' };
};

/**
 * Open a writable destination for `\o` / `\w` / `\g FILE` / `\g |cmd`.
 *
 * `target` of the form `|cmd` spawns `sh -c cmd` and pipes to its stdin.
 * The returned closer waits for the child to exit and resolves to its
 * status so callers (`\g | program`) can propagate a non-zero exit.
 *
 * Any other string is treated as a file path; the file is truncated.
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
      close: () =>
        new Promise<{ exitCode: number | null }>((resolve) => {
          let settled = false;
          const finish = (code: number | null): void => {
            if (settled) return;
            settled = true;
            resolve({ exitCode: code });
          };
          child.once('close', (code) => {
            finish(code);
          });
          child.once('error', () => {
            // spawn failure or stdio glitch — treat as a non-zero exit so
            // \g sees a failure.
            finish(127);
          });
          // Half-close stdin so the child sees EOF and exits.
          if (!child.stdin.destroyed) {
            child.stdin.end();
          }
        }),
    };
  }
  const stream = createWriteStream(target, { encoding: 'utf8' });
  return {
    stream,
    close: () =>
      new Promise<Record<string, never>>((resolve, reject) => {
        stream.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve({});
        });
      }),
  };
};

/**
 * Render a `ResultSet` to the supplied writable stream using the aligned
 * printer with the settings' current `popt`.
 */
const renderResult = async (
  settings: PsqlSettings,
  rs: ResultSet,
  out: NodeJS.WritableStream,
): Promise<void> => {
  await alignedPrinter.printQuery(rs, settings.popt, out);
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

  // Stash for a future mainloop integration (the queue is the "real" hook;
  // execSimple below is the WP-15 stop-gap that lets tests demonstrate
  // end-to-end execution).
  enqueueInput(contents);

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
    try {
      const entry = openWriter(arg);
      await new Promise<void>((resolve, reject) => {
        entry.stream.write(ctx.queryBuf, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await entry.close();
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

const runGCore = async (
  ctx: BackslashContext,
  forceExpanded: boolean,
): Promise<BackslashResult> => {
  const sql = ctx.queryBuf.trim();
  const target = ctx.nextArg('filepipe');

  if (sql.length === 0) {
    // psql treats bare `\g` with an empty buffer as a no-op; the prior
    // command's last result is what's "re-run" in real psql. For our
    // purposes returning ok with an empty buf reset matches the visible
    // behaviour without state we don't have.
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
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }
  }

  const topt = ctx.settings.popt.topt;
  const priorExpanded = topt.expanded;
  if (forceExpanded) topt.expanded = 'on';

  let execError: string | null = null;
  try {
    const results = await ctx.settings.db.execSimple(sql);
    const out = pickOut(ctx.settings, oneShot?.stream ?? null);
    for (const rs of results) {
      await renderResult(ctx.settings, rs, out);
    }
  } catch (err) {
    execError = err instanceof Error ? err.message : String(err);
  } finally {
    if (forceExpanded) topt.expanded = priorExpanded;
  }

  // Close the one-shot writer regardless of execution success so any
  // partial output is flushed; capture the child's exit status (for the
  // pipe form) so a non-zero exit becomes our error.
  let pipeError: string | null = null;
  if (oneShot) {
    try {
      const result = await oneShot.close();
      const code = result.exitCode;
      if (code !== null && code !== undefined && code !== 0) {
        pipeError = `program exited with status ${String(code)}`;
      }
    } catch (err) {
      pipeError = err instanceof Error ? err.message : String(err);
    }
  }

  if (execError !== null) {
    return errResult(ctx, execError);
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
    const sql = ctx.queryBuf.trim();
    const prefix = ctx.nextArg('normal') ?? '';

    if (sql.length === 0) {
      return errResult(ctx, 'no query buffer');
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }

    let results: ResultSet[];
    try {
      results = await ctx.settings.db.execSimple(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }

    // Use the last result that returned rows. Upstream uses the most-recent
    // tuples-producing statement; results without a row descriptor (e.g.
    // pure DDL) are skipped.
    const tupled = results.filter((r) => r.fields.length > 0);
    if (tupled.length === 0) {
      return errResult(ctx, 'query did not return any rows');
    }
    const rs = tupled[tupled.length - 1];
    if (rs.rows.length > 1) {
      // Match upstream psql's exact wording from `exec_command_gset` —
      // `\gset: more than one row returned for \gset`. The wrapping
      // `errResult` prepends the `\gset:` prefix so we keep only the tail.
      return errResult(ctx, 'more than one row returned for \\gset');
    }
    if (rs.rows.length === 0) {
      return errResult(ctx, 'expected one row, got 0');
    }
    const row = rs.rows[0];
    for (let i = 0; i < rs.fields.length; i++) {
      const name = `${prefix}${rs.fields[i].name}`;
      const value = formatCell(row[i]);
      if (!ctx.settings.vars.set(name, value)) {
        return errResult(ctx, `invalid variable name "${name}"`);
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
    const sql = ctx.queryBuf.trim();
    if (sql.length === 0) {
      return errResult(ctx, 'no query buffer');
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }
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
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
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
    const sql = ctx.queryBuf.trim();
    if (sql.length === 0) {
      return errResult(ctx, 'no query buffer');
    }
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }

    let firstPass: ResultSet[];
    try {
      firstPass = await ctx.settings.db.execSimple(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }

    const tupled = firstPass.filter((r) => r.fields.length > 0);
    if (tupled.length === 0) {
      return { status: 'reset-buf', newBuf: '' };
    }

    const out = pickOut(ctx.settings, null);
    for (const rs of tupled) {
      for (const row of rs.rows) {
        for (const cell of row) {
          if (cell === null || cell === undefined) continue;
          const statement = formatCell(cell).trim();
          if (statement.length === 0) continue;
          try {
            const nested = await ctx.settings.db.execSimple(statement);
            for (const sub of nested) {
              if (sub.fields.length > 0) {
                await renderResult(ctx.settings, sub, out);
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.settings.lastErrorResult = { message: msg };
            writeErr(`\\${ctx.cmdName}: ${msg}\n`);
            return { status: 'error' };
          }
        }
      }
    }
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
 * `DEFAULT_WATCH_INTERVAL`.
 */
const DEFAULT_WATCH_INTERVAL = 2;

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
  const raw = settings.vars.get('WATCH_INTERVAL');
  if (raw === undefined) return { value: DEFAULT_WATCH_INTERVAL };
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
 * `PSQL_WATCH_PAGER` (falling back to `$PAGER`); every iteration writes
 * into the pager's stdin and the pager only exits when the loop ends.
 * We mirror that here with a single `sh -c <pager>` spawn — using the
 * shell lets the user set the variable to a full command string
 * (`less -R`, `tee /tmp/log`, …) without the caller having to tokenise
 * it. EPIPE on the stdin pipe is swallowed for the same reason as in
 * `openWriter`: the user may quit `less` while we still have writes
 * pending in the next iteration.
 *
 * Returns `null` when neither `PSQL_WATCH_PAGER` nor `PAGER` is set
 * (or both are whitespace-only — matching upstream's "no pager" rule),
 * so the caller can fall back to its normal output target.
 */
const openWatchPager = (): WatchPagerHandle | null => {
  const cmd = process.env.PSQL_WATCH_PAGER ?? process.env.PAGER ?? '';
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
    const sql = ctx.queryBuf.trim();
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
          if (parsed === null) {
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
          const msg = err instanceof Error ? err.message : String(err);
          ctx.settings.lastErrorResult = { message: msg };
          writeErr(`\\${ctx.cmdName}: ${msg}\n`);
          return { status: 'error' };
        }
        // Stop if `c=` reached the configured iteration cap, OR if `m=`
        // was set and the most-recent result satisfied the threshold.
        if (iterSet && iter >= iterMax) break;
        if (minRowsSet && lastRowCount >= minRows) break;
        if (controller.signal.aborted) break;
        await sleepCancellable(intervalMs, controller.signal);
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
  registry.register(cmdGset);
  registry.register(cmdGdesc);
  registry.register(cmdGexec);
  registry.register(cmdWatch);
};
