/**
 * Tab-completion rule body.
 *
 * Port (selective — see "Coverage" below) of psql's `psql_completion()`
 * from `src/bin/psql/tab-complete.in.c`. Given the tokenized "previous
 * words" and the in-progress current word, we walk a chain of
 * Matches/TailMatches/HeadMatches guards and return:
 *
 *   - a STATIC list (for keyword / enum-value completion), filtered by the
 *     current word's prefix, OR
 *   - a CATALOG query (for table/view/role/schema/etc.) executed against
 *     the live Connection.
 *
 * Coverage (the parts of upstream we ship):
 *
 *   - Backslash command name completion: `\` → list of commands.
 *   - Backslash arg completion for the high-traffic commands: `\c[onnect]`,
 *     `\dt`/`\d`/`\dv`/`\dm`/`\di`/`\ds`, `\df`, `\dn`, `\du`/`\dg`,
 *     `\dx`, `\dL`, `\dT`, `\encoding`, `\pset`, `\set`.
 *   - Top-level SQL keyword set (SELECT/INSERT/UPDATE/DELETE/etc).
 *   - Mid-statement object completion in the most common contexts:
 *       FROM            → tables/views/matviews/foreign tables.
 *       INTO (INSERT)   → tables.
 *       JOIN            → tables/views/matviews.
 *       UPDATE          → tables.
 *       DELETE FROM     → tables.
 *       ALTER TABLE     → tables.
 *       ALTER VIEW      → views.
 *       DROP TABLE      → tables.
 *       DROP VIEW       → views.
 *       DROP INDEX      → indexes.
 *       DROP MATERIALIZED VIEW → mat views.
 *       DROP SEQUENCE   → sequences.
 *       DROP TYPE       → types.
 *       DROP SCHEMA     → schemas.
 *       DROP EXTENSION  → extensions.
 *       DROP ROLE / USER → roles.
 *       DROP DATABASE   → databases.
 *       DROP FUNCTION   → functions.
 *       GRANT / REVOKE … ON … → tables.
 *       TRUNCATE [TABLE] → tables.
 *       LOCK TABLE      → tables.
 *       COPY            → tables.
 *       ANALYZE / VACUUM → tables.
 *       REINDEX         → indexes/tables/databases (limited).
 *       SET ROLE        → roles.
 *       SET SCHEMA      → schemas.
 *
 *   - `\set`/`\unset`: completion of psql variable names.
 *   - Variable expansion `:NAME` completion (inside any line).
 *
 * What's intentionally stubbed:
 *
 *   - Most ALTER … sub-keywords (ADD COLUMN, RENAME TO, …). We surface a
 *     small set for ALTER TABLE/VIEW only.
 *   - CREATE INDEX … ON … USING …, partition-key syntax, generated columns.
 *   - Window-function clauses, GROUPING SETS, etc.
 *   - GUC option name completion for `SET <guc>` (would need a static GUC
 *     list to be useful; we leave it to the user).
 *   - psql `\h` SQL help index — exists in psql proper, would need the
 *     help index data.
 *
 * The shape mirrors the C source closely enough that adding new rules is
 * mechanical: drop a new `if (TailMatches(...))` arm in the right region.
 */

import type { Connection } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { HeadMatches, MatchAny, TailMatches } from './matcher.js';
import {
  Query_for_list_of_databases,
  Query_for_list_of_extensions,
  Query_for_list_of_functions,
  Query_for_list_of_indexes,
  Query_for_list_of_languages,
  Query_for_list_of_matviews,
  Query_for_list_of_relations_in_schema,
  Query_for_list_of_roles,
  Query_for_list_of_schemas,
  Query_for_list_of_sequences,
  Query_for_list_of_tables,
  Query_for_list_of_tables_views,
  Query_for_list_of_tablespaces,
  Query_for_list_of_types,
  Query_for_list_of_views,
  runCatalogQuery,
} from './queries.js';
import {
  ENCODINGS,
  PSET_OPTIONS,
  SPECIAL_VARIABLES,
  psetValuesFor,
  variableValuesFor,
} from './psqlVars.js';

export type CompleteContext = {
  /** Lazy: re-read from settings.db on every call so `\c` updates take effect. */
  conn?: Connection | null;
  settings: PsqlSettings;
};

/** Backslash command names psql tab-completes (mirrors backslash_commands[]). */
export const BACKSLASH_COMMANDS: readonly string[] = [
  '\\a',
  '\\bind',
  '\\bind_named',
  '\\c',
  '\\C',
  '\\cd',
  '\\close_prepared',
  '\\conninfo',
  '\\connect',
  '\\copy',
  '\\copyright',
  '\\crosstabview',
  '\\d',
  '\\dA',
  '\\dAc',
  '\\dAf',
  '\\dAo',
  '\\dAp',
  '\\da',
  '\\db',
  '\\dC',
  '\\dc',
  '\\dconfig',
  '\\dD',
  '\\dd',
  '\\ddp',
  '\\dE',
  '\\des',
  '\\det',
  '\\deu',
  '\\dew',
  '\\df',
  '\\dF',
  '\\dFd',
  '\\dFp',
  '\\dFt',
  '\\dg',
  '\\di',
  '\\dl',
  '\\dL',
  '\\dm',
  '\\dn',
  '\\do',
  '\\dO',
  '\\dp',
  '\\dP',
  '\\dPi',
  '\\dPt',
  '\\drds',
  '\\drg',
  '\\dRs',
  '\\dRp',
  '\\ds',
  '\\dt',
  '\\dT',
  '\\dv',
  '\\du',
  '\\dx',
  '\\dX',
  '\\dy',
  '\\echo',
  '\\edit',
  '\\ef',
  '\\elif',
  '\\else',
  '\\encoding',
  '\\endif',
  '\\endpipeline',
  '\\errverbose',
  '\\ev',
  '\\f',
  '\\flush',
  '\\flushrequest',
  '\\g',
  '\\gdesc',
  '\\getenv',
  '\\getresults',
  '\\gexec',
  '\\gset',
  '\\gx',
  '\\help',
  '\\html',
  '\\if',
  '\\include',
  '\\include_relative',
  '\\ir',
  '\\l',
  '\\list',
  '\\lo_export',
  '\\lo_import',
  '\\lo_list',
  '\\lo_unlink',
  '\\o',
  '\\out',
  '\\parse',
  '\\password',
  '\\print',
  '\\prompt',
  '\\pset',
  '\\q',
  '\\qecho',
  '\\quit',
  '\\reset',
  '\\restrict',
  '\\s',
  '\\sendpipeline',
  '\\set',
  '\\setenv',
  '\\sf',
  '\\startpipeline',
  '\\sv',
  '\\syncpipeline',
  '\\t',
  '\\T',
  '\\timing',
  '\\unrestrict',
  '\\unset',
  '\\w',
  '\\warn',
  '\\watch',
  '\\write',
  '\\x',
  '\\z',
  '\\!',
  '\\?',
];

/** Top-level SQL statement keywords. */
export const SQL_TOP_KEYWORDS: readonly string[] = [
  'ABORT',
  'ALTER',
  'ANALYZE',
  'BEGIN',
  'CALL',
  'CHECKPOINT',
  'CLOSE',
  'CLUSTER',
  'COMMENT',
  'COMMIT',
  'COPY',
  'CREATE',
  'DEALLOCATE',
  'DECLARE',
  'DELETE FROM',
  'DISCARD',
  'DO',
  'DROP',
  'END',
  'EXECUTE',
  'EXPLAIN',
  'FETCH',
  'GRANT',
  'IMPORT',
  'INSERT INTO',
  'LISTEN',
  'LOAD',
  'LOCK',
  'MERGE',
  'MOVE',
  'NOTIFY',
  'PREPARE',
  'REASSIGN',
  'REFRESH MATERIALIZED VIEW',
  'REINDEX',
  'RELEASE',
  'RESET',
  'REVOKE',
  'ROLLBACK',
  'SAVEPOINT',
  'SECURITY LABEL',
  'SELECT',
  'SET',
  'SHOW',
  'START TRANSACTION',
  'TABLE',
  'TRUNCATE',
  'UNLISTEN',
  'UPDATE',
  'VACUUM',
  'VALUES',
  'WITH',
];

/** Keywords accepted after CREATE. */
export const CREATE_OBJECTS: readonly string[] = [
  'ACCESS METHOD',
  'AGGREGATE',
  'CAST',
  'COLLATION',
  'CONVERSION',
  'DATABASE',
  'DEFAULT PRIVILEGES',
  'DOMAIN',
  'EVENT TRIGGER',
  'EXTENSION',
  'FOREIGN DATA WRAPPER',
  'FOREIGN TABLE',
  'FUNCTION',
  'GLOBAL',
  'GROUP',
  'INDEX',
  'LANGUAGE',
  'LOCAL',
  'MATERIALIZED VIEW',
  'OPERATOR',
  'OR REPLACE',
  'POLICY',
  'PROCEDURE',
  'PUBLICATION',
  'ROLE',
  'RULE',
  'SCHEMA',
  'SEQUENCE',
  'SERVER',
  'STATISTICS',
  'SUBSCRIPTION',
  'TABLE',
  'TABLESPACE',
  'TEMP',
  'TEMPORARY',
  'TEXT SEARCH',
  'TRANSFORM',
  'TRIGGER',
  'TYPE',
  'UNIQUE',
  'UNLOGGED',
  'USER',
  'VIEW',
];

/** Keywords accepted after DROP. */
export const DROP_OBJECTS: readonly string[] = [
  'ACCESS METHOD',
  'AGGREGATE',
  'CAST',
  'COLLATION',
  'CONVERSION',
  'DATABASE',
  'DOMAIN',
  'EVENT TRIGGER',
  'EXTENSION',
  'FOREIGN DATA WRAPPER',
  'FOREIGN TABLE',
  'FUNCTION',
  'GROUP',
  'INDEX',
  'LANGUAGE',
  'MATERIALIZED VIEW',
  'OPERATOR',
  'OWNED',
  'POLICY',
  'PROCEDURE',
  'PUBLICATION',
  'ROLE',
  'RULE',
  'SCHEMA',
  'SEQUENCE',
  'SERVER',
  'STATISTICS',
  'SUBSCRIPTION',
  'TABLE',
  'TABLESPACE',
  'TEXT SEARCH',
  'TRANSFORM',
  'TRIGGER',
  'TYPE',
  'USER',
  'VIEW',
];

/** Keywords accepted after ALTER. */
export const ALTER_OBJECTS: readonly string[] = [
  'AGGREGATE',
  'COLLATION',
  'CONVERSION',
  'DATABASE',
  'DEFAULT PRIVILEGES',
  'DOMAIN',
  'EVENT TRIGGER',
  'EXTENSION',
  'FOREIGN DATA WRAPPER',
  'FOREIGN TABLE',
  'FUNCTION',
  'GROUP',
  'INDEX',
  'LANGUAGE',
  'LARGE OBJECT',
  'MATERIALIZED VIEW',
  'OPERATOR',
  'POLICY',
  'PROCEDURE',
  'PUBLICATION',
  'ROLE',
  'RULE',
  'SCHEMA',
  'SEQUENCE',
  'SERVER',
  'STATISTICS',
  'SUBSCRIPTION',
  'SYSTEM',
  'TABLE',
  'TABLESPACE',
  'TEXT SEARCH',
  'TRIGGER',
  'TYPE',
  'USER',
  'VIEW',
];

/** Few common sub-actions for ALTER TABLE. */
export const ALTER_TABLE_ACTIONS: readonly string[] = [
  'ADD',
  'ALTER',
  'ATTACH PARTITION',
  'CLUSTER ON',
  'DETACH PARTITION',
  'DISABLE',
  'DROP',
  'ENABLE',
  'INHERIT',
  'NO INHERIT',
  'OWNER TO',
  'RENAME',
  'RESET',
  'SET',
  'VALIDATE CONSTRAINT',
];

/** GRANT / REVOKE privileges. */
export const PRIVILEGE_KEYWORDS: readonly string[] = [
  'ALL',
  'CREATE',
  'CONNECT',
  'DELETE',
  'EXECUTE',
  'INSERT',
  'REFERENCES',
  'SELECT',
  'TEMPORARY',
  'TRIGGER',
  'TRUNCATE',
  'UPDATE',
  'USAGE',
];

/** Common transaction/savepoint keywords. */
export const TRANSACTION_KEYWORDS: readonly string[] = [
  'ISOLATION LEVEL',
  'READ ONLY',
  'READ WRITE',
  'TRANSACTION',
];

// ---------------------------------------------------------------------------
// Result shape.
// ---------------------------------------------------------------------------

export type RuleResult = {
  /** Matching completion candidates. */
  candidates: string[];
};

/**
 * Apply a case-insensitive prefix filter. Empty `prefix` returns the whole
 * list. The match honours `compCase` — uppercase the candidates when the
 * user is typing in uppercase, etc.
 */
const filterAndCase = (
  candidates: readonly string[],
  prefix: string,
  settings: PsqlSettings,
): string[] => {
  const lowPrefix = prefix.toLowerCase();
  const result: string[] = [];
  for (const c of candidates) {
    if (c.toLowerCase().startsWith(lowPrefix)) {
      result.push(applyCase(c, prefix, settings));
    }
  }
  return result;
};

/**
 * Render a candidate with the case psql would use. Default psql behaviour
 * is COMP_KEYWORD_CASE = preserve-upper: if the user is typing uppercase,
 * keep candidate uppercase; otherwise emit lowercase.
 */
const applyCase = (
  candidate: string,
  typed: string,
  settings: PsqlSettings,
): string => {
  // Identifiers (already quoted, starts with ", or already lowercase) are
  // never re-cased.
  if (candidate.startsWith('"') || candidate.startsWith("'")) return candidate;
  // Catalog query results are always quoted-or-lowercase by virtue of
  // quote_ident; pass them through unchanged.
  if (containsNonKeywordChar(candidate)) return candidate;

  const mode = settings.compCase;
  const typedIsUpper = typed.length > 0 && typed === typed.toUpperCase();
  switch (mode) {
    case 'lower':
      return candidate.toLowerCase();
    case 'upper':
      return candidate.toUpperCase();
    case 'preserve-lower':
      return typedIsUpper ? candidate.toUpperCase() : candidate.toLowerCase();
    case 'preserve-upper':
    default:
      return typedIsUpper ? candidate.toUpperCase() : candidate.toLowerCase();
  }
};

const containsNonKeywordChar = (s: string): boolean => /[^A-Za-z0-9 ]/.test(s);

/**
 * Split a candidate like `pg_catalog.tab_` into [schema, prefix]. Returns
 * `null` if there's no schema qualifier.
 */
const splitSchemaPrefix = (
  word: string,
): { schema: string; prefix: string } | null => {
  const dot = word.indexOf('.');
  if (dot < 0) return null;
  // Reject if anything after the dot looks like another dot (we only handle
  // schema.relation, not catalog.schema.relation).
  const after = word.slice(dot + 1);
  if (after.includes('.')) return null;
  // Strip optional quoting on the schema.
  let schema = word.slice(0, dot);
  if (schema.startsWith('"') && schema.endsWith('"')) {
    schema = schema.slice(1, -1).replace(/""/g, '"');
  }
  return { schema, prefix: after };
};

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Top-level rule dispatch.
 *
 * `prevWords` are the tokens BEFORE the current (in-progress) word; the
 * current word's leading characters are what we're filtering candidates
 * against.
 */
export const findCompletions = async (
  prevWords: string[],
  currentWord: string,
  ctx: CompleteContext,
): Promise<RuleResult> => {
  // Re-read the connection on every call so `\c` is picked up immediately.
  const conn = ctx.settings.db ?? ctx.conn ?? null;

  // ----- Variable expansion (`:NAME`) takes priority over anything else.
  if (currentWord.startsWith(':') && !currentWord.startsWith('::')) {
    const prefix = currentWord.slice(1);
    const names = listVarNames(ctx.settings);
    const filt = names
      .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
      .map((n) => ':' + n);
    return { candidates: filt };
  }

  // ----- Backslash-command name completion.
  // Trigger: the user is mid-token and the token starts with '\'.
  if (currentWord.startsWith('\\') && prevWords.length === 0) {
    return {
      candidates: BACKSLASH_COMMANDS.filter((c) =>
        c.toLowerCase().startsWith(currentWord.toLowerCase()),
      ),
    };
  }

  // ----- Backslash-command argument completion.
  if (prevWords.length > 0 && prevWords[0].startsWith('\\')) {
    return await backslashArgRules(prevWords, currentWord, ctx, conn);
  }

  // ----- SQL: top-of-statement keyword completion.
  if (prevWords.length === 0) {
    return {
      candidates: filterAndCase(SQL_TOP_KEYWORDS, currentWord, ctx.settings),
    };
  }

  return await sqlRules(prevWords, currentWord, ctx, conn);
};

// ---------------------------------------------------------------------------
// Backslash arg rules.
// ---------------------------------------------------------------------------

const backslashArgRules = async (
  prevWords: string[],
  currentWord: string,
  ctx: CompleteContext,
  conn: Connection | null,
): Promise<RuleResult> => {
  const cmd = prevWords[0]; // e.g. '\dt'

  // \c [DBNAME], \connect [DBNAME]: complete database names.
  if (cmd === '\\c' || cmd === '\\connect') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_databases,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \dn[+] [schema]
  if (cmd === '\\dn' || cmd === '\\dn+') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_schemas,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \df, \dfa, \dfn, \dfp, \dft, \dfw, \ef, \sf
  if (
    cmd === '\\df' ||
    cmd === '\\df+' ||
    cmd === '\\dfa' ||
    cmd === '\\dfn' ||
    cmd === '\\dfp' ||
    cmd === '\\dft' ||
    cmd === '\\dfw' ||
    cmd === '\\ef' ||
    cmd === '\\sf' ||
    cmd === '\\sf+'
  ) {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_functions,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \du, \dg → roles.
  if (cmd === '\\du' || cmd === '\\dg' || cmd === '\\du+' || cmd === '\\dg+') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_roles,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \dx → extensions.
  if (cmd === '\\dx' || cmd === '\\dx+') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_extensions,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \dL → languages.
  if (cmd === '\\dL' || cmd === '\\dL+') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_languages,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \dT → types.
  if (cmd === '\\dT' || cmd === '\\dT+') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_types,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \dt / \dtv / \d / \dv / \dm / \di / \ds → relations of various kinds.
  if (
    cmd === '\\dt' ||
    cmd === '\\dt+' ||
    cmd === '\\dtv' ||
    cmd === '\\d' ||
    cmd === '\\d+' ||
    cmd === '\\dE' ||
    cmd === '\\dE+'
  ) {
    if (prevWords.length === 1 && conn) {
      return {
        candidates: await completeSchemaOrRelations(
          conn,
          currentWord,
          Query_for_list_of_tables,
        ),
      };
    }
    return { candidates: [] };
  }
  if (cmd === '\\dv' || cmd === '\\dv+') {
    if (prevWords.length === 1 && conn) {
      return {
        candidates: await completeSchemaOrRelations(
          conn,
          currentWord,
          Query_for_list_of_views,
        ),
      };
    }
    return { candidates: [] };
  }
  if (cmd === '\\dm' || cmd === '\\dm+') {
    if (prevWords.length === 1 && conn) {
      return {
        candidates: await completeSchemaOrRelations(
          conn,
          currentWord,
          Query_for_list_of_matviews,
        ),
      };
    }
    return { candidates: [] };
  }
  if (cmd === '\\di' || cmd === '\\di+') {
    if (prevWords.length === 1 && conn) {
      return {
        candidates: await completeSchemaOrRelations(
          conn,
          currentWord,
          Query_for_list_of_indexes,
        ),
      };
    }
    return { candidates: [] };
  }
  if (cmd === '\\ds' || cmd === '\\ds+') {
    if (prevWords.length === 1 && conn) {
      return {
        candidates: await completeSchemaOrRelations(
          conn,
          currentWord,
          Query_for_list_of_sequences,
        ),
      };
    }
    return { candidates: [] };
  }

  // \l[+] / \list → databases.
  if (
    cmd === '\\l' ||
    cmd === '\\l+' ||
    cmd === '\\list' ||
    cmd === '\\list+'
  ) {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_databases,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \encoding NAME
  if (cmd === '\\encoding') {
    if (prevWords.length === 1) {
      return { candidates: filterCi(ENCODINGS, currentWord) };
    }
    return { candidates: [] };
  }

  // \pset OPT [value]
  if (cmd === '\\pset') {
    if (prevWords.length === 1) {
      return { candidates: filterCi(PSET_OPTIONS, currentWord) };
    }
    if (prevWords.length === 2) {
      const values = psetValuesFor(prevWords[1].toLowerCase());
      if (values) return { candidates: filterCi(values, currentWord) };
      return { candidates: [] };
    }
    return { candidates: [] };
  }

  // \set NAME [VALUE]
  if (cmd === '\\set') {
    if (prevWords.length === 1) {
      return {
        candidates: filterCi(listAllVarNames(ctx.settings), currentWord),
      };
    }
    if (prevWords.length === 2) {
      const values = variableValuesFor(prevWords[1].toUpperCase());
      if (values) return { candidates: filterCi(values, currentWord) };
      return { candidates: [] };
    }
    return { candidates: [] };
  }

  // \unset NAME — only existing variables.
  if (cmd === '\\unset') {
    if (prevWords.length === 1) {
      return { candidates: filterCi(listVarNames(ctx.settings), currentWord) };
    }
    return { candidates: [] };
  }

  // \echo / \warn / \qecho — variable expansion only (handled above).
  // \prompt — variable name argument is the 1st positional.
  if (cmd === '\\prompt') {
    if (prevWords.length === 2) {
      return {
        candidates: filterCi(listAllVarNames(ctx.settings), currentWord),
      };
    }
    return { candidates: [] };
  }

  // \drds, \drg → roles (for the first arg).
  if (cmd === '\\drds' || cmd === '\\drg') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_roles,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // Anything else: no completion.
  return { candidates: [] };
};

// ---------------------------------------------------------------------------
// SQL rules.
// ---------------------------------------------------------------------------

const sqlRules = async (
  prevWords: string[],
  currentWord: string,
  ctx: CompleteContext,
  conn: Connection | null,
): Promise<RuleResult> => {
  // Convenience: most rules want to fall back to a "tables" lookup. We
  // factor that into a single helper.
  const completeTables = async (
    query: string = Query_for_list_of_tables,
  ): Promise<RuleResult> => {
    if (!conn) return { candidates: [] };
    return {
      candidates: await completeSchemaOrRelations(conn, currentWord, query),
    };
  };

  // FROM <prefix>: tables/views/matviews.
  if (TailMatches(prevWords, ['FROM'])) {
    return completeTables(Query_for_list_of_tables_views);
  }
  // After FROM x, suggest JOIN/WHERE/etc — handled below.

  // UPDATE <prefix>: tables.
  if (TailMatches(prevWords, ['UPDATE'])) return completeTables();

  // DELETE FROM <prefix>: tables.
  if (TailMatches(prevWords, ['DELETE', 'FROM'])) return completeTables();

  // INSERT INTO <prefix>: tables. The tokenizer might give us
  // ['INSERT'] [INTO] or ['INSERT', 'INTO'] depending on whether the user
  // typed an extra space.
  if (TailMatches(prevWords, ['INTO'])) return completeTables();

  // JOIN <prefix>: tables. Most common: SELECT … FROM x JOIN <prefix>.
  if (TailMatches(prevWords, ['JOIN'])) {
    return completeTables(Query_for_list_of_tables_views);
  }
  // After JOIN x, suggest ON. Cheap rule.
  if (TailMatches(prevWords, ['JOIN', MatchAny])) {
    return {
      candidates: filterAndCase(['ON', 'USING'], currentWord, ctx.settings),
    };
  }

  // ALTER TABLE — table name.
  if (TailMatches(prevWords, ['ALTER', 'TABLE'])) return completeTables();
  // ALTER TABLE x — sub-actions.
  if (TailMatches(prevWords, ['ALTER', 'TABLE', MatchAny])) {
    return {
      candidates: filterAndCase(ALTER_TABLE_ACTIONS, currentWord, ctx.settings),
    };
  }

  // ALTER VIEW — view names.
  if (TailMatches(prevWords, ['ALTER', 'VIEW'])) {
    return completeTables(Query_for_list_of_views);
  }
  if (TailMatches(prevWords, ['ALTER', 'MATERIALIZED', 'VIEW'])) {
    return completeTables(Query_for_list_of_matviews);
  }
  if (TailMatches(prevWords, ['ALTER', 'INDEX'])) {
    return completeTables(Query_for_list_of_indexes);
  }
  if (TailMatches(prevWords, ['ALTER', 'SEQUENCE'])) {
    return completeTables(Query_for_list_of_sequences);
  }
  if (TailMatches(prevWords, ['ALTER', 'TYPE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_types,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'EXTENSION'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_extensions,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'SCHEMA'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_schemas,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'ROLE|USER|GROUP'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_roles,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'DATABASE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_databases,
        currentWord,
      ),
    };
  }
  // Bare ALTER — sub-object keywords.
  if (TailMatches(prevWords, ['ALTER'])) {
    return {
      candidates: filterAndCase(ALTER_OBJECTS, currentWord, ctx.settings),
    };
  }

  // DROP TABLE, DROP VIEW, DROP INDEX, ...
  if (TailMatches(prevWords, ['DROP', 'TABLE'])) return completeTables();
  if (TailMatches(prevWords, ['DROP', 'VIEW'])) {
    return completeTables(Query_for_list_of_views);
  }
  if (TailMatches(prevWords, ['DROP', 'MATERIALIZED', 'VIEW'])) {
    return completeTables(Query_for_list_of_matviews);
  }
  if (TailMatches(prevWords, ['DROP', 'INDEX'])) {
    return completeTables(Query_for_list_of_indexes);
  }
  if (TailMatches(prevWords, ['DROP', 'SEQUENCE'])) {
    return completeTables(Query_for_list_of_sequences);
  }
  if (TailMatches(prevWords, ['DROP', 'TYPE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_types,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'SCHEMA'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_schemas,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'EXTENSION'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_extensions,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'ROLE|USER|GROUP'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_roles,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'DATABASE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_databases,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'FUNCTION'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_functions,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'LANGUAGE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_languages,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'TABLESPACE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_tablespaces,
        currentWord,
      ),
    };
  }
  // Bare DROP — sub-object keywords.
  if (TailMatches(prevWords, ['DROP'])) {
    return {
      candidates: filterAndCase(DROP_OBJECTS, currentWord, ctx.settings),
    };
  }

  // CREATE ... — first sub-object keyword.
  if (TailMatches(prevWords, ['CREATE'])) {
    return {
      candidates: filterAndCase(CREATE_OBJECTS, currentWord, ctx.settings),
    };
  }
  if (TailMatches(prevWords, ['CREATE', 'TABLE'])) {
    // Free-form table name; no completion.
    return { candidates: [] };
  }
  if (TailMatches(prevWords, ['CREATE', 'INDEX', MatchAny, 'ON'])) {
    return completeTables();
  }
  if (TailMatches(prevWords, ['CREATE', 'OR', 'REPLACE'])) {
    return {
      candidates: filterAndCase(
        ['FUNCTION', 'PROCEDURE', 'VIEW', 'TRIGGER', 'AGGREGATE', 'TRANSFORM'],
        currentWord,
        ctx.settings,
      ),
    };
  }

  // TRUNCATE [TABLE] x
  if (TailMatches(prevWords, ['TRUNCATE'])) {
    return {
      candidates: [
        ...filterAndCase(['TABLE', 'ONLY'], currentWord, ctx.settings),
        ...(await tableCandidates(conn, currentWord)),
      ],
    };
  }
  if (TailMatches(prevWords, ['TRUNCATE', 'TABLE'])) return completeTables();
  if (TailMatches(prevWords, ['TRUNCATE', 'ONLY'])) return completeTables();

  // COPY x → tables.
  if (TailMatches(prevWords, ['COPY'])) return completeTables();
  if (TailMatches(prevWords, ['COPY', MatchAny])) {
    return {
      candidates: filterAndCase(['FROM', 'TO'], currentWord, ctx.settings),
    };
  }

  // ANALYZE x → tables (optional VERBOSE first).
  if (
    TailMatches(prevWords, ['ANALYZE']) ||
    TailMatches(prevWords, ['ANALYZE', 'VERBOSE'])
  ) {
    return completeTables();
  }

  // VACUUM x → tables.
  if (
    TailMatches(prevWords, ['VACUUM']) ||
    TailMatches(prevWords, ['VACUUM', 'VERBOSE'])
  ) {
    return completeTables();
  }
  if (TailMatches(prevWords, ['VACUUM', 'FULL'])) return completeTables();
  if (TailMatches(prevWords, ['VACUUM', 'ANALYZE'])) return completeTables();

  // REINDEX [TABLE|INDEX|SCHEMA|DATABASE] x
  if (TailMatches(prevWords, ['REINDEX'])) {
    return {
      candidates: filterAndCase(
        ['TABLE', 'INDEX', 'SCHEMA', 'DATABASE', 'SYSTEM', 'CONCURRENTLY'],
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['REINDEX', 'TABLE'])) return completeTables();
  if (TailMatches(prevWords, ['REINDEX', 'INDEX'])) {
    return completeTables(Query_for_list_of_indexes);
  }
  if (TailMatches(prevWords, ['REINDEX', 'SCHEMA'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_schemas,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['REINDEX', 'DATABASE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_databases,
        currentWord,
      ),
    };
  }

  // GRANT … ON … TO …
  if (TailMatches(prevWords, ['GRANT']) || TailMatches(prevWords, ['REVOKE'])) {
    return {
      candidates: filterAndCase(PRIVILEGE_KEYWORDS, currentWord, ctx.settings),
    };
  }
  if (TailMatches(prevWords, ['ON'])) {
    // Could be either GRANT/REVOKE … ON or CREATE INDEX … ON. We try
    // tables; if the prior keyword set is CREATE INDEX the rule above
    // already short-circuited.
    return completeTables();
  }
  if (TailMatches(prevWords, ['TO'])) {
    if (HeadMatches(prevWords, ['GRANT']) && conn) {
      return {
        candidates: await runCatalogQuery(
          conn,
          Query_for_list_of_roles,
          currentWord,
        ),
      };
    }
  }
  if (TailMatches(prevWords, ['FROM']) && HeadMatches(prevWords, ['REVOKE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_roles,
        currentWord,
      ),
    };
  }

  // LOCK [TABLE] x
  if (TailMatches(prevWords, ['LOCK'])) {
    return {
      candidates: [
        ...filterAndCase(['TABLE'], currentWord, ctx.settings),
        ...(await tableCandidates(conn, currentWord)),
      ],
    };
  }
  if (TailMatches(prevWords, ['LOCK', 'TABLE'])) return completeTables();

  // SET search_path, SET ROLE, SET SCHEMA, etc.
  if (TailMatches(prevWords, ['SET', 'ROLE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_roles,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['SET', 'SCHEMA'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_schemas,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['SET', 'SESSION'])) {
    return {
      candidates: filterAndCase(
        ['AUTHORIZATION', 'CHARACTERISTICS AS TRANSACTION'],
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['SET', 'TRANSACTION'])) {
    return {
      candidates: filterAndCase(
        ['ISOLATION LEVEL', 'READ ONLY', 'READ WRITE', 'DEFERRABLE'],
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['SET'])) {
    return {
      candidates: filterAndCase(
        [
          'ROLE',
          'SCHEMA',
          'SESSION',
          'LOCAL',
          'TRANSACTION',
          'TIME ZONE',
          'CONSTRAINTS',
        ],
        currentWord,
        ctx.settings,
      ),
    };
  }

  // SHOW … — most GUC names, common ones.
  if (TailMatches(prevWords, ['SHOW'])) {
    return {
      candidates: filterAndCase(
        [
          'ALL',
          'search_path',
          'role',
          'session_authorization',
          'transaction_isolation',
          'client_encoding',
          'server_encoding',
          'server_version',
          'timezone',
        ],
        currentWord,
        ctx.settings,
      ),
    };
  }

  // START / BEGIN [TRANSACTION] …
  if (TailMatches(prevWords, ['BEGIN']) || TailMatches(prevWords, ['START'])) {
    return {
      candidates: filterAndCase(
        TRANSACTION_KEYWORDS,
        currentWord,
        ctx.settings,
      ),
    };
  }

  // COMMIT / ROLLBACK / RELEASE / SAVEPOINT - small completions
  if (TailMatches(prevWords, ['ROLLBACK'])) {
    return {
      candidates: filterAndCase(
        ['TO SAVEPOINT', 'TRANSACTION', 'AND CHAIN', 'AND NO CHAIN'],
        currentWord,
        ctx.settings,
      ),
    };
  }

  // EXPLAIN … — pass through to SELECT-/INSERT-/UPDATE-style rules by
  // letting subsequent words drive completion. For the first word after
  // EXPLAIN, offer the options + statement keywords.
  if (TailMatches(prevWords, ['EXPLAIN'])) {
    return {
      candidates: filterAndCase(
        [
          'ANALYZE',
          'VERBOSE',
          'SELECT',
          'INSERT INTO',
          'UPDATE',
          'DELETE FROM',
          '(',
        ],
        currentWord,
        ctx.settings,
      ),
    };
  }

  // DECLARE … CURSOR FOR …
  if (TailMatches(prevWords, ['DECLARE'])) {
    return { candidates: [] };
  }

  // CALL / DO — no completion beyond keywords (procedure args / language).
  if (TailMatches(prevWords, ['CALL'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_functions,
        currentWord,
      ),
    };
  }

  // After SELECT — offer FROM / common functions.
  if (TailMatches(prevWords, ['SELECT'])) {
    // The next word can be anything (column list); offer DISTINCT/ALL/* as a
    // small hint set.
    return {
      candidates: filterAndCase(
        [
          'DISTINCT',
          'ALL',
          '*',
          'CURRENT_DATE',
          'CURRENT_TIME',
          'CURRENT_TIMESTAMP',
          'CURRENT_USER',
          'NULL',
          'TRUE',
          'FALSE',
        ],
        currentWord,
        ctx.settings,
      ),
    };
  }

  // Trailing-keyword fallthrough: WHERE, ORDER BY, GROUP BY, LIMIT etc.
  if (TailMatches(prevWords, ['SELECT', '*'])) {
    return { candidates: filterAndCase(['FROM'], currentWord, ctx.settings) };
  }

  // No specific rule fired.
  return { candidates: [] };
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Candidates for table-name completion, no schema-qualifier handling. */
const tableCandidates = async (
  conn: Connection | null,
  word: string,
): Promise<string[]> => {
  if (!conn) return [];
  return runCatalogQuery(conn, Query_for_list_of_tables, word);
};

/**
 * Schema-aware relation completion. If the user typed `schema.x`, fetch
 * relations in `schema` matching `x`. Otherwise fetch unqualified relations
 * AND a list of schemas (so the user can dot through).
 */
const completeSchemaOrRelations = async (
  conn: Connection,
  word: string,
  query: string,
): Promise<string[]> => {
  const split = splitSchemaPrefix(word);
  if (split) {
    const rows = await runCatalogQuery(
      conn,
      Query_for_list_of_relations_in_schema,
      split.prefix,
      [split.schema],
    );
    // Re-prefix with the schema name.
    return rows.map((r) => split.schema + '.' + r);
  }
  return runCatalogQuery(conn, query, word);
};

/** Case-insensitive prefix filter; preserves the candidate's original casing. */
const filterCi = (candidates: readonly string[], prefix: string): string[] => {
  if (prefix.length === 0) return candidates.slice();
  const lp = prefix.toLowerCase();
  return candidates.filter((c) => c.toLowerCase().startsWith(lp));
};

/** Names of variables currently SET on the settings (for `\unset` etc). */
const listVarNames = (settings: PsqlSettings): string[] => {
  const out: string[] = [];
  for (const [name] of settings.vars.entries()) out.push(name);
  return out.sort();
};

/** Both currently-set variables AND special-variable names. */
const listAllVarNames = (settings: PsqlSettings): string[] => {
  const set = new Set<string>();
  for (const [name] of settings.vars.entries()) set.add(name);
  for (const n of SPECIAL_VARIABLES) set.add(n);
  return [...set].sort();
};

// Re-exported so the index entrypoint can implement its own splitting helper
// using the same prefix logic.
export const _internals = { splitSchemaPrefix };
