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
  describeRoleGrants,
  describeRoles,
  describeSubscriptions,
  describeTableDetails,
  describeTablespaces,
  describeTypes,
  listAllDbs,
  listCasts,
  listCollations,
  listConversions,
  listDbRoleSettings,
  listDefaultACLs,
  listDomains,
  listEventTriggers,
  listExtendedStats,
  listExtensions,
  listForeignDataWrappers,
  listForeignServers,
  listForeignTables,
  listLanguages,
  listLargeObjects,
  listOpFamilyFunctions,
  listOpFamilyOperators,
  listOperatorClasses,
  listOperatorFamilies,
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
/**
 * Per-call overrides for `runWithPattern`'s aligned-printer invocation.
 *
 * - `suppressDefaultFooter` flips `topt.defaultFooter` to `false` for
 *   this query only, matching upstream commands that call
 *   `printQuery` with `default_footer = false` to omit the
 *   `(N rows)` row counter (e.g. `\du`, `\dg`, `\drg`, `\dconfig`).
 *   It does not affect the global `\pset footer` setting.
 */
type RunWithPatternOverrides = {
  suppressDefaultFooter?: boolean;
};

const runWithPattern = async (
  ctx: BackslashContext,
  pattern: string | null,
  query: import('../describe/queries.js').DescribeQuery,
  patternOpts: Omit<Parameters<typeof processSQLNamePattern>[0], 'pattern'>,
  maxDots = 2,
  overrides: RunWithPatternOverrides = {},
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
    const basePopt = ctx.settings.popt;
    const popt = overrides.suppressDefaultFooter
      ? { ...basePopt, topt: { ...basePopt.topt, defaultFooter: false } }
      : basePopt;
    await runListQuery(c, query, result, process.stdout, popt);
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

/**
 * Apply per-argument type patterns into the `ARG_PATTERN_<i>`
 * placeholders emitted by {@link describeFunctions} and
 * {@link describeOperators}. Each non-`-` arg pattern produces a set of
 * conditions against the `t<i>` / `nt<i>` join, matched against
 * `typname`, `nt<i>.nspname`, and the formatted-type expression — same
 * semantics as upstream's `validateSQLNamePattern(... ft, tiv, ...)`
 * call in `describe.c`. `-` slots emit a literal `typname IS NULL`
 * check at SQL build time and don't generate any conditions here.
 *
 * Returns the rewritten SQL plus the merged parameter list (renumbered
 * so `$N` slots from each arg pattern don't collide with prior slots).
 */
const applyArgPatterns = (
  sql: string,
  baseParams: unknown[],
  argResults: (NamePatternResult | null)[],
): { sql: string; params: unknown[] } => {
  let rendered = sql;
  const params = [...baseParams];
  for (let i = 0; i < argResults.length; i++) {
    const placeholder = `true /* ARG_PATTERN_${i} */`;
    const idx = rendered.indexOf(placeholder);
    if (idx < 0) continue;
    const r = argResults[i];
    let replacement = 'true';
    if (r !== null) {
      const conds = [
        ...r.schemaConditions,
        ...r.nameConditions,
        ...r.visibilityConditions,
      ];
      if (conds.length > 0) {
        const slotOffset = params.length;
        const renumbered = conds.map((c) =>
          c.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + slotOffset}`),
        );
        params.push(...r.params);
        replacement = `(${renumbered.join(' AND ')})`;
      }
    }
    rendered =
      rendered.slice(0, idx) +
      replacement +
      rendered.slice(idx + placeholder.length);
  }
  return { sql: rendered, params };
};

/**
 * Upstream `map_typename_pattern()`: a few aliases the user can type
 * (`int`, `float`, `decimal`, …) get rewritten to the canonical type
 * names that appear in `pg_type.typname` / `format_type()`. Mirrors
 * `describe.c::map_typename_pattern`. Pattern matching is otherwise
 * literal, so this is the only place the user's input gets rewritten.
 */
const TYPENAME_ALIASES: Record<string, string> = {
  decimal: 'numeric',
  float: 'double precision',
  int: 'integer',
  'bool[]': 'boolean[]',
  'decimal[]': 'numeric[]',
  'float[]': 'double precision[]',
  'float4[]': 'real[]',
  'float8[]': 'double precision[]',
  'int[]': 'integer[]',
  'int2[]': 'smallint[]',
  'int4[]': 'integer[]',
  'int8[]': 'bigint[]',
  'time[]': 'time without time zone[]',
  'timetz[]': 'time with time zone[]',
  'timestamp[]': 'timestamp without time zone[]',
  'timestamptz[]': 'timestamp with time zone[]',
  'varbit[]': 'bit varying[]',
  'varchar[]': 'character varying[]',
};

const mapTypenamePattern = (pattern: string): string =>
  TYPENAME_ALIASES[pattern.toLowerCase()] ?? pattern;

/**
 * Process a per-argument type pattern slot for `\df` / `\do`. `-`
 * returns null (the SQL builder handles the literal `IS NULL` check);
 * any other value goes through {@link processSQLNamePattern} configured
 * with the `t<i>` / `nt<i>` join columns and the formatted-type
 * altnamevar so `\df foo int4` matches `oid -> integer` correctly.
 */
const processArgPattern = (
  slot: number,
  raw: string,
): NamePatternResult | null => {
  if (raw === '-') return null;
  const mapped = mapTypenamePattern(raw);
  return processSQLNamePattern({
    pattern: mapped,
    schemavar: `nt${slot}.nspname`,
    namevar: `t${slot}.typname`,
    altnamevar: `pg_catalog.format_type(t${slot}.oid, NULL)`,
    visibilityrule: `pg_catalog.pg_type_is_visible(t${slot}.oid)`,
  });
};

/**
 * Drive a `\df` / `\do` style command: collect the main pattern, then
 * any extra args as per-arg type filters, splice them all into the
 * query, and print. Returns the collected arg patterns so the SQL
 * builder upstream can mirror them as joins.
 */
const collectArgPatterns = (ctx: BackslashContext): string[] => {
  const args: string[] = [];
  // Upstream caps `\do` at 2 args internally but reads all of them
  // from the scanner; describeFunctions caps at FUNC_MAX_ARGS (100).
  // We let the caller decide what to do with extras (mostly: ignore).
  for (;;) {
    const arg = ctx.nextArg('normal');
    if (arg === null) break;
    args.push(arg);
  }
  return args;
};

/**
 * Run a `\df` / `\do` query: handles the main pattern AND the per-arg
 * type filters in one go. Mirrors {@link runWithPattern}, but also
 * threads per-arg `NamePatternResult`s into the `ARG_PATTERN_<i>`
 * placeholders before handing off to {@link runListQuery}.
 */
const runFunctionOrOperatorQuery = async (
  ctx: BackslashContext,
  pattern: string | null,
  argPatternResults: (NamePatternResult | null)[],
  query: import('../describe/queries.js').DescribeQuery,
  patternOpts: Omit<Parameters<typeof processSQLNamePattern>[0], 'pattern'>,
): Promise<BackslashResult> => {
  const c = conn(ctx);
  if (!c) return noConn(ctx);
  const result = processSQLNamePattern({ ...patternOpts, pattern });
  const dotErr = validatePattern(pattern, result, 2, currentDb(c));
  if (dotErr !== null) {
    writeErr(`${dotErr}\n`);
    return { status: 'error', errorWritten: true };
  }
  // Substitute the arg-pattern placeholders first so the params they
  // contribute precede the main pattern's `$N` allocations.
  const { sql, params } = applyArgPatterns(
    query.sql,
    query.params,
    argPatternResults,
  );
  const finalQuery: import('../describe/queries.js').DescribeQuery = {
    ...query,
    sql,
    params,
  };
  try {
    await runListQuery(
      c,
      finalQuery,
      result,
      process.stdout,
      ctx.settings.popt,
    );
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

    // `\d`-family `x` suffix toggles expanded mode for the LIST view
    // only — upstream `command.c` declines to apply it when a pattern is
    // present and would dispatch to per-relation detail rendering.
    const forceExpanded =
      ctx.cmdName.slice(baseName.length).includes('x') && pattern === null;
    const savedPopt = ctx.settings.popt;
    if (forceExpanded) {
      ctx.settings.popt = {
        ...savedPopt,
        topt: { ...savedPopt.topt, expanded: 'on' },
      };
    }
    try {
      // List mode — use either describeTableDetails (for bare \d) or
      // listTables(tabtypes=...) for the typed variants.
      return await runTypedList(ctx, c, baseName, pattern, verbose, showSystem);
    } finally {
      ctx.settings.popt = savedPopt;
    }
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
        verbose,
        ctx.settings.hideCompression,
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
        ctx.settings.hideCompression,
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
  const hideTableam = ctx.settings.hideTableam;
  let query: import('../describe/queries.js').DescribeQuery;
  let tabtypes = '';
  switch (baseName) {
    case 'd':
      query = describeTableDetails({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        serverVersion,
        hideTableam,
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
        hideTableam,
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
        hideTableam,
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
        hideTableam,
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
        hideTableam,
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
        hideTableam,
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
        hideTableam,
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
// Standard suffix matrix. `x` is added separately for the bases that
// accept the expanded-mode toggle (currently `\d`/`\d+`).
const SUFFIX_COMBOS = ['', '+', 'S', 'S+', '+S'];
// Extended suffix matrix for `\d` only — adds the `x` (expanded) suffix
// in the same combinations regress exercises.
const DESCRIBE_X_SUFFIXES = ['x', '+x', 'x+', 'Sx', 'xS', '+Sx', '+xS'];

// ---- \df / \df+ / \dfS / \dfa / \dfn / \dfp / \dft / \dfw / \dfx -------
// Upstream's `command.c::exec_command_df` accepts a free-form suffix after
// `\df`: `+` for verbose, `S` to include system schemas, `x` to force
// expanded mode (when no pattern), and {a,n,p,t,w} to filter by function
// kind (aggregate / normal / procedure / trigger / window). Multiple may
// combine and order is unrestricted (`\dfax+`, `\df+xn`, etc.).

const cmdDescribeFunctions = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose, showSystem } = decodeSuffix(cmdName, 'df');
    let functypes = '';
    const tail = cmdName.slice(2);
    for (const ch of tail) {
      if (ch === 'a' || ch === 'n' || ch === 'p' || ch === 't' || ch === 'w') {
        functypes += ch;
      }
    }
    // Per-argument type patterns: only collected when the main pattern
    // is non-null (upstream: "Collect argument-type patterns too /
    // otherwise it was just \df"). Each extra arg filters one slot of
    // `proargtypes`; `-` means "no type in that slot".
    const argPatterns: string[] = [];
    if (pattern !== null) {
      argPatterns.push(...collectArgPatterns(ctx));
    }
    const argPatternResults = argPatterns.map((a, i) =>
      processArgPattern(i, a),
    );
    // `x` enables expanded mode for the printed result. For `\df` upstream
    // applies the toggle whether or not a pattern is present (unlike `\d`,
    // which only toggles when no pattern is given). Override popt locally
    // so we don't leak the change to subsequent commands.
    const forceExpanded = tail.includes('x');
    const savedPopt = ctx.settings.popt;
    if (forceExpanded) {
      ctx.settings.popt = {
        ...savedPopt,
        topt: { ...savedPopt.topt, expanded: 'on' },
      };
    }
    try {
      const query = describeFunctions({
        pattern: pattern ?? undefined,
        verbose,
        showSystem,
        functypes,
        argPatterns,
        serverVersion: c.serverVersion,
      });
      return await runFunctionOrOperatorQuery(
        ctx,
        pattern,
        argPatternResults,
        query,
        {
          namevar: 'p.proname',
          schemavar: 'n.nspname',
          visibilityrule: 'pg_catalog.pg_function_is_visible(p.oid)',
        },
      );
    } finally {
      ctx.settings.popt = savedPopt;
    }
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
    const result = await runWithPattern(
      ctx,
      pattern,
      query,
      { namevar: 'amname' },
      0,
    );
    // Upstream `exec_command_d` drains any args past the first AFTER
    // running the query and writing the result, emitting one warning
    // per leftover token via `pg_log_warning`. Mirror that ordering so
    // `\dA foo bar` prints the (empty) result first, then
    // `\dA: extra argument "bar" ignored` to stderr.
    for (let extra = ctx.nextArg('normal'); extra !== null; ) {
      writeErr(`\\${base}: extra argument "${extra}" ignored\n`);
      extra = ctx.nextArg('normal');
    }
    return result;
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
    // `\dApx[+]` — expanded toggle, same convention as `\df`/`\z`.
    const forceExpanded = cmdName.slice(3).includes('x');
    const savedPopt = ctx.settings.popt;
    if (forceExpanded) {
      ctx.settings.popt = {
        ...savedPopt,
        topt: { ...savedPopt.topt, expanded: 'on' },
      };
    }
    try {
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
      return await runDualPatternList(ctx, query, results);
    } finally {
      ctx.settings.popt = savedPopt;
    }
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
    // Upstream: same arg-collection rule as `\df` (only when main
    // pattern is non-null). describeOperators caps at 2 args; we still
    // forward the user's input so the SQL builder can decide which
    // joins to emit.
    let argPatterns: string[] = [];
    if (pattern !== null) {
      argPatterns = collectArgPatterns(ctx);
    }
    if (argPatterns.length > 2) argPatterns = argPatterns.slice(0, 2);
    const argPatternResults = argPatterns.map((a, i) =>
      processArgPattern(i, a),
    );
    const query = describeOperators({
      pattern: pattern ?? undefined,
      verbose,
      showSystem,
      argPatterns,
      serverVersion: c.serverVersion,
    });
    return runFunctionOrOperatorQuery(ctx, pattern, argPatternResults, query, {
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
    // Roles are global — first dot is "too many". Upstream calls
    // `printQuery` with `default_footer = false` (describe.c
    // `describeRoles`), so suppress the `(N rows)` counter for both
    // populated and empty results to match `psql -E \du`.
    return runWithPattern(ctx, pattern, query, { namevar: 'r.rolname' }, 0, {
      suppressDefaultFooter: true,
    });
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

const cmdDescribeTablespaces = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'db');
    const query = describeTablespaces({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    // Tablespaces are flat — first dot is "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 'spcname' }, 0);
  },
});

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
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const base = cmdName.startsWith('z') ? 'z' : 'dp';
    const { showSystem } = decodeSuffix(cmdName, base);
    // `\z[x]`, `\dp[x]` — same expanded-mode toggle convention as `\df`,
    // applied whether or not a pattern is present.
    const forceExpanded = cmdName.slice(base.length).includes('x');
    const savedPopt = ctx.settings.popt;
    if (forceExpanded) {
      ctx.settings.popt = {
        ...savedPopt,
        topt: { ...savedPopt.topt, expanded: 'on' },
      };
    }
    try {
      const query = permissionsList({
        pattern: pattern ?? undefined,
        showSystem,
        serverVersion: c.serverVersion,
      });
      return await runWithPattern(ctx, pattern, query, {
        namevar: 'c.relname',
        schemavar: 'n.nspname',
        visibilityrule: 'pg_catalog.pg_table_is_visible(c.oid)',
      });
    } finally {
      ctx.settings.popt = savedPopt;
    }
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
    // Event triggers are global with no schema or database qualifier
    // (upstream `validateSQLNamePattern(..., NULL, 1)`): any dot in
    // the pattern is "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 'evtname' }, 0);
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
    // Extensions are global with no schema or database qualifier
    // (upstream `validateSQLNamePattern(..., NULL, 1)`): any dot is
    // "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 'e.extname' }, 0);
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
    // FDWs are global with no schema or database qualifier (upstream
    // `validateSQLNamePattern(..., NULL, 1)`): any dot is "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 'fdwname' }, 0);
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
    // Foreign servers are global with no schema or database qualifier
    // (upstream `validateSQLNamePattern(..., NULL, 1)`): any dot is
    // "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 's.srvname' }, 0);
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
    // User mappings live alongside foreign servers (global, no schema
    // or db qualifier per upstream `validateSQLNamePattern(..., 1)`).
    return runWithPattern(ctx, pattern, query, { namevar: 'um.srvname' }, 0);
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

// ---- \dX / \dX+ -------------------------------------------------------
// Extended-statistics objects (`pg_statistic_ext`). Patterns accept the
// usual schema-qualified form: `\dX` schema.name, with the cross-database
// 2-dot check applied.

const cmdListExtendedStats = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'dX');
    const query = listExtendedStats({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, {
      namevar: 'es.stxname',
      schemavar: 'es.stxnamespace::pg_catalog.regnamespace::pg_catalog.text',
    });
  },
});

// ---- \drg / \drg+ -----------------------------------------------------
// Role grants — membership rows from `pg_auth_members`. Two-pattern shape
// is upstream-specific to `\du`/`\dg`; `\drg` carries the same pattern as
// `\du` (role name), with the cross-database check declined because roles
// are global.

const cmdDescribeRoleGrants = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { showSystem } = decodeSuffix(cmdName, 'drg');
    const query = describeRoleGrants({
      pattern: pattern ?? undefined,
      showSystem,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, { namevar: 'm.rolname' }, 0);
  },
});

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
    // Publications are global with no schema or database qualifier
    // (upstream `validateSQLNamePattern(..., NULL, 1)`): any dot is
    // "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 'pubname' }, 0);
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
    // Subscriptions are global with no schema or database qualifier
    // (upstream `validateSQLNamePattern(..., NULL, 1)`): any dot is
    // "too many".
    return runWithPattern(ctx, pattern, query, { namevar: 'subname' }, 0);
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
  // `\d` accepts an additional `x` (expanded-mode toggle) suffix that we
  // register only for the bare `\d` base — upstream only honours it for
  // `\d` itself, not for typed variants like `\dt` or `\dv`.
  for (const suffix of DESCRIBE_X_SUFFIXES) {
    registry.register({ ...makeDescribeCmd('d'), name: 'd' + suffix });
  }

  // Functions. Beyond the standard `\df[+S]` matrix, upstream accepts
  // function-kind filter letters (a / n / p / t / w) and an expanded-mode
  // toggle (x) appended in any order, with multiple stacking. The fanout
  // covers the common one-letter additions used in regress; combined
  // letter sequences (`\dfax+`, `\dfxw`, …) are handled by the runtime
  // suffix walk in `cmdDescribeFunctions`.
  const dfTails = [
    '',
    '+',
    'S',
    'S+',
    '+S',
    'a',
    'n',
    'p',
    't',
    'w',
    'x',
    'ax',
    'nx',
    'px',
    'tx',
    'wx',
    'xa',
    'xn',
    'xp',
    'xt',
    'xw',
    'a+',
    'n+',
    'p+',
    't+',
    'w+',
    'x+',
    'a+x',
    'x+a',
  ];
  for (const tail of dfTails) {
    registry.register(cmdDescribeFunctions('df' + tail));
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
  // `x` (expanded) variants of the two-pattern access-method families.
  for (const tail of ['x', 'x+', '+x', 'xS', 'Sx']) {
    registry.register(cmdListOpFamilyFunctions('dAp' + tail));
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

  // Tablespaces.
  for (const suffix of ['', '+']) {
    registry.register(cmdDescribeTablespaces('db' + suffix));
  }

  // Languages.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdListLanguages('dL' + suffix));
  }

  // Collations.
  for (const suffix of SUFFIX_COMBOS) {
    registry.register(cmdListCollations('dO' + suffix));
  }

  // Permissions / default ACLs. `\dp` and `\z` are independent base names
  // (aliasing them via `aliases` couldn't carry separate `x`-suffix
  // variants), so register each with its own suffix matrix.
  for (const tail of ['', 'S', 'x', 'Sx', 'xS']) {
    registry.register(cmdPermissionsList('dp' + tail));
    registry.register(cmdPermissionsList('z' + tail));
  }
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

  // Extended statistics (\dX / \dX+).
  for (const suffix of ['', '+']) {
    registry.register(cmdListExtendedStats('dX' + suffix));
  }

  // Role grants (\drg / \drg+ / \drgS).
  for (const suffix of ['', '+', 'S', 'S+', '+S']) {
    registry.register(cmdDescribeRoleGrants('drg' + suffix));
  }

  // Publication / subscription.
  for (const variant of ['dRp', 'dRp+']) {
    registry.register({ ...cmdListPublications, name: variant });
  }
  for (const variant of ['dRs', 'dRs+']) {
    registry.register({ ...cmdDescribeSubscriptions, name: variant });
  }
};
