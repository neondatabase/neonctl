/**
 * psql `\d*` describe-command dispatchers.
 *
 * Each command takes an optional pattern, parses verbose / show-system
 * suffixes from the command name, runs the appropriate SQL template
 * from {@link '../describe/queries.js'} through the pattern parser, and
 * prints the result via the aligned printer.
 *
 * Command name suffix decoding:
 *
 *  - Trailing `+` → `verbose=true` (extra columns)
 *  - Trailing `S` → `showSystem=true` (include `pg_*` schemas)
 *  - Both may combine: `\dtS+`, `\dt+S`, etc.
 *
 * Dispatch model: every `\d*` family registers itself as a separate
 * primary name (e.g. `dt`, `dt+`, `dtS`, `dtS+`). That's not how psql
 * itself does it — psql parses a single `\d` token and then peels off
 * letter-by-letter — but our `BackslashRegistry` is keyed by full
 * command name and is much easier to read this way. The semantic
 * outcome is identical.
 *
 * For `\d <name>` (the bare describe), we look the relation up via
 * {@link lookupOneRelation} and dispatch to the right `describeOne*`
 * renderer based on relkind:
 *
 *  - 'r' / 'p' / 'f' (regular, partitioned, foreign) →
 *    {@link describeOneTableDetails}
 *  - 'v' → {@link describeOneViewDetails}
 *  - 'S' → {@link describeOneSequence}
 *  - 'i' / 'I' (index, partitioned index) → table-detail with index header
 *  - 'm' → table-detail with materialized-view header
 *
 * Connection guard: every command checks `ctx.settings.db` is non-null
 * and emits `\<cmd>: no current connection` to stderr on miss.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';

import {
  describeOneSequence,
  describeOneTableDetails,
  describeOneViewDetails,
  lookupOneRelation,
  runListQuery,
} from '../describe/formatters.js';
import {
  describeAccessMethods,
  describeAggregates,
  describeConfigurationParameters,
  describeFunctions,
  describeOperators,
  describeRoles,
  describeSubscriptions,
  describeTableDetails,
  describeTypes,
  listAllDbs,
  listCasts,
  listCollations,
  listConversions,
  listDbRoleSettings,
  listDefaultACLs,
  listDomains,
  listEventTriggers,
  listExtensions,
  listForeignDataWrappers,
  listForeignServers,
  listForeignTables,
  listLanguages,
  listLargeObjects,
  listOperatorClasses,
  listOperatorFamilies,
  listOpFamilyFunctions,
  listOpFamilyOperators,
  listPartitionedTables,
  listPublications,
  listSchemas,
  listTSConfigs,
  listTSDictionaries,
  listTSParsers,
  listTSTemplates,
  listTables,
  listUserMappings,
  objectDescription,
  permissionsList,
} from '../describe/queries.js';
import {
  processSQLNamePattern,
  type NamePatternResult,
} from '../describe/processNamePattern.js';

import { writeErr } from './shared.js';

/**
 * Helper: split a `\dXY+` command name into base, verbose, showSystem.
 *
 *   "dtS+"  → { base: "dt", verbose: true, showSystem: true }
 *   "df+"   → { base: "df", verbose: true, showSystem: false }
 *   "dnS"   → { base: "dn", verbose: false, showSystem: true }
 */
const decodeSuffix = (
  cmdName: string,
  base: string,
): { verbose: boolean; showSystem: boolean } => {
  const tail = cmdName.slice(base.length);
  let verbose = false;
  let showSystem = false;
  // Suffix order is unrestricted in psql.
  for (const ch of tail) {
    if (ch === '+') verbose = true;
    else if (ch === 'S') showSystem = true;
  }
  return { verbose, showSystem };
};

/** Resolve the current connection or null. */
const conn = (ctx: BackslashContext) => ctx.settings.db;

/** Emit "no current connection" error. */
const noConn = (ctx: BackslashContext): BackslashResult => {
  writeErr(`\\${ctx.cmdName}: no current connection\n`);
  return { status: 'error', errorWritten: true };
};

/**
 * Read the connection's current database. Mirrors upstream's
 * `PQdb(pset.db)` — used by the cross-database check. PgConnection
 * exposes `database` as a getter; mocks typically pass it as a record
 * property. Returns `''` on miss; callers compare case-sensitively
 * (matching upstream's `strcmp`).
 */
const currentDb = (c: import('../types/connection.js').Connection): string => {
  const meta = c as unknown as { database?: unknown };
  return typeof meta.database === 'string' ? meta.database : '';
};

/**
 * Validate a `processSQLNamePattern` result against the command's max
 * dotted-name budget. Mirrors the dot-count check upstream's
 * `processSQLNamePattern` performs after parsing:
 *
 *  - `dotCount > maxDots` → "improper qualified name (too many dotted names)"
 *  - `dotCount == 2 && maxDots == 2 && dbLiteral != current_db` →
 *    "cross-database references are not implemented"
 *
 * Pass `maxDots = 0` for commands that don't accept schema-qualified
 * patterns (`\dA`, `\dx`, `\dn`, `\db`, `\des`, …). Pass `maxDots = 2`
 * for the schema-qualified-with-db family (`\dt`, `\df`, `\dD`, …) so
 * the 2-dot case emits the dedicated cross-database error rather than
 * a generic "too many" message.
 *
 * Returns `null` on success; the formatted error string otherwise.
 */
const validatePattern = (
  pattern: string | null,
  result: NamePatternResult,
  maxDots: number,
  curDb: string,
): string | null => {
  if (pattern === null) return null;
  if (result.dotCount > maxDots) {
    return `improper qualified name (too many dotted names): ${pattern}`;
  }
  if (
    maxDots >= 1 &&
    result.dotCount === maxDots &&
    result.dbLiteral !== null &&
    result.dbLiteral !== curDb
  ) {
    return `cross-database references are not implemented: ${pattern}`;
  }
  return null;
};

/**
 * Run a query that fetches a single (typically pattern-filtered) result
 * set and prints it. Resolves the pattern with default settings:
 *
 *   - `n.nspname` as schemavar (where the SQL exposes that column)
 *   - the most common namevar slot per command
 *   - visibility check via `pg_*_is_visible` when relevant
 *
 * Callers pass a pre-built query and the (oid-free) name pattern.
 *
 * `maxDots` constrains the dotted-component budget (see
 * {@link validatePattern}); defaults to 2 (the standard schema-qualified
 * pattern). Commands accepting only single-component patterns pass `0`.
 */
const runWithPattern = async (
  ctx: BackslashContext,
  pattern: string | null,
  query: import('../describe/queries.js').DescribeQuery,
  patternOpts: Omit<Parameters<typeof processSQLNamePattern>[0], 'pattern'>,
  maxDots = 2,
): Promise<BackslashResult> => {
  const c = conn(ctx);
  if (!c) return noConn(ctx);
  const result = processSQLNamePattern({ ...patternOpts, pattern });
  const dotErr = validatePattern(pattern, result, maxDots, currentDb(c));
  if (dotErr !== null) {
    writeErr(`${dotErr}\n`);
    return { status: 'error', errorWritten: true };
  }
  try {
    await runListQuery(c, query, result, process.stdout, ctx.settings.popt);
    return { status: 'ok' };
  } catch (err) {
    writeErr(`\\${ctx.cmdName}: ${errMsg(err)}\n`);
    return { status: 'error', errorWritten: true };
  }
};

/**
 * Apply two distinct {@link NamePatternResult}s to a query that emits two
 * placeholder occurrences (one per pattern). Mirrors `applyPattern` but
 * threads each result into a single occurrence so they can carry
 * different column targets (e.g. `\dAc <am> <type>` filters
 * `am.amname` first and `t.typname` second). When a slot's result
 * carries no conditions we substitute the `true` tautology so the
 * surrounding `AND`/`WHERE` chain stays well-formed.
 *
 * Returns a query string with the placeholders replaced and a unified
 * parameter list renumbered so `$N` references stay distinct.
 */
const applyTwoPatterns = (
  sql: string,
  baseParams: unknown[],
  results: NamePatternResult[],
): { sql: string; params: unknown[] } => {
  const placeholder = 'true /* TODO(WP-20): pattern matching */';
  let rendered = sql;
  const params = [...baseParams];
  for (const result of results) {
    const idx = rendered.indexOf(placeholder);
    if (idx < 0) break;
    const conds = [
      ...result.schemaConditions,
      ...result.nameConditions,
      ...result.visibilityConditions,
    ];
    const slotOffset = params.length;
    const renumbered = conds.map((c) =>
      c.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + slotOffset}`),
    );
    params.push(...result.params);
    const replacement =
      renumbered.length === 0 ? 'true' : `(${renumbered.join(' AND ')})`;
    rendered =
      rendered.slice(0, idx) +
      replacement +
      rendered.slice(idx + placeholder.length);
  }
  return { sql: rendered, params };
};

/**
 * Run a list query with two distinct pattern slots. Builds the final
 * SQL via {@link applyTwoPatterns}, hands it to {@link runListQuery}
 * with an empty pattern result (so the second-pass `applyPattern` is a
 * no-op — all placeholders are already resolved).
 *
 * Note: we discard the query builder's `params` because the two-pattern
 * builders (`listOperatorClasses`, `listDbRoleSettings`) emit the raw
 * user strings there as a courtesy for single-pattern callers. The
 * regex-converted values come from `results[*].params` instead, so
 * threading the originals would introduce unreferenced bind values.
 */
const runDualPatternList = async (
  ctx: BackslashContext,
  query: import('../describe/queries.js').DescribeQuery,
  results: NamePatternResult[],
): Promise<BackslashResult> => {
  const c = conn(ctx);
  if (!c) return noConn(ctx);
  const { sql, params } = applyTwoPatterns(query.sql, [], results);
  const finalQuery: import('../describe/queries.js').DescribeQuery = {
    ...query,
    sql,
    params,
  };
  const empty: NamePatternResult = {
    schemaConditions: [],
    nameConditions: [],
    visibilityConditions: [],
    params: [],
    dotCount: 0,
    dbLiteral: null,
  };
  try {
    await runListQuery(c, finalQuery, empty, process.stdout, ctx.settings.popt);
    return { status: 'ok' };
  } catch (err) {
    writeErr(`\\${ctx.cmdName}: ${errMsg(err)}\n`);
    return { status: 'error', errorWritten: true };
  }
};

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// ===========================================================================
// Individual command specs
// ===========================================================================

// ---- \d / \d <name> / \dt / \di / \dv / \dm / \ds / \dE -------------------

/** Bare `\d [pattern]` — list-or-detail. */
const makeDescribeCmd = (baseName: string): BackslashCmdSpec => ({
  name: baseName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(ctx.cmdName, baseName);

    // If pattern looks like a single concrete name (no wildcards),
    // try a per-relation detail; otherwise list.
    if (pattern && !/[*?]/.test(pattern)) {
      // Split schema.name if dotted.
      let schemaPattern: string | null = null;
      let namePattern = pattern;
      const dot = pattern.indexOf('.');
      if (dot >= 0) {
        schemaPattern = pattern.slice(0, dot);
        namePattern = pattern.slice(dot + 1);
      }
      try {
        const rel = await lookupOneRelation(c, schemaPattern, namePattern);
        if (rel) {
          await dispatchDetail(ctx, c, rel, verbose);
          return { status: 'ok' };
        }
      } catch (err) {
        writeErr(`\\${ctx.cmdName}: ${errMsg(err)}\n`);
        return { status: 'error', errorWritten: true };
      }
      // Fall through to list (mirrors upstream behaviour: if no exact
      // relation, treat the name as a list pattern).
    }

    // List mode — use either describeTableDetails (for bare \d) or
    // listTables(tabtypes=...) for the typed variants.
    return runTypedList(ctx, c, baseName, pattern, verbose, showSystem);
  },
});

const dispatchDetail = async (
  ctx: BackslashContext,
  c: import('../types/connection.js').Connection,
  rel: import('../describe/formatters.js').RelationRow,
  verbose: boolean,
): Promise<void> => {
  const popt = ctx.settings.popt;
  switch (rel.relkind) {
    case 'S':
      await describeOneSequence(
        c,
        rel.oid,
        rel.nspname,
        rel.relname,
        process.stdout,
        popt,
      );
      return;
    case 'v':
      await describeOneViewDetails(
        c,
        rel.oid,
        rel.nspname,
        rel.relname,
        process.stdout,
        popt,
      );
      return;
    default:
      await describeOneTableDetails(
        c,
        rel.oid,
        rel.nspname,
        rel.relname,
        rel.relkind,
        verbose,
        process.stdout,
        popt,
        ctx.settings.hideTableam,
      );
  }
};

const runTypedList = async (
  ctx: BackslashContext,
  c: import('../types/connection.js').Connection,
  baseName: string,
  pattern: string | null,
  verbose: boolean,
  showSystem: boolean,
): Promise<BackslashResult> => {
  const serverVersion = c.serverVersion;
  let query: import('../describe/queries.js').DescribeQuery;
  let tabtypes = '';
  switch (baseName) {
    case 'd':
      query = describeTableDetails({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
      });
      break;
    case 'dt':
      tabtypes = 't';
      query = listTables({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
        tabtypes,
      });
      break;
    case 'di':
      tabtypes = 'i';
      query = listTables({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
        tabtypes,
      });
      break;
    case 'dv':
      tabtypes = 'v';
      query = listTables({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
        tabtypes,
      });
      break;
    case 'dm':
      tabtypes = 'm';
      query = listTables({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
        tabtypes,
      });
      break;
    case 'ds':
      tabtypes = 's';
      query = listTables({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
        tabtypes,
      });
      break;
    case 'dE':
      tabtypes = 'E';
      query = listTables({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
        tabtypes,
      });
      break;
    default:
      return { status: 'error' };
  }
  const visibility =
    baseName === 'd'
      ? 'pg_catalog.pg_table_is_visible(c.oid)'
      : 'pg_catalog.pg_table_is_visible(c.oid)';
  return runWithPattern(ctx, pattern, query, {
    namevar: 'c.relname',
    schemavar: 'n.nspname',
    visibilityrule: visibility,
  });
};

// Register all the relation-list-style commands with all suffix combos.
const RELATION_BASES = ['d', 'dt', 'di', 'dv', 'dm', 'ds', 'dE'];
const SUFFIX_COMBOS = ['', '+', 'S', 'S+', '+S'];

// ---- \df / \df+ / \dfS --------------------------------------------------

const cmdDescribeFunctions = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'df');
    const query = describeFunctions({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'p.proname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_function_is_visible(p.oid)',
    });
  },
});

// ---- \da ----------------------------------------------------------------

const cmdDescribeAggregates = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { showSystem } = decodeSuffix(cmdName, 'da');
    const query = describeAggregates({
      pattern: pattern ?? undefined,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'p.proname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_function_is_visible(p.oid)',
    });
  },
});

// ---- \dA / \dA+ / \dAm / \dAm+ -----------------------------------------
// `\dAm[+]` is a Neon extension: it lists access methods with their
// handler and description columns always present, equivalent to upstream
// `\dA+`. Upstream psql doesn't accept this spelling; we register it as
// an alias so users who reach for "access methods" by full name get the
// verbose view (Name, Type, Handler, Description) by default.

const cmdDescribeAccessMethods = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const isAlias = cmdName.startsWith('dAm');
    const base = isAlias ? 'dAm' : 'dA';
    const { verbose } = decodeSuffix(cmdName, base);
    // `\dAm[+]` always displays the verbose columns; trailing `+` is
    // accepted for syntactic parity but doesn't change output.
    const query = describeAccessMethods({
      pattern: pattern ?? undefined,
      verbose: isAlias ? true : verbose,
      serverVersion: c.serverVersion,
    });
    // Access methods are global, never schema-qualified; first dot is
    // "too many dotted names".
    return runWithPattern(ctx, pattern, query, { namevar: 'amname' }, 0);
  },
});

// ---- \dAc / \dAc+ ------------------------------------------------------
// `\dAc [AM-pattern [TYPE-pattern]]` — list operator classes. Two-pattern
// command: the first arg filters by access-method name, the second by
// input-type schema/name. Mirrors upstream's `case 'A' / cmd[2] == 'c'`
// dispatch in `command.c::exec_command_d`.

const cmdListOperatorClasses = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const amPat = ctx.nextArg('normal');
    const typePat = amPat ? ctx.nextArg('normal') : null;
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'dAc');
    const query = listOperatorClasses({
      amPattern: amPat ?? undefined,
      typePattern: typePat ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    const results: NamePatternResult[] = [];
    const curDb = currentDb(c);
    if (amPat !== null) {
      const r = processSQLNamePattern({
        namevar: 'am.amname',
        pattern: amPat,
      });
      // Access method names are flat — first dot is "too many".
      const err = validatePattern(amPat, r, 0, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    if (typePat !== null) {
      const r = processSQLNamePattern({
        namevar: 't.typname',
        schemavar: 'tn.nspname',
        pattern: typePat,
      });
      // Type pattern accepts db.schema.name; cross-db check on 2-dot.
      const err = validatePattern(typePat, r, 2, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    return runDualPatternList(ctx, query, results);
  },
});

// ---- \dAf / \dAf+ ------------------------------------------------------
// `\dAf [AM-pattern [TYPE-pattern]]` — list operator families. Same
// two-pattern shape as `\dAc`. Routes through `listOperatorFamilies`
// from queries.ts.

const cmdListOperatorFamilies = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const amPat = ctx.nextArg('normal');
    const typePat = amPat ? ctx.nextArg('normal') : null;
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'dAf');
    const query = listOperatorFamilies({
      amPattern: amPat ?? undefined,
      typePattern: typePat ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    const results: NamePatternResult[] = [];
    const curDb = currentDb(c);
    if (amPat !== null) {
      const r = processSQLNamePattern({
        namevar: 'am.amname',
        pattern: amPat,
      });
      const err = validatePattern(amPat, r, 0, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    if (typePat !== null) {
      const r = processSQLNamePattern({
        namevar: 't.typname',
        schemavar: 'tn.nspname',
        pattern: typePat,
      });
      const err = validatePattern(typePat, r, 2, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    return runDualPatternList(ctx, query, results);
  },
});

// ---- \dAo / \dAo+ ------------------------------------------------------
// `\dAo [AM-pattern [OPFAMILY-pattern]]` — list operators in an opfamily.
// Routes through `listOpFamilyOperators` from queries.ts.

const cmdListOpFamilyOperators = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const amPat = ctx.nextArg('normal');
    const familyPat = amPat ? ctx.nextArg('normal') : null;
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'dAo');
    const query = listOpFamilyOperators({
      amPattern: amPat ?? undefined,
      familyPattern: familyPat ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    const results: NamePatternResult[] = [];
    const curDb = currentDb(c);
    if (amPat !== null) {
      const r = processSQLNamePattern({
        namevar: 'am.amname',
        pattern: amPat,
      });
      const err = validatePattern(amPat, r, 0, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    if (familyPat !== null) {
      const r = processSQLNamePattern({
        namevar: 'of.opfname',
        schemavar: 'nsf.nspname',
        pattern: familyPat,
      });
      const err = validatePattern(familyPat, r, 2, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    return runDualPatternList(ctx, query, results);
  },
});

// ---- \dAp / \dAp+ ------------------------------------------------------
// `\dAp [AM-pattern [OPFAMILY-pattern]]` — list support functions of an
// opfamily. Routes through `listOpFamilyFunctions` from queries.ts.

const cmdListOpFamilyFunctions = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const amPat = ctx.nextArg('normal');
    const familyPat = amPat ? ctx.nextArg('normal') : null;
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'dAp');
    const query = listOpFamilyFunctions({
      amPattern: amPat ?? undefined,
      familyPattern: familyPat ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    const results: NamePatternResult[] = [];
    const curDb = currentDb(c);
    if (amPat !== null) {
      const r = processSQLNamePattern({
        namevar: 'am.amname',
        pattern: amPat,
      });
      const err = validatePattern(amPat, r, 0, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    if (familyPat !== null) {
      const r = processSQLNamePattern({
        namevar: 'of.opfname',
        schemavar: 'ns.nspname',
        pattern: familyPat,
      });
      const err = validatePattern(familyPat, r, 2, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    return runDualPatternList(ctx, query, results);
  },
});

// ---- \dT / \dT+ / \dTS --------------------------------------------------

const cmdDescribeTypes = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'dT');
    const query = describeTypes({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 't.typname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_type_is_visible(t.oid)',
    });
  },
});

// ---- \do / \do+ ---------------------------------------------------------

const cmdDescribeOperators = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'do');
    const query = describeOperators({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'o.oprname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_operator_is_visible(o.oid)',
    });
  },
});

// ---- \du / \dg / \dg+ / \du+ -------------------------------------------

const cmdDescribeRoles = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const base = cmdName.startsWith('du') ? 'du' : 'dg';
    const { verbose, showSystem } = decodeSuffix(cmdName, base);
    const query = describeRoles({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    // Roles are global — first dot is "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 'r.rolname' }, 0);
  },
});

// ---- \drds -------------------------------------------------------------
// `\drds [role-pattern [database-pattern]]` — list role-/database-level
// configuration settings (`pg_db_role_setting`). Two-pattern command:
// first arg filters by role, second by database. Empty results print a
// stderr notice ("Did not find any settings…") when not in quiet mode,
// mirroring upstream `describe.c::listDbRoleSettings`.

const cmdListDbRoleSettings: BackslashCmdSpec = {
  name: 'drds',
  run: async (ctx) => {
    const rolePat = ctx.nextArg('normal');
    const dbPat = rolePat ? ctx.nextArg('normal') : null;
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const query = listDbRoleSettings({
      pattern: rolePat ?? undefined,
      pattern2: dbPat ?? undefined,
      serverVersion: c.serverVersion,
    });
    const results: NamePatternResult[] = [];
    const curDb = currentDb(c);
    if (rolePat !== null) {
      const r = processSQLNamePattern({
        namevar: 'r.rolname',
        pattern: rolePat,
      });
      // Role names are flat — first dot is "too many".
      const err = validatePattern(rolePat, r, 0, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    if (dbPat !== null) {
      const r = processSQLNamePattern({
        namevar: 'd.datname',
        pattern: dbPat,
      });
      // Database names are top-level — first dot is "too many".
      const err = validatePattern(dbPat, r, 0, curDb);
      if (err !== null) {
        writeErr(`${err}\n`);
        return { status: 'error', errorWritten: true };
      }
      results.push(r);
    }
    // Upstream deviates from the rest of describe.c here: when the
    // result set is empty and we're not in --quiet, emit a stderr
    // diagnostic instead of printing an empty table — the two-pattern
    // shape makes confusion likely otherwise.
    if (rolePat === null && dbPat === null) {
      return runDualPatternList(ctx, query, results);
    }
    const { sql, params } = applyTwoPatterns(query.sql, [], results);
    const finalQuery: import('../describe/queries.js').DescribeQuery = {
      ...query,
      sql,
      params,
    };
    try {
      const rs = await c.query(sql, params);
      if (rs.rows.length === 0 && !ctx.settings.quiet) {
        if (rolePat !== null && dbPat !== null) {
          writeErr(
            `Did not find any settings for role "${rolePat}" and database "${dbPat}".\n`,
          );
        } else if (rolePat !== null) {
          writeErr(`Did not find any settings for role "${rolePat}".\n`);
        }
        return { status: 'ok' };
      }
      // Re-print via the standard runner so the title and formatting
      // match peer list queries. We pass the already-substituted SQL
      // and an empty pattern result so the second-pass replace is a
      // no-op. (We accept the double-query cost on the small `\drds`
      // path; alternatives require duplicating the printer plumbing.)
      const empty: NamePatternResult = {
        schemaConditions: [],
        nameConditions: [],
        visibilityConditions: [],
        params: [],
        dotCount: 0,
        dbLiteral: null,
      };
      await runListQuery(
        c,
        finalQuery,
        empty,
        process.stdout,
        ctx.settings.popt,
      );
      return { status: 'ok' };
    } catch (err) {
      writeErr(`\\${ctx.cmdName}: ${errMsg(err)}\n`);
      return { status: 'error', errorWritten: true };
    }
  },
};

// ---- \dn / \dn+ / \dnS --------------------------------------------------

const cmdListSchemas = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'dn');
    const query = listSchemas({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    // Schemas live in a single namespace; the optional qualifier slot
    // is interpreted as a database name (cross-database check fires on
    // mismatch). `maxDots = 1`.
    return runWithPattern(ctx, pattern, query, { namevar: 'n.nspname' }, 1);
  },
});

// ---- \db / \db+ ---------------------------------------------------------
// Tablespaces — not typically relevant on Neon. We still register so the
// command exists; it returns an empty result against a managed deployment.

// ---- \dD / \dDS / \dD+ -------------------------------------------------

const cmdListDomains = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'dD');
    const query = listDomains({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 't.typname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_type_is_visible(t.oid)',
    });
  },
});

// ---- \dc / \dcS / \dc+ -------------------------------------------------

const cmdListConversions = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'dc');
    const query = listConversions({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'c.conname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_conversion_is_visible(c.oid)',
    });
  },
});

// ---- \dC / \dC+ --------------------------------------------------------

const cmdListCasts = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'dC');
    const query = listCasts({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'ts.typname',
      schemavar: 'ns.nspname',
    });
  },
});

// ---- \dL / \dLS / \dL+ -------------------------------------------------

const cmdListLanguages = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'dL');
    const query = listLanguages({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    // Languages are global; first dot is a database qualifier (cross-db).
    return runWithPattern(ctx, pattern, query, { namevar: 'l.lanname' }, 1);
  },
});

// ---- \dO / \dO+ / \dOS -------------------------------------------------

const cmdListCollations = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'dO');
    const query = listCollations({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'c.collname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_collation_is_visible(c.oid)',
    });
  },
});

// ---- \dp / \z ----------------------------------------------------------

const cmdPermissionsList = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  aliases: cmdName === 'dp' ? ['z'] : undefined,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { showSystem } = decodeSuffix(cmdName, 'dp');
    const query = permissionsList({
      pattern: pattern ?? undefined,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'c.relname',
      schemavar: 'n.nspname',
      visibilityrule: 'pg_catalog.pg_table_is_visible(c.oid)',
    });
  },
});

// ---- \ddp --------------------------------------------------------------

const cmdListDefaultACLs: BackslashCmdSpec = {
  name: 'ddp',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const query = listDefaultACLs({
      pattern: pattern ?? undefined,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'pg_catalog.pg_get_userbyid(d.defaclrole)',
      schemavar: 'n.nspname',
    });
  },
};

// ---- \dd ---------------------------------------------------------------

const cmdObjectDescription: BackslashCmdSpec = {
  name: 'dd',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { showSystem } = decodeSuffix(ctx.cmdName, 'dd');
    const query = objectDescription({
      pattern: pattern ?? undefined,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'tt.name',
      schemavar: 'tt.nspname',
    });
  },
};

// ---- \l / \list -------------------------------------------------------

const cmdListAllDbs: BackslashCmdSpec = {
  name: 'l',
  aliases: ['list'],
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'l');
    const query = listAllDbs({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, { namevar: 'd.datname' });
  },
};

// ---- \dconfig ----------------------------------------------------------

const cmdDescribeConfigParams: BackslashCmdSpec = {
  name: 'dconfig',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dconfig');
    const query = describeConfigurationParameters({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    // GUC names are flat — any dot is "too many".
    return runWithPattern(
      ctx,
      pattern,
      query,
      { namevar: 'pg_catalog.lower(s.name)' },
      0,
    );
  },
};

// ---- \dy ---------------------------------------------------------------

const cmdListEventTriggers: BackslashCmdSpec = {
  name: 'dy',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dy');
    const query = listEventTriggers({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    // Event triggers are global; first dot is a database qualifier (cross-db).
    return runWithPattern(ctx, pattern, query, { namevar: 'evtname' }, 1);
  },
};

// ---- \dx / \dx+ -------------------------------------------------------

const cmdListExtensions: BackslashCmdSpec = {
  name: 'dx',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const query = listExtensions({
      pattern: pattern ?? undefined,
      serverVersion: c.serverVersion,
    });
    // Extensions are global; first dot is a database qualifier (cross-db).
    return runWithPattern(ctx, pattern, query, { namevar: 'e.extname' }, 1);
  },
};

// ---- \dl / \lo_list ---------------------------------------------------

const cmdListLargeObjects: BackslashCmdSpec = {
  name: 'dl',
  aliases: ['lo_list'],
  run: async (ctx) => {
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dl');
    const query = listLargeObjects({
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, null, query, { namevar: 'oid' });
  },
};

// ---- \dF / \dFp / \dFd / \dFt ----------------------------------------

const cmdListTSConfigs: BackslashCmdSpec = {
  name: 'dF',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dF');
    const query = listTSConfigs({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'c.cfgname',
      schemavar: 'n.nspname',
    });
  },
};

const cmdListTSParsers: BackslashCmdSpec = {
  name: 'dFp',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dFp');
    const query = listTSParsers({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'p.prsname',
      schemavar: 'n.nspname',
    });
  },
};

const cmdListTSDictionaries: BackslashCmdSpec = {
  name: 'dFd',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dFd');
    const query = listTSDictionaries({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'd.dictname',
      schemavar: 'n.nspname',
    });
  },
};

const cmdListTSTemplates: BackslashCmdSpec = {
  name: 'dFt',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dFt');
    const query = listTSTemplates({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 't.tmplname',
      schemavar: 'n.nspname',
    });
  },
};

// ---- \dew / \des / \deu / \det ---------------------------------------

const cmdListForeignDataWrappers: BackslashCmdSpec = {
  name: 'dew',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dew');
    const query = listForeignDataWrappers({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    // FDWs are global; first dot is a database qualifier (cross-db).
    return runWithPattern(ctx, pattern, query, { namevar: 'fdwname' }, 1);
  },
};

const cmdListForeignServers: BackslashCmdSpec = {
  name: 'des',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'des');
    const query = listForeignServers({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    // Foreign servers are global; first dot is a database qualifier.
    return runWithPattern(ctx, pattern, query, { namevar: 's.srvname' }, 1);
  },
};

const cmdListUserMappings: BackslashCmdSpec = {
  name: 'deu',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'deu');
    const query = listUserMappings({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    // User mappings live alongside foreign servers (global); first dot is db.
    return runWithPattern(ctx, pattern, query, { namevar: 'um.srvname' }, 1);
  },
};

const cmdListForeignTables: BackslashCmdSpec = {
  name: 'det',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'det');
    const query = listForeignTables({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
  },
};

// ---- \dP / \dPi / \dPt / \dPn -----------------------------------------

const cmdListPartitionedTables: BackslashCmdSpec = {
  name: 'dP',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dP');
    let reltypes = '';
    if (ctx.cmdName.includes('i')) reltypes += 'i';
    if (ctx.cmdName.includes('t')) reltypes += 't';
    if (ctx.cmdName.includes('n')) reltypes += 'n';
    const query = listPartitionedTables({
      pattern: pattern ?? undefined,
      verbose,
      reltypes,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
  },
};

// ---- \dRp / \dRs ------------------------------------------------------

const cmdListPublications: BackslashCmdSpec = {
  name: 'dRp',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const query = listPublications({
      pattern: pattern ?? undefined,
      serverVersion: c.serverVersion,
    });
    // Publications are global; first dot is a database qualifier (cross-db).
    return runWithPattern(ctx, pattern, query, { namevar: 'pubname' }, 1);
  },
};

const cmdDescribeSubscriptions: BackslashCmdSpec = {
  name: 'dRs',
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(ctx.cmdName, 'dRs');
    const query = describeSubscriptions({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    // Subscriptions are global; first dot is a database qualifier (cross-db).
    return runWithPattern(ctx, pattern, query, { namevar: 'subname' }, 1);
  },
};

// ===========================================================================
// Registration
// ===========================================================================

/**
 * Register every `\d*` command this WP implements on the given
 * registry. Called from `dispatch.ts::defaultRegistry()`.
 *
 * We register a separate spec per suffix combination so the dispatcher
 * can do a single name lookup without re-parsing. The implementation
 * functions are factory-style (`make…(cmdName)`) so each spec carries
 * the exact command name for suffix decoding.
 */
export const registerDescribeCommands = (registry: BackslashRegistry): void => {
  // Relation list+detail family. Each suffix combination is its own
  // registered name; suffix decoding happens at runtime via the
  // `cmdName` field on the spec (set per-registration).
  for (const base of RELATION_BASES) {
    for (const suffix of SUFFIX_COMBOS) {
      const name = base + suffix;
      registry.register({ ...makeDescribeCmd(base), name });
    }
  }

  // Functions.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdDescribeFunctions('df' + suffix));
  }

  // Aggregates.
  for (const suffix of ['', 'S']) {
    registry.register(cmdDescribeAggregates('da' + suffix));
  }

  // Access methods. `\dA[+]` is upstream; `\dAm[+]` is a Neon-friendly
  // alias that some docs reach for. `\dAc[+]`, `\dAf[+]`, `\dAo[+]`,
  // `\dAp[+]` cover the operator-class / family / family-operator /
  // family-function families upstream's `command.c::exec_command_d`
  // dispatches.
  for (const suffix of ['', '+']) {
    registry.register(cmdDescribeAccessMethods('dA' + suffix));
    registry.register(cmdDescribeAccessMethods('dAm' + suffix));
    registry.register(cmdListOperatorClasses('dAc' + suffix));
    registry.register(cmdListOperatorFamilies('dAf' + suffix));
    registry.register(cmdListOpFamilyOperators('dAo' + suffix));
    registry.register(cmdListOpFamilyFunctions('dAp' + suffix));
  }

  // Types.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdDescribeTypes('dT' + suffix));
  }

  // Operators.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdDescribeOperators('do' + suffix));
  }

  // Roles.
  for (const suffix of ['', '+', 'S', 'S+', '+S']) {
    registry.register(cmdDescribeRoles('du' + suffix));
    registry.register(cmdDescribeRoles('dg' + suffix));
  }

  // Schemas.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdListSchemas('dn' + suffix));
  }

  // Domains.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdListDomains('dD' + suffix));
  }

  // Conversions.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdListConversions('dc' + suffix));
  }

  // Casts.
  for (const suffix of ['', '+']) {
    registry.register(cmdListCasts('dC' + suffix));
  }

  // Languages.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdListLanguages('dL' + suffix));
  }

  // Collations.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdListCollations('dO' + suffix));
  }

  // Permissions / default ACLs.
  registry.register(cmdPermissionsList('dp'));
  registry.register(cmdPermissionsList('z'));
  registry.register(cmdListDefaultACLs);

  // Descriptions.
  registry.register(cmdObjectDescription);

  // Databases.
  registry.register(cmdListAllDbs);

  // Config / event triggers / extensions / large objects.
  registry.register(cmdDescribeConfigParams);
  registry.register({ ...cmdDescribeConfigParams, name: 'dconfig+' });
  registry.register(cmdListEventTriggers);
  registry.register(cmdListExtensions);
  registry.register({ ...cmdListExtensions, name: 'dx+' });
  registry.register(cmdListLargeObjects);

  // Text search family.
  registry.register(cmdListTSConfigs);
  registry.register({ ...cmdListTSConfigs, name: 'dF+' });
  registry.register(cmdListTSParsers);
  registry.register({ ...cmdListTSParsers, name: 'dFp+' });
  registry.register(cmdListTSDictionaries);
  registry.register({ ...cmdListTSDictionaries, name: 'dFd+' });
  registry.register(cmdListTSTemplates);
  registry.register({ ...cmdListTSTemplates, name: 'dFt+' });

  // Foreign-data family.
  for (const variant of ['dew', 'dew+']) {
    registry.register({ ...cmdListForeignDataWrappers, name: variant });
  }
  for (const variant of ['des', 'des+']) {
    registry.register({ ...cmdListForeignServers, name: variant });
  }
  for (const variant of ['deu', 'deu+']) {
    registry.register({ ...cmdListUserMappings, name: variant });
  }
  for (const variant of ['det', 'det+']) {
    registry.register({ ...cmdListForeignTables, name: variant });
  }

  // Partitioned tables. Upstream's `\dP` accepts any concatenation of
  // {i,t,n}: `\dPtn` lists nested partitioned tables (table + nested
  // toggles), `\dPin` lists nested partitioned indexes, etc. We
  // register the most common combinations explicitly; the spec's
  // suffix-decoding loop (`includes('i'|'t'|'n')`) drives the actual
  // `reltypes` selection at runtime.
  for (const variant of [
    'dP',
    'dP+',
    'dPi',
    'dPi+',
    'dPin',
    'dPin+',
    'dPt',
    'dPt+',
    'dPtn',
    'dPtn+',
    'dPn',
    'dPn+',
  ]) {
    registry.register({ ...cmdListPartitionedTables, name: variant });
  }

  // Role-database settings.
  registry.register(cmdListDbRoleSettings);
  registry.register({ ...cmdListDbRoleSettings, name: 'drds+' });

  // Publication / subscription.
  for (const variant of ['dRp', 'dRp+']) {
    registry.register({ ...cmdListPublications, name: variant });
  }
  for (const variant of ['dRs', 'dRs+']) {
    registry.register({ ...cmdDescribeSubscriptions, name: variant });
  }
};
