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
 *   - `\gdesc` would need the extended-query protocol (Parse + Describe
 *     without Execute). Our `Connection` interface stubs `prepare()` but
 *     mainloop hasn't adopted it yet; we error with a clear
 *     "extended protocol not available — TODO(WP-21)" message.
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
import type { ResultSet } from '../types/connection.js';

import { alignedPrinter } from '../print/aligned.js';

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
  /** Closer used by `\o` rebinds to drain the previous target. */
  close: () => Promise<void>;
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
 * Any other string is treated as a file path; the file is truncated.
 */
const openWriter = (target: string): QueryFoutEntry => {
  if (target.startsWith('|')) {
    const cmd = target.slice(1);
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    return {
      stream: child.stdin,
      close: async () => {
        child.stdin.end();
        await new Promise<void>((resolve) => {
          child.once('close', () => {
            resolve();
          });
          child.once('error', () => {
            resolve();
          });
        });
      },
    };
  }
  const stream = createWriteStream(target, { encoding: 'utf8' });
  return {
    stream,
    close: () =>
      new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
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

  try {
    const results = await ctx.settings.db.execSimple(sql);
    const out = pickOut(ctx.settings, oneShot?.stream ?? null);
    for (const rs of results) {
      await renderResult(ctx.settings, rs, out);
    }
    return { status: 'reset-buf', newBuf: '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errResult(ctx, msg);
  } finally {
    if (forceExpanded) topt.expanded = priorExpanded;
    if (oneShot) await oneShot.close();
  }
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
    if (rs.rows.length !== 1) {
      return errResult(ctx, `expected one row, got ${String(rs.rows.length)}`);
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
// Requires extended-query protocol (Parse + Describe-by-statement). The
// `Connection` interface exposes `prepare()` and `describe()`, but the
// surrounding plumbing for emitting a `ResultSet` shaped like psql's
// "Column / Type" listing belongs to WP-20/WP-21. We stub with a clear
// error message so callers know to wait.
// ---------------------------------------------------------------------------

export const cmdGdesc: BackslashCmdSpec = {
  name: 'gdesc',
  helpKey: 'gdesc',
  run: (ctx: BackslashContext): Promise<BackslashResult> =>
    Promise.resolve(
      errResult(ctx, 'extended protocol not available — TODO(WP-21)'),
    ),
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
// \watch [INTERVAL]
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

    const arg = ctx.nextArg('normal');
    let interval = 2;
    if (arg !== null && arg.length > 0) {
      const parsed = parseFloat(arg);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return errResult(ctx, `invalid watch interval "${arg}"`);
      }
      interval = parsed;
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

    const out = pickOut(ctx.settings, null);

    try {
      while (!controller.signal.aborted) {
        const stamp = new Date().toString().replace(/\sGMT.*$/, '');
        out.write(`${stamp} (every ${String(interval)}s)\n\n`);
        try {
          const results = await ctx.settings.db.execSimple(sql);
          for (const rs of results) {
            if (rs.fields.length > 0) {
              await renderResult(ctx.settings, rs, out);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.settings.lastErrorResult = { message: msg };
          writeErr(`\\${ctx.cmdName}: ${msg}\n`);
          return { status: 'error' };
        }
        if (controller.signal.aborted) break;
        await sleepCancellable(intervalMs, controller.signal);
      }
      return { status: 'reset-buf', newBuf: '' };
    } finally {
      if (installedSigint) {
        process.removeListener('SIGINT', sigintHandler);
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
