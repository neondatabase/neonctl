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
  return { status: 'error' };
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

    const sql = ctx.queryBuf.trim();
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
