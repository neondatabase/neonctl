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
  listDefaultACLs,
  listDomains,
  listEventTriggers,
  listExtensions,
  listForeignDataWrappers,
  listForeignServers,
  listForeignTables,
  listLanguages,
  listLargeObjects,
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
import { processSQLNamePattern } from '../describe/processNamePattern.js';

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
  return { status: 'error' };
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
 */
const runWithPattern = async (
  ctx: BackslashContext,
  pattern: string | null,
  query: import('../describe/queries.js').DescribeQuery,
  patternOpts: Omit<Parameters<typeof processSQLNamePattern>[0], 'pattern'>,
): Promise<BackslashResult> => {
  const c = conn(ctx);
  if (!c) return noConn(ctx);
  const result = processSQLNamePattern({ ...patternOpts, pattern });
  try {
    await runListQuery(c, query, result, process.stdout, ctx.settings.popt);
    return { status: 'ok' };
  } catch (err) {
    writeErr(`\\${ctx.cmdName}: ${errMsg(err)}\n`);
    return { status: 'error' };
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
        return { status: 'error' };
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

// ---- \dA / \dA+ ---------------------------------------------------------

const cmdDescribeAccessMethods = (cmdName: string): BackslashCmdSpec => ({
  name: cmdName,
  run: async (ctx) => {
    const pattern = ctx.nextArg('normal');
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { verbose } = decodeSuffix(cmdName, 'dA');
    const query = describeAccessMethods({
      pattern: pattern ?? undefined,
      verbose,
      serverVersion: c.serverVersion,
    });
    return runWithPattern(ctx, pattern, query, { namevar: 'amname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'r.rolname' });
  },
});

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
    return runWithPattern(ctx, pattern, query, { namevar: 'n.nspname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'l.lanname' });
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
    return runWithPattern(ctx, pattern, query, {
      namevar: 'pg_catalog.lower(s.name)',
    });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'evtname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'e.extname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'fdwname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 's.srvname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'um.srvname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'pubname' });
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
    return runWithPattern(ctx, pattern, query, { namevar: 'subname' });
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

  // Access methods.
  for (const suffix of ['', '+']) {
    registry.register(cmdDescribeAccessMethods('dA' + suffix));
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

  // Partitioned tables.
  for (const variant of [
    'dP',
    'dP+',
    'dPi',
    'dPi+',
    'dPt',
    'dPt+',
    'dPn',
    'dPn+',
  ]) {
    registry.register({ ...cmdListPartitionedTables, name: variant });
  }

  // Publication / subscription.
  for (const variant of ['dRp', 'dRp+']) {
    registry.register({ ...cmdListPublications, name: variant });
  }
  for (const variant of ['dRs', 'dRs+']) {
    registry.register({ ...cmdDescribeSubscriptions, name: variant });
  }
};
