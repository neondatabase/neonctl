/**
 * Miscellaneous backslash commands (WP-22).
 *
 * Hosts commands that don't fit the meta / format / I/O / describe / pipeline
 * categories. For this WP that's only `\crosstabview`; future WPs hosting
 * standalone "do one thing" commands (e.g. `\dconfig`, `\sf+`, `\watch+`)
 * can land here without spinning up a new module per command.
 *
 * TODO: when adding new misc commands, register them in
 * {@link registerMiscCommands} and re-export the spec from this file so
 * tests can drive them in isolation.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { ResultSet } from '../types/connection.js';

import { type CrosstabOptions, printCrosstab } from '../print/crosstab.js';

import { writeErr } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errResult = (ctx: BackslashContext, message: string): BackslashResult => {
  ctx.settings.lastErrorResult = { message };
  writeErr(`\\${ctx.cmdName}: ${message}\n`);
  // Mark the diagnostic as already-emitted so the mainloop's fallback
  // does not double-print `psql: ERROR:  <msg>`. Matches the pattern
  // used by `cmd_io.ts::errResult` for the same reason. The conformance
  // expected output has one error line per failure, not two.
  return { status: 'error', errorWritten: true };
};

/**
 * Decode a slash arg into a `CrosstabOptions` value (name or 1-based index).
 *
 * Upstream `\crosstabview` accepts either form per arg; we keep that and
 * defer index/name disambiguation to `pivotResultSet` (which mirrors
 * upstream's `indexOfColumn`). Args that look like signed integers
 * (`/^[+-]?\d+$/`) are returned as numbers so the 4th arg's `+`/`-`
 * direction prefix flows through.
 */
const parseColRef = (raw: string): string | number => {
  const trimmed = raw.trim();
  if (/^[+-]?\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  return trimmed;
};

/**
 * Return `true` when `text` is just whitespace and SQL comments (no
 * executable statement). Our SQL scanner accumulates comments into
 * `queryBuf` verbatim so a line like `-- foo\n` followed by `\crosstabview`
 * leaves a non-empty buffer that nonetheless has nothing to send. This
 * mirrors upstream's `psql_scan_buffer_is_empty` heuristic used by
 * `do_crosstabview` / `\g`-family commands to decide whether to fall
 * back to `pset.last_query`.
 *
 * Strips `--` line comments and C-style block comments (with nesting),
 * leaves quoted-string content alone (so a comment-looking sequence inside
 * a string still counts as executable). If anything non-whitespace remains,
 * returns `false`.
 */
const isCommentOnly = (text: string): boolean => {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      // Skip to end-of-line.
      i += 2;
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      // Skip nested block comment (PG extends C-style comments with nesting).
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
          continue;
        }
        if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// \crosstabview [colV [colH [colD [sortColH]]]]
// ---------------------------------------------------------------------------

/**
 * Pop the most recent ResultSet from a possibly multi-statement execution.
 *
 * Upstream's `do_crosstabview` operates on the last PGresult of the prior
 * query (since `\crosstabview` is itself the trigger that submits the
 * buffered SQL). `execSimple` returns an array (one ResultSet per
 * statement); we take the last one — that's the result the user wants
 * pivoted.
 */
const lastTuplesResult = (results: ResultSet[]): ResultSet | null => {
  for (let i = results.length - 1; i >= 0; i--) {
    // Heuristic: a SELECT/VALUES/SHOW result will have fields populated;
    // a bare INSERT/UPDATE/DELETE without RETURNING will not. Upstream
    // just checks PGRES_TUPLES_OK; we approximate that with non-empty
    // fields, falling back to the last result if nothing matches.
    if (results[i].fields.length > 0) return results[i];
  }
  return results.length > 0 ? results[results.length - 1] : null;
};

export const cmdCrosstabview: BackslashCmdSpec = {
  name: 'crosstabview',
  helpKey: 'crosstabview',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    if (!ctx.settings.db) {
      return errResult(ctx, 'no connection to the server');
    }

    // Source SQL is the active query buffer; when that's effectively
    // empty (whitespace + comments only — the common shape after a
    // semicolon-terminated query followed by a trailing `-- comment`
    // line), fall back to `pset.last_query` which upstream re-executes
    // for both `\g`-family commands and `\crosstabview`.
    let sql = ctx.queryBuf.trim();
    if (sql.length === 0 || isCommentOnly(sql)) {
      sql = ctx.settings.lastQuery.trim();
    }
    if (sql.length === 0) {
      return errResult(ctx, 'no SQL command');
    }

    // Read up to four args from the slash arg stream. Each is optional;
    // missing args fall back to the pivot defaults (1, 2, 3, none).
    const args: (string | number | undefined)[] = [
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    for (let i = 0; i < 4; i++) {
      const a = ctx.nextArg('normal');
      if (a === null) break;
      args[i] = parseColRef(a);
    }

    let results: ResultSet[];
    try {
      results = await ctx.settings.db.execSimple(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult(ctx, msg);
    }

    const target = lastTuplesResult(results);
    if (!target) {
      return errResult(ctx, 'statement did not return a result set');
    }
    if (target.fields.length === 0) {
      return errResult(ctx, 'statement did not return a result set');
    }

    const opts: CrosstabOptions = {
      colV: args[0],
      colH: args[1],
      colD: args[2],
      sortColH: args[3],
    };

    const err = await printCrosstab(
      target,
      opts,
      ctx.settings.popt,
      process.stdout,
    );
    if (err) {
      return errResult(ctx, err.error);
    }

    return { status: 'reset-buf', newBuf: '' };
  },
};

/**
 * Register all misc commands on the supplied registry. Called from
 * `dispatch.ts::defaultRegistry()`.
 */
export const registerMiscCommands = (registry: BackslashRegistry): void => {
  registry.register(cmdCrosstabview);
};
