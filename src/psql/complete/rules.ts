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
 *     `\dx`, `\dL`, `\dT`, `\do` (operators), `\dC` (casts), `\encoding`,
 *     `\pset`, `\set`.
 *   - Top-level SQL keyword set (SELECT/INSERT/UPDATE/DELETE/etc).
 *   - Mid-statement object completion in the most common contexts:
 *       FROM            → tables/views/matviews/foreign tables.
 *       INTO (INSERT)   → tables.
 *       JOIN            → tables/views/matviews.
 *       UPDATE          → tables.
 *       DELETE FROM     → tables.
 *       ALTER TABLE     → tables, then sub-action (ADD/DROP/…),
 *                         then sub-action continuation (COLUMN/CONSTRAINT/…).
 *       ALTER VIEW      → views + sub-actions.
 *       ALTER MATERIALIZED VIEW → mat-views + sub-actions.
 *       ALTER INDEX     → indexes + sub-actions.
 *       ALTER SEQUENCE  → sequences + sub-actions.
 *       ALTER FUNCTION / PROCEDURE / ROUTINE → functions + sub-actions.
 *       ALTER TYPE      → types + sub-actions.
 *       ALTER ROLE/USER → roles + sub-actions.
 *       ALTER DATABASE  → databases + sub-actions.
 *       ALTER SCHEMA    → schemas + sub-actions.
 *       ALTER EXTENSION → extensions + sub-actions.
 *       ALTER POLICY    → ON <table>, rename/owner.
 *       ALTER PUBLICATION / SUBSCRIPTION → sub-actions.
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
 *       CREATE INDEX    → CONCURRENTLY / IF NOT EXISTS / ON / USING (access methods).
 *       GRANT / REVOKE … ON … → tables.
 *       TRUNCATE [TABLE] → tables.
 *       LOCK TABLE      → tables.
 *       COPY            → tables.
 *       ANALYZE / VACUUM → tables.
 *       REINDEX         → indexes/tables/databases (limited).
 *       SET <guc>       → list of GUC names from pg_settings.
 *       SET ROLE        → roles.
 *       SET SCHEMA      → schemas.
 *       SHOW <guc>      → list of GUC names from pg_settings.
 *       RESET <guc>     → list of GUC names from pg_settings.
 *
 *   - Window-function clauses: `OVER (` → PARTITION BY / ORDER BY / RANGE /
 *     ROWS / GROUPS.
 *   - Generic post-FROM/JOIN tail keywords: JOIN, WHERE, GROUP BY, ORDER BY,
 *     LIMIT, OFFSET, UNION, INTERSECT, EXCEPT, etc.
 *   - WHERE-expression continuations: AND / OR / IS / IN / NOT / BETWEEN.
 *   - `\set`/`\unset`: completion of psql variable names.
 *   - Variable expansion `:NAME` completion (inside any line).
 *
 * Upstream coverage notes (psql `tab-complete.in.c`):
 *   - We ported the ALTER-OBJECT arms around lines 2050-2700 (sub-actions
 *     for TABLE/VIEW/MV/INDEX/SEQUENCE/FUNCTION/TYPE/ROLE/DB/SCHEMA/
 *     EXTENSION/POLICY/PUBLICATION/SUBSCRIPTION) but elided the deep
 *     option-value continuations (e.g. ALTER TABLE … ADD CONSTRAINT …
 *     CHECK (…)) and partition-bound clauses.
 *   - We ported the post-FROM / JOIN tail-keyword set from lines ~4500-4700.
 *   - We ported the SET/SHOW/RESET GUC lookup from lines ~5500-5700, using
 *     a live pg_settings query rather than a static list.
 *   - We ported the CREATE INDEX block at ~3000-3100.
 *   - Skipped: ALTER-system fine-grained options, COMMENT ON full grammar,
 *     CREATE STATISTICS, CREATE EVENT TRIGGER bodies, FDW/USER MAPPING
 *     argument grammar, and most GRANT/REVOKE class continuations beyond
 *     the table object form.
 *
 * What's intentionally still stubbed:
 *
 *   - psql `\h` SQL help index — exists in psql proper, would need the
 *     help index data.
 *   - Column-name completion after `SELECT … FROM t WHERE` (we don't carry
 *     a parsed alias→relation map; upstream parses the FROM clause).
 *
 * The shape mirrors the C source closely enough that adding new rules is
 * mechanical: drop a new `if (TailMatches(...))` arm in the right region.
 */

import type { Connection } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { completeFilenames, isCopyFromOrTo } from './filenames.js';
import { HeadMatches, MatchAny, TailMatches } from './matcher.js';
import {
  Query_for_constraint_of_table,
  Query_for_constraint_of_table_in_schema,
  Query_for_list_of_casts,
  Query_for_list_of_databases,
  Query_for_list_of_datatypes,
  Query_for_list_of_enum_values_quoted,
  Query_for_list_of_extensions,
  Query_for_list_of_functions,
  Query_for_list_of_index_access_methods,
  Query_for_list_of_indexes,
  Query_for_list_of_languages,
  Query_for_list_of_matviews,
  Query_for_list_of_operators,
  Query_for_list_of_publications,
  Query_for_list_of_relations_in_schema,
  Query_for_list_of_roles,
  Query_for_list_of_schemas,
  Query_for_list_of_sequences,
  Query_for_list_of_set_vars,
  Query_for_list_of_subscriptions,
  Query_for_list_of_tables,
  Query_for_list_of_tables_views,
  Query_for_list_of_tablespaces,
  Query_for_list_of_timezone_names_quoted_in,
  Query_for_list_of_timezone_names_quoted_out,
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
  /**
   * In-flight multi-line query buffer (raw, pre-scan text) accumulated by the
   * REPL on previous lines of the current statement. Empty when the user is
   * starting a fresh statement. Rules that need cross-line context (e.g.
   * `ANALYZE (` opened on a previous line, or `COMMENT ON CONSTRAINT … ON`
   * spanning lines) inspect this buffer themselves — the rule engine doesn't
   * re-tokenize it because the `prevWords` tail-match grammar is already
   * pinned to the current line.
   *
   * Optional / defaults to empty string: rules that only care about the
   * current line ignore it, and unit tests can construct a context without
   * a buffer.
   */
  queryBuf?: string;
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

/** Sub-actions for ALTER TABLE. */
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
  'OF',
  'NOT OF',
  'OWNER TO',
  'RENAME',
  'REPLICA IDENTITY',
  'RESET',
  'SET',
  'VALIDATE CONSTRAINT',
];

/** Continuation after `ALTER TABLE x ADD`. */
export const ALTER_TABLE_ADD: readonly string[] = [
  'COLUMN',
  'CONSTRAINT',
  'CHECK',
  'FOREIGN KEY',
  'PRIMARY KEY',
  'UNIQUE',
  'EXCLUDE',
];

/** Continuation after `ALTER TABLE x ALTER [COLUMN] y`. */
export const ALTER_TABLE_ALTER_COLUMN: readonly string[] = [
  'ADD GENERATED',
  'DROP DEFAULT',
  'DROP EXPRESSION',
  'DROP IDENTITY',
  'DROP NOT NULL',
  'RESET',
  'RESTART',
  'SET',
  'SET DATA TYPE',
  'SET DEFAULT',
  'SET EXPRESSION',
  'SET GENERATED',
  'SET NOT NULL',
  'SET STATISTICS',
  'SET STORAGE',
  'TYPE',
];

/** Continuation after `ALTER TABLE x DROP`. */
export const ALTER_TABLE_DROP: readonly string[] = [
  'COLUMN',
  'CONSTRAINT',
  'IF EXISTS',
];

/** Continuation after `ALTER TABLE x RENAME`. */
export const ALTER_TABLE_RENAME: readonly string[] = [
  'COLUMN',
  'CONSTRAINT',
  'TO',
];

/** Continuation after `ALTER TABLE x SET`. */
export const ALTER_TABLE_SET: readonly string[] = [
  '(',
  'LOGGED',
  'SCHEMA',
  'TABLESPACE',
  'UNLOGGED',
  'WITHOUT CLUSTER',
  'WITHOUT OIDS',
];

/** Continuation after `ALTER TABLE x ENABLE`. */
export const ALTER_TABLE_ENABLE: readonly string[] = [
  'ALWAYS',
  'REPLICA',
  'ROW LEVEL SECURITY',
  'RULE',
  'TRIGGER',
];

/** Continuation after `ALTER TABLE x DISABLE`. */
export const ALTER_TABLE_DISABLE: readonly string[] = [
  'ROW LEVEL SECURITY',
  'RULE',
  'TRIGGER',
];

/** Continuation after `ALTER TABLE x REPLICA IDENTITY`. */
export const ALTER_TABLE_REPLICA_IDENTITY: readonly string[] = [
  'DEFAULT',
  'FULL',
  'NOTHING',
  'USING INDEX',
];

/** Sub-actions for ALTER VIEW. */
export const ALTER_VIEW_ACTIONS: readonly string[] = [
  'ALTER',
  'OWNER TO',
  'RENAME',
  'RESET',
  'SET',
];

/** Sub-actions for ALTER MATERIALIZED VIEW. */
export const ALTER_MATVIEW_ACTIONS: readonly string[] = [
  'ALTER',
  'CLUSTER ON',
  'DEPENDS ON EXTENSION',
  'NO DEPENDS ON EXTENSION',
  'OWNER TO',
  'RENAME',
  'RESET',
  'SET',
];

/** Sub-actions for ALTER INDEX. */
export const ALTER_INDEX_ACTIONS: readonly string[] = [
  'ALTER COLUMN',
  'ATTACH PARTITION',
  'DEPENDS ON EXTENSION',
  'NO DEPENDS ON EXTENSION',
  'OWNER TO',
  'RENAME',
  'RESET',
  'SET',
];

/** Sub-actions for ALTER SEQUENCE. */
export const ALTER_SEQUENCE_ACTIONS: readonly string[] = [
  'AS',
  'CACHE',
  'CYCLE',
  'INCREMENT BY',
  'MAXVALUE',
  'MINVALUE',
  'NO CYCLE',
  'NO MAXVALUE',
  'NO MINVALUE',
  'OWNED BY',
  'OWNER TO',
  'RENAME TO',
  'RESTART',
  'SET SCHEMA',
  'START WITH',
];

/** Sub-actions for ALTER FUNCTION / PROCEDURE / ROUTINE. */
export const ALTER_FUNCTION_ACTIONS: readonly string[] = [
  'CALLED ON NULL INPUT',
  'COST',
  'DEPENDS ON EXTENSION',
  'IMMUTABLE',
  'LEAKPROOF',
  'NO DEPENDS ON EXTENSION',
  'NOT LEAKPROOF',
  'OWNER TO',
  'PARALLEL',
  'RENAME TO',
  'RESET',
  'RETURNS NULL ON NULL INPUT',
  'ROWS',
  'SECURITY DEFINER',
  'SECURITY INVOKER',
  'SET',
  'SET SCHEMA',
  'STABLE',
  'STRICT',
  'SUPPORT',
  'VOLATILE',
];

/** Sub-actions for ALTER TYPE. */
export const ALTER_TYPE_ACTIONS: readonly string[] = [
  'ADD ATTRIBUTE',
  'ADD VALUE',
  'ALTER ATTRIBUTE',
  'DROP ATTRIBUTE',
  'OWNER TO',
  'RENAME',
  'RENAME ATTRIBUTE',
  'RENAME VALUE',
  'SET SCHEMA',
  'SET',
];

/** Sub-actions for ALTER ROLE / USER. */
export const ALTER_ROLE_ACTIONS: readonly string[] = [
  'BYPASSRLS',
  'CONNECTION LIMIT',
  'CREATEDB',
  'CREATEROLE',
  'ENCRYPTED PASSWORD',
  'IN DATABASE',
  'INHERIT',
  'LOGIN',
  'NOBYPASSRLS',
  'NOCREATEDB',
  'NOCREATEROLE',
  'NOINHERIT',
  'NOLOGIN',
  'NOREPLICATION',
  'NOSUPERUSER',
  'PASSWORD',
  'RENAME TO',
  'REPLICATION',
  'RESET',
  'SET',
  'SUPERUSER',
  'VALID UNTIL',
  'WITH',
];

/** Sub-actions for ALTER DATABASE. */
export const ALTER_DATABASE_ACTIONS: readonly string[] = [
  'ALLOW_CONNECTIONS',
  'CONNECTION LIMIT',
  'IS_TEMPLATE',
  'OWNER TO',
  'REFRESH COLLATION VERSION',
  'RENAME TO',
  'RESET',
  'SET',
  'SET TABLESPACE',
  'WITH',
];

/** Sub-actions for ALTER SCHEMA. */
export const ALTER_SCHEMA_ACTIONS: readonly string[] = [
  'OWNER TO',
  'RENAME TO',
];

/** Sub-actions for ALTER EXTENSION. */
export const ALTER_EXTENSION_ACTIONS: readonly string[] = [
  'ADD',
  'DROP',
  'SET SCHEMA',
  'UPDATE',
];

/** Sub-actions for ALTER POLICY. */
export const ALTER_POLICY_ACTIONS: readonly string[] = ['ON', 'RENAME TO'];

/** Sub-actions for ALTER PUBLICATION. */
export const ALTER_PUBLICATION_ACTIONS: readonly string[] = [
  'ADD',
  'DROP',
  'OWNER TO',
  'RENAME TO',
  'SET',
];

/** Sub-actions for ALTER SUBSCRIPTION. */
export const ALTER_SUBSCRIPTION_ACTIONS: readonly string[] = [
  'ADD PUBLICATION',
  'CONNECTION',
  'DISABLE',
  'DROP PUBLICATION',
  'ENABLE',
  'OWNER TO',
  'REFRESH PUBLICATION',
  'RENAME TO',
  'SET',
  'SET PUBLICATION',
  'SKIP',
];

/** CREATE INDEX top-level options. */
export const CREATE_INDEX_OPTIONS: readonly string[] = [
  'CONCURRENTLY',
  'IF NOT EXISTS',
  'ON',
  'UNIQUE',
];

/** Window frame clauses after `OVER (`. */
export const WINDOW_FRAME_KEYWORDS: readonly string[] = [
  'GROUPS',
  'ORDER BY',
  'PARTITION BY',
  'RANGE',
  'ROWS',
];

/** Tail keywords that follow a `FROM <table>` clause in a query. */
export const POST_FROM_KEYWORDS: readonly string[] = [
  'AS',
  'CROSS JOIN',
  'EXCEPT',
  'FETCH',
  'FOR',
  'FULL JOIN',
  'FULL OUTER JOIN',
  'GROUP BY',
  'HAVING',
  'INNER JOIN',
  'INTERSECT',
  'JOIN',
  'LATERAL',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'LIMIT',
  'NATURAL JOIN',
  'OFFSET',
  'ON',
  'ORDER BY',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'TABLESAMPLE',
  'UNION',
  'USING',
  'WHERE',
  'WINDOW',
];

/** Continuations within a WHERE expression. */
export const WHERE_CONTINUATIONS: readonly string[] = [
  'AND',
  'BETWEEN',
  'IN',
  'IS',
  'LIKE',
  'NOT',
  'OR',
];

/** Boolean-style values used with `\set` for AUTOCOMMIT etc. (extends ON_OFF). */
export const DATESTYLE_VALUES: readonly string[] = [
  'GERMAN',
  'ISO',
  'POSTGRES',
  'SQL',
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

/**
 * Built-in scalar type keywords that psql tab-completion mixes in
 * wherever a type name is expected. Mirrors upstream's
 * `Keywords_for_list_of_datatypes` (tab-complete.in.c). The multi-word
 * names disabled under `#ifdef NOT_USED` upstream are intentionally
 * omitted here too — tab completion can't disambiguate across word
 * boundaries.
 */
export const BUILTIN_DATATYPE_KEYWORDS: readonly string[] = [
  'bigint',
  'boolean',
  'character',
  'double precision',
  'integer',
  'real',
  'smallint',
];

/**
 * COPY ... FROM ... WITH ( ... ) option keywords. Mirrors upstream's
 * `Copy_from_options` macro = `Copy_common_options` + the FROM-specific
 * extras (DEFAULT, FORCE_NOT_NULL, FORCE_NULL, FREEZE, LOG_VERBOSITY,
 * ON_ERROR, REJECT_LIMIT).
 */
export const COPY_FROM_OPTIONS: readonly string[] = [
  'DELIMITER',
  'ENCODING',
  'ESCAPE',
  'FORMAT',
  'HEADER',
  'NULL',
  'QUOTE',
  'DEFAULT',
  'FORCE_NOT_NULL',
  'FORCE_NULL',
  'FREEZE',
  'LOG_VERBOSITY',
  'ON_ERROR',
  'REJECT_LIMIT',
];

/**
 * COPY ... TO ... WITH ( ... ) option keywords. Mirrors upstream's
 * `Copy_to_options` macro = `Copy_common_options` + `FORCE_QUOTE`.
 */
export const COPY_TO_OPTIONS: readonly string[] = [
  'DELIMITER',
  'ENCODING',
  'ESCAPE',
  'FORMAT',
  'HEADER',
  'NULL',
  'QUOTE',
  'FORCE_QUOTE',
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
 * Render a candidate with the case psql would use, based on `COMP_KEYWORD_CASE`:
 *
 *   - lower            → always lowercase, regardless of input.
 *   - upper            → always uppercase, regardless of input.
 *   - preserve-lower   → lowercase by default; uppercase if the user typed
 *                        a fragment containing an UPPERCASE letter.
 *   - preserve-upper   → (default) uppercase by default; lowercase if the
 *                        user typed a fragment containing a lowercase letter.
 *
 * Per psql docs: "preserve-upper, the default, returns the keyword in upper
 * case unless the partial word entered is in lower case". The dichotomy is
 * really "did the user type ANY lowercase letter" (for preserve-upper) and
 * "did the user type ANY uppercase letter" (for preserve-lower) — matching
 * upstream's `pg_str_endswith` / `pg_str_islower` heuristics.
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
  // Mirror upstream `pg_strdup_keyword_case` (tab-complete.c): the case
  // decision keys off the FIRST character of the user's input, not the
  // presence of any case anywhere. Empty input (`first` = 0) is treated as
  // neither lowercase nor alpha, so:
  //   - preserve-upper → UPPERCASE (default mode; matches vanilla psql 18
  //     for the `set <name> <TAB><TAB>` → `TO` case, upstream test
  //     010_tab_completion.pl line 366).
  //   - preserve-lower → lowercase.
  // The same rule applies when the first char is a non-letter (digit, `_`,
  // punctuation) — those preserve the mode's default direction.
  const first = typed[0] ?? '';
  const firstIsLower = /[a-z]/.test(first);
  const firstIsAlpha = /[A-Za-z]/.test(first);
  const lowerCaseIt =
    mode === 'lower' ||
    ((mode === 'preserve-lower' || mode === 'preserve-upper') &&
      firstIsLower) ||
    (mode === 'preserve-lower' && !firstIsAlpha);
  if (mode === 'upper') return candidate.toUpperCase();
  return lowerCaseIt ? candidate.toLowerCase() : candidate.toUpperCase();
};

const containsNonKeywordChar = (s: string): boolean => /[^A-Za-z0-9 ]/.test(s);

/**
 * Split a candidate like `pg_catalog.tab_` into [schema, prefix]. Returns
 * `null` if there's no schema qualifier. `schemaWasQuoted` records whether
 * the user wrote the schema in `"..."` form so the caller can decide whether
 * to fold its case in the rendered output.
 */
const splitSchemaPrefix = (
  word: string,
): {
  schema: string;
  prefix: string;
  schemaWasQuoted: boolean;
} | null => {
  const dot = word.indexOf('.');
  if (dot < 0) return null;
  // Reject if anything after the dot looks like another dot (we only handle
  // schema.relation, not catalog.schema.relation).
  const after = word.slice(dot + 1);
  if (after.includes('.')) return null;
  // Strip optional quoting on the schema.
  let schema = word.slice(0, dot);
  let schemaWasQuoted = false;
  if (schema.startsWith('"') && schema.endsWith('"')) {
    schemaWasQuoted = true;
    schema = schema.slice(1, -1).replace(/""/g, '"');
  }
  return { schema, prefix: after, schemaWasQuoted };
};

/**
 * Parse a table reference (the `<ref>` slot in
 * `ALTER TABLE <ref> DROP CONSTRAINT y`) from the already-tokenized
 * `prevWords` slice between `ALTER TABLE` and the action keyword.
 *
 * The scanner can produce the reference as 1 or 2 tokens depending on
 * quoting:
 *
 *   - `tab1`            → `["tab1"]`               (bare, case-folded)
 *   - `"tab1"`          → `["\"tab1\""]`           (quoted, exact-case)
 *   - `public.tab1`     → `["public.tab1"]`        (single token, dotted)
 *   - `public."tab1"`   → `["public.\"tab1\""]`    (single token, dotted+quoted)
 *
 * Returns the parsed parts with case-folding applied to UNQUOTED
 * identifiers (matching `pg_strcasecmp` semantics) so the caller can
 * pass them straight to a `WHERE relname = $N` catalog query.
 *
 * Returns `null` when the tokens don't look like a valid reference.
 */
const parseTableRef = (
  refTokens: readonly string[],
): { schema: string | null; table: string } | null => {
  const stripQuote = (s: string): { v: string; quoted: boolean } => {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      return { v: s.slice(1, -1).replace(/""/g, '"'), quoted: true };
    }
    return { v: s, quoted: false };
  };
  // Two-token form: `public.` + `"tab1"` (our scanner ends the first
  // token on the dot when the relation half is quoted).
  if (refTokens.length === 2) {
    const first = refTokens[0];
    if (!first.endsWith('.')) return null;
    const s = stripQuote(first.slice(0, -1));
    const t = stripQuote(refTokens[1]);
    if (t.v.length === 0) return null;
    return {
      schema: s.quoted ? s.v : s.v.toLowerCase(),
      table: t.quoted ? t.v : t.v.toLowerCase(),
    };
  }
  if (refTokens.length !== 1) return null;
  const tok = refTokens[0];
  // Single-token form. Schema-qualified? Find the FIRST dot that isn't
  // inside `"..."`.
  let inQuote = false;
  let dot = -1;
  for (let i = 0; i < tok.length; i++) {
    const ch = tok[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === '.' && !inQuote) {
      dot = i;
      break;
    }
  }
  if (dot >= 0) {
    const s = stripQuote(tok.slice(0, dot));
    const t = stripQuote(tok.slice(dot + 1));
    if (t.v.length === 0) return null;
    return {
      schema: s.quoted ? s.v : s.v.toLowerCase(),
      table: t.quoted ? t.v : t.v.toLowerCase(),
    };
  }
  const t = stripQuote(tok);
  if (t.v.length === 0) return null;
  return { schema: null, table: t.quoted ? t.v : t.v.toLowerCase() };
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

  // ----- Variable expansion (`:NAME`, `:'NAME'`, `:"NAME"`, `:{?NAME}`)
  // takes priority over anything else. The interpolation forms are valid
  // both inside SQL and inside backslash-command args (`\echo :VERB`),
  // so this branch fires regardless of `prevWords`.
  if (currentWord.startsWith(':') && !currentWord.startsWith('::')) {
    const names = listVarNames(ctx.settings);
    const lc = (s: string): string => s.toLowerCase();

    // `:{?NAME}` — test-form (psqlscan_test_variable upstream). The
    // candidate must close the `}` so the user's literal `:{?VERB`
    // expands to `:{?VERBOSITY}` in one Tab.
    if (currentWord.startsWith(':{?')) {
      const prefix = currentWord.slice(3);
      const lp = lc(prefix);
      const cands = names
        .filter((n) => lc(n).startsWith(lp))
        .map((n) => ':{?' + n + '}');
      return { candidates: cands };
    }
    // `:'NAME'` / `:"NAME"` — quoted-substitution forms (psqlscan emits
    // a quoted literal / identifier). Close the matching quote so the
    // unique-match path appends a trailing space cleanly.
    if (currentWord.startsWith(":'")) {
      const prefix = currentWord.slice(2);
      const lp = lc(prefix);
      const cands = names
        .filter((n) => lc(n).startsWith(lp))
        .map((n) => ":'" + n + "'");
      return { candidates: cands };
    }
    if (currentWord.startsWith(':"')) {
      const prefix = currentWord.slice(2);
      const lp = lc(prefix);
      const cands = names
        .filter((n) => lc(n).startsWith(lp))
        .map((n) => ':"' + n + '"');
      return { candidates: cands };
    }
    // Plain `:NAME` — bare substitution.
    const prefix = currentWord.slice(1);
    const lp = lc(prefix);
    const filt = names.filter((n) => lc(n).startsWith(lp)).map((n) => ':' + n);
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

  // \do → operators.
  if (
    cmd === '\\do' ||
    cmd === '\\do+' ||
    cmd === '\\doS' ||
    cmd === '\\doS+'
  ) {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_operators,
        currentWord,
      );
      return { candidates: rows };
    }
    return { candidates: [] };
  }

  // \dC → casts (free-form pattern of "src AS tgt").
  if (cmd === '\\dC' || cmd === '\\dC+') {
    if (prevWords.length === 1 && conn) {
      const rows = await runCatalogQuery(
        conn,
        Query_for_list_of_casts,
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

  // \lo_import / \lo_export → filesystem-driven filename completion.
  // psql parses the path as a backslash-argument literal — no SQL string
  // quoting required, so we use the unquoted candidate form.
  if (cmd === '\\lo_import' || cmd === '\\lo_export') {
    if (prevWords.length === 1) {
      return { candidates: completeFilenames(currentWord, 'none') };
    }
    return { candidates: [] };
  }

  // \copy <table> [FROM|TO] <path> — once the FROM/TO keyword has been
  // typed, the next token is a filename (backslash-context, so bare paths
  // are fine).
  if (cmd === '\\copy') {
    // First arg: a table name.
    if (prevWords.length === 1 && conn) {
      return {
        candidates: await completeSchemaOrRelations(
          conn,
          currentWord,
          Query_for_list_of_tables,
        ),
      };
    }
    // Second arg: the FROM/TO keyword.
    if (prevWords.length === 2) {
      return {
        candidates: filterAndCase(['FROM', 'TO'], currentWord, ctx.settings),
      };
    }
    // Third arg (after FROM/TO): the filename.
    if (prevWords.length >= 3) {
      const last = prevWords[prevWords.length - 1].toUpperCase();
      if (last === 'FROM' || last === 'TO') {
        return { candidates: completeFilenames(currentWord, 'none') };
      }
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

  // COPY <table> [FROM|TO] <'path'> — filename completion in the
  // string-literal context. MUST come before the generic `FROM <prefix>`
  // rule below, which would otherwise treat the path as a table name.
  if (isCopyFromOrTo(prevWords)) {
    return { candidates: completeFilenames(currentWord, 'sql') };
  }

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
  // After JOIN x, suggest ON or USING.
  if (TailMatches(prevWords, ['JOIN', MatchAny])) {
    return {
      candidates: filterAndCase(['ON', 'USING'], currentWord, ctx.settings),
    };
  }

  // After `FROM table_name <TAB>` (or `FROM table AS alias <TAB>`) — offer
  // the post-FROM tail keywords. Only fire when the statement starts with
  // SELECT/INSERT/UPDATE/DELETE (i.e. a SELECT-list-friendly context), so
  // we don't trample more specific rules like `ALTER TABLE x` or
  // `INSERT INTO x` which look "FROM-like" structurally.
  const inSelectContext =
    HeadMatches(prevWords, ['SELECT']) ||
    HeadMatches(prevWords, ['INSERT']) ||
    HeadMatches(prevWords, ['UPDATE']) ||
    HeadMatches(prevWords, ['DELETE']) ||
    HeadMatches(prevWords, ['WITH']) ||
    HeadMatches(prevWords, ['EXPLAIN']);
  if (
    inSelectContext &&
    (TailMatches(prevWords, ['FROM', MatchAny]) ||
      TailMatches(prevWords, ['FROM', MatchAny, MatchAny]))
  ) {
    // `FROM x` or `FROM x alias` → post-FROM continuations.
    return {
      candidates: filterAndCase(POST_FROM_KEYWORDS, currentWord, ctx.settings),
    };
  }

  // Window-function frame clause: `OVER (` then `<TAB>`. The tokenizer
  // emits the `(` as its own token, so prevWords ends with '('.
  if (TailMatches(prevWords, ['OVER', '('])) {
    return {
      candidates: filterAndCase(
        WINDOW_FRAME_KEYWORDS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  // `OVER <name>` (named window reference) is free-form; no completion.

  // After a WHERE clause has been started (any `WHERE … <expr> <TAB>`),
  // suggest boolean continuations. We trigger on the simple case
  // `WHERE <ident>` and `WHERE … AND/OR <ident>`.
  if (
    inSelectContext &&
    TailMatches(prevWords, ['WHERE', MatchAny]) &&
    !TailMatches(prevWords, ['WHERE'])
  ) {
    return {
      candidates: filterAndCase(WHERE_CONTINUATIONS, currentWord, ctx.settings),
    };
  }

  // ---- ALTER TABLE block ----
  // Deep ALTER TABLE sub-action continuations must be checked BEFORE the
  // 3-token fallback `ALTER TABLE x` (which lists generic sub-actions).
  // The deeper rules use HeadMatches so they survive an arbitrary trailing
  // option list like `ALTER TABLE foo ADD CONSTRAINT bar CHECK (...)`.
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['ADD'])
  ) {
    return {
      candidates: filterAndCase(ALTER_TABLE_ADD, currentWord, ctx.settings),
    };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['DROP'])
  ) {
    return {
      candidates: filterAndCase(ALTER_TABLE_DROP, currentWord, ctx.settings),
    };
  }
  // `ALTER TABLE <ref> DROP CONSTRAINT <prefix>` — constraint names on
  // the referenced table. Mirrors upstream tab-complete.in.c ~line 1280
  // (`COMPLETE_WITH_QUERY(Query_for_constraint_of_table)`).
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['DROP', 'CONSTRAINT'])
  ) {
    if (!conn) return { candidates: [] };
    const refTokens = prevWords.slice(2, prevWords.length - 2);
    const ref = parseTableRef(refTokens);
    if (!ref) return { candidates: [] };
    const cands =
      ref.schema === null
        ? await runCatalogQuery(
            conn,
            Query_for_constraint_of_table,
            currentWord,
            [ref.table],
          )
        : await runCatalogQuery(
            conn,
            Query_for_constraint_of_table_in_schema,
            currentWord,
            [ref.schema, ref.table],
          );
    return { candidates: cands };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['RENAME'])
  ) {
    return {
      candidates: filterAndCase(ALTER_TABLE_RENAME, currentWord, ctx.settings),
    };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    (TailMatches(prevWords, ['ALTER']) ||
      TailMatches(prevWords, ['ALTER', 'COLUMN', MatchAny]))
  ) {
    return {
      candidates: filterAndCase(
        ALTER_TABLE_ALTER_COLUMN,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['SET'])
  ) {
    return {
      candidates: filterAndCase(ALTER_TABLE_SET, currentWord, ctx.settings),
    };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['ENABLE'])
  ) {
    return {
      candidates: filterAndCase(ALTER_TABLE_ENABLE, currentWord, ctx.settings),
    };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['DISABLE'])
  ) {
    return {
      candidates: filterAndCase(ALTER_TABLE_DISABLE, currentWord, ctx.settings),
    };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'TABLE']) &&
    TailMatches(prevWords, ['REPLICA', 'IDENTITY'])
  ) {
    return {
      candidates: filterAndCase(
        ALTER_TABLE_REPLICA_IDENTITY,
        currentWord,
        ctx.settings,
      ),
    };
  }
  // ALTER TABLE x — sub-actions (must come AFTER the deep continuations above).
  if (TailMatches(prevWords, ['ALTER', 'TABLE', MatchAny])) {
    return {
      candidates: filterAndCase(ALTER_TABLE_ACTIONS, currentWord, ctx.settings),
    };
  }
  // ALTER TABLE — table name.
  if (TailMatches(prevWords, ['ALTER', 'TABLE'])) return completeTables();

  // ---- ALTER VIEW / MATERIALIZED VIEW ----
  if (TailMatches(prevWords, ['ALTER', 'VIEW', MatchAny])) {
    return {
      candidates: filterAndCase(ALTER_VIEW_ACTIONS, currentWord, ctx.settings),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'VIEW'])) {
    return completeTables(Query_for_list_of_views);
  }
  if (TailMatches(prevWords, ['ALTER', 'MATERIALIZED', 'VIEW', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_MATVIEW_ACTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'MATERIALIZED', 'VIEW'])) {
    return completeTables(Query_for_list_of_matviews);
  }

  // ---- ALTER INDEX ----
  if (TailMatches(prevWords, ['ALTER', 'INDEX', MatchAny])) {
    return {
      candidates: filterAndCase(ALTER_INDEX_ACTIONS, currentWord, ctx.settings),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'INDEX'])) {
    return completeTables(Query_for_list_of_indexes);
  }

  // ---- ALTER SEQUENCE ----
  if (TailMatches(prevWords, ['ALTER', 'SEQUENCE', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_SEQUENCE_ACTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'SEQUENCE'])) {
    return completeTables(Query_for_list_of_sequences);
  }

  // ---- ALTER FUNCTION / PROCEDURE / ROUTINE ----
  if (
    TailMatches(prevWords, ['ALTER', 'FUNCTION|PROCEDURE|ROUTINE', MatchAny])
  ) {
    return {
      candidates: filterAndCase(
        ALTER_FUNCTION_ACTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'FUNCTION|PROCEDURE|ROUTINE'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_functions,
        currentWord,
      ),
    };
  }

  // ---- ALTER TYPE ----
  // `ALTER TYPE <enum> RENAME VALUE 'X<TAB>` — enum labels of the named
  // type, wrapped in single quotes since the user is mid-string-literal.
  // Mirrors upstream tab-complete.in.c ~line 1480.
  if (
    TailMatches(prevWords, ['ALTER', 'TYPE', MatchAny, 'RENAME', 'VALUE']) &&
    currentWord.startsWith("'")
  ) {
    if (!conn) return { candidates: [] };
    const typeName = prevWords[prevWords.length - 3].toLowerCase();
    // Strip the leading quote so the LIKE pattern matches `bar`/`BLACK`
    // (enumlabel column) rather than `'bar`/`'BLACK`.
    const labelPrefix = currentWord.slice(1);
    const cands = await runCatalogQuery(
      conn,
      Query_for_list_of_enum_values_quoted,
      labelPrefix,
      [typeName],
    );
    return { candidates: cands };
  }
  if (TailMatches(prevWords, ['ALTER', 'TYPE', MatchAny])) {
    return {
      candidates: filterAndCase(ALTER_TYPE_ACTIONS, currentWord, ctx.settings),
    };
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

  // ---- ALTER ROLE / USER / GROUP ----
  if (TailMatches(prevWords, ['ALTER', 'ROLE|USER|GROUP', MatchAny])) {
    return {
      candidates: filterAndCase(ALTER_ROLE_ACTIONS, currentWord, ctx.settings),
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

  // ---- ALTER DATABASE ----
  if (TailMatches(prevWords, ['ALTER', 'DATABASE', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_DATABASE_ACTIONS,
        currentWord,
        ctx.settings,
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

  // ---- ALTER SCHEMA ----
  if (TailMatches(prevWords, ['ALTER', 'SCHEMA', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_SCHEMA_ACTIONS,
        currentWord,
        ctx.settings,
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

  // ---- ALTER EXTENSION ----
  if (TailMatches(prevWords, ['ALTER', 'EXTENSION', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_EXTENSION_ACTIONS,
        currentWord,
        ctx.settings,
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

  // ---- ALTER POLICY <name> ON <table> ----
  if (TailMatches(prevWords, ['ALTER', 'POLICY', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_POLICY_ACTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (
    HeadMatches(prevWords, ['ALTER', 'POLICY']) &&
    TailMatches(prevWords, ['ON'])
  ) {
    return completeTables();
  }
  if (TailMatches(prevWords, ['ALTER', 'POLICY'])) {
    // Free-form policy name.
    return { candidates: [] };
  }

  // ---- ALTER PUBLICATION ----
  if (TailMatches(prevWords, ['ALTER', 'PUBLICATION', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_PUBLICATION_ACTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'PUBLICATION'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_publications,
        currentWord,
      ),
    };
  }

  // ---- ALTER SUBSCRIPTION ----
  if (TailMatches(prevWords, ['ALTER', 'SUBSCRIPTION', MatchAny])) {
    return {
      candidates: filterAndCase(
        ALTER_SUBSCRIPTION_ACTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['ALTER', 'SUBSCRIPTION'])) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_subscriptions,
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
    // Built-in scalar type keywords mirror upstream's
    // `Keywords_for_list_of_datatypes` attached to the SchemaQuery; psql
    // mixes them with user-defined types so `DROP TYPE big<TAB>` resolves
    // to `bigint` even without a matching catalog row.
    const keywords = filterAndCase(
      BUILTIN_DATATYPE_KEYWORDS,
      currentWord,
      ctx.settings,
    );
    if (!conn) return { candidates: keywords };
    const types = await runCatalogQuery(
      conn,
      Query_for_list_of_types,
      currentWord,
    );
    return { candidates: [...keywords, ...types] };
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
  if (TailMatches(prevWords, ['DROP', 'PUBLICATION'])) {
    // Mirrors upstream's `words_after_create` PUBLICATION entry
    // (VersionedQuery on `Query_for_list_of_publications`). Two-step
    // completion: `DROP PUBLIC<TAB>` first resolves to `PUBLICATION`
    // via the static DROP_OBJECTS list (handled below by the bare
    // `DROP` arm), then `DROP PUBLICATION <TAB>` lists publications.
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_publications,
        currentWord,
      ),
    };
  }
  if (TailMatches(prevWords, ['DROP', 'SUBSCRIPTION'])) {
    // Same shape as DROP PUBLICATION — paired here for parity with the
    // ALTER block above.
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_subscriptions,
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

  // ---- CREATE INDEX deep handling (specific arms BEFORE generic CREATE). ----
  // CREATE INDEX <TAB> → CONCURRENTLY, IF NOT EXISTS, ON (no name = use ON
  // directly), or a free-form index name.
  if (TailMatches(prevWords, ['CREATE', 'INDEX'])) {
    return {
      candidates: filterAndCase(
        CREATE_INDEX_OPTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  if (TailMatches(prevWords, ['CREATE', 'UNIQUE', 'INDEX'])) {
    return {
      candidates: filterAndCase(
        CREATE_INDEX_OPTIONS,
        currentWord,
        ctx.settings,
      ),
    };
  }
  // CREATE INDEX <name> <TAB> → ON.
  if (
    TailMatches(prevWords, ['CREATE', 'INDEX', MatchAny]) ||
    TailMatches(prevWords, ['CREATE', 'UNIQUE', 'INDEX', MatchAny])
  ) {
    return { candidates: filterAndCase(['ON'], currentWord, ctx.settings) };
  }
  // CREATE INDEX ... ON <TAB> → tables.
  if (
    TailMatches(prevWords, ['CREATE', 'INDEX', MatchAny, 'ON']) ||
    TailMatches(prevWords, ['CREATE', 'INDEX', 'ON']) ||
    TailMatches(prevWords, ['CREATE', 'UNIQUE', 'INDEX', MatchAny, 'ON']) ||
    TailMatches(prevWords, ['CREATE', 'UNIQUE', 'INDEX', 'ON'])
  ) {
    return completeTables();
  }
  // CREATE INDEX ... ON <table> <TAB> → USING / (.
  if (
    (HeadMatches(prevWords, ['CREATE', 'INDEX']) ||
      HeadMatches(prevWords, ['CREATE', 'UNIQUE', 'INDEX'])) &&
    TailMatches(prevWords, ['ON', MatchAny])
  ) {
    return {
      candidates: filterAndCase(['USING', '('], currentWord, ctx.settings),
    };
  }
  // CREATE INDEX ... USING <TAB> → access methods.
  if (
    (HeadMatches(prevWords, ['CREATE', 'INDEX']) ||
      HeadMatches(prevWords, ['CREATE', 'UNIQUE', 'INDEX'])) &&
    TailMatches(prevWords, ['USING'])
  ) {
    if (!conn) {
      // Even without a connection, offer the built-in AMs as a fallback.
      return {
        candidates: filterAndCase(
          ['btree', 'hash', 'gist', 'gin', 'spgist', 'brin'],
          currentWord,
          ctx.settings,
        ),
      };
    }
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_index_access_methods,
        currentWord,
      ),
    };
  }

  // CREATE ... — first sub-object keyword.
  if (TailMatches(prevWords, ['CREATE'])) {
    return {
      candidates: filterAndCase(CREATE_OBJECTS, currentWord, ctx.settings),
    };
  }
  if (TailMatches(prevWords, ['CREATE', 'TABLE'])) {
    // Upstream's `words_after_create` fallback (tab-complete.in.c
    // ~lines 2062-2082) runs `Query_for_list_of_tables` when the
    // word immediately before the cursor is `TABLE`. The intent is to
    // surface existing table names as a HINT — the user can pick a
    // similar name as a starting point. The completion is non-binding;
    // psql doesn't actually insert one of these on a single Tab if
    // the prefix is ambiguous, but the listing on Tab-Tab matches
    // upstream's `qr/mytab123 +mytab246/`.
    return completeTables();
  }
  // Inside CREATE TABLE column-list parens: `<col_name> <TAB>` → types.
  if (
    HeadMatches(prevWords, ['CREATE', 'TABLE']) &&
    TailMatches(prevWords, ['(|,', MatchAny])
  ) {
    if (!conn) return { candidates: [] };
    return {
      candidates: await runCatalogQuery(
        conn,
        Query_for_list_of_datatypes,
        currentWord,
      ),
    };
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

  // COPY ... FROM <sth> WITH ( — option keywords inside the WITH
  // parenthesised list. The tokenizer splits `(` and `,` into their
  // own tokens so the tail looks like `[... WITH (]` for the first
  // option and `[..., WITH, (, opt, ,]` for subsequent ones. Two
  // arms: one for FROM (which adds DEFAULT, FORCE_NOT_NULL, etc.)
  // and one for TO (which adds FORCE_QUOTE only). Mirrors upstream
  // tab-complete.in.c ~3309-3315 (`Copy_from_options` /
  // `Copy_to_options`). The `HeadMatches` guard restricts the rule
  // to a real COPY statement so the generic `(`/`,` pattern doesn't
  // fire inside CREATE TABLE / SELECT lists.
  if (
    HeadMatches(prevWords, ['COPY|\\copy']) &&
    HeadMatches(prevWords, [MatchAny, MatchAny, 'FROM']) &&
    (TailMatches(prevWords, ['(']) || TailMatches(prevWords, [',']))
  ) {
    return {
      candidates: filterAndCase(COPY_FROM_OPTIONS, currentWord, ctx.settings),
    };
  }
  if (
    HeadMatches(prevWords, ['COPY|\\copy']) &&
    HeadMatches(prevWords, [MatchAny, MatchAny, 'TO']) &&
    (TailMatches(prevWords, ['(']) || TailMatches(prevWords, [',']))
  ) {
    return {
      candidates: filterAndCase(COPY_TO_OPTIONS, currentWord, ctx.settings),
    };
  }

  // COPY x → tables. (The `COPY x FROM/TO <path>` filename completion is
  // handled by the early `isCopyFromOrTo` check at the top of this
  // function so it wins over the generic `FROM <prefix>` table rule.)
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
  // `SET <name> TO|= <TAB>` — for DateStyle we can suggest the formats.
  if (
    TailMatches(prevWords, ['SET', 'DateStyle', 'TO|=']) ||
    TailMatches(prevWords, ['SET', 'DATESTYLE', 'TO|=']) ||
    TailMatches(prevWords, ['SET', 'datestyle', 'TO|='])
  ) {
    return {
      candidates: filterAndCase(DATESTYLE_VALUES, currentWord, ctx.settings),
    };
  }
  // `SET timezone TO <prefix>` — names from pg_timezone_names. Two
  // variants depending on whether the user has opened a single quote:
  //   - `SET timezone TO am<TAB>`  → user typed an unquoted prefix; we
  //     respond with `'America/'`-style quoted candidates so the next
  //     keystroke continues inside the string literal. The
  //     `Query_for_list_of_timezone_names_quoted_out` template matches
  //     LIKE against the unquoted name and returns `quote_literal(name)`.
  //   - `SET timezone TO 'America/New_<TAB>` → user is mid-literal;
  //     `Query_for_list_of_timezone_names_quoted_in` matches the LIKE
  //     pattern against the quoted form so the partial `'America/New_`
  //     resolves correctly.
  // Mirrors upstream tab-complete.in.c ~line 4530.
  if (
    TailMatches(prevWords, ['SET', 'timezone', 'TO|=']) ||
    TailMatches(prevWords, ['SET', 'TIMEZONE', 'TO|=']) ||
    TailMatches(prevWords, ['SET', 'TimeZone', 'TO|='])
  ) {
    if (!conn) return { candidates: [] };
    const query = currentWord.startsWith("'")
      ? Query_for_list_of_timezone_names_quoted_in
      : Query_for_list_of_timezone_names_quoted_out;
    const cands = await runCatalogQuery(conn, query, currentWord);
    return { candidates: cands };
  }
  // `SET <name> <TAB>` (no operator yet) → TO.
  // Upstream tab-complete.in.c uses `COMPLETE_WITH("TO")` here even
  // though `SET <name> = <value>` is valid syntax — the goal is a
  // single unique completion so `set foo<tab><tab>` resolves to
  // `set foo TO ` rather than listing two near-synonymous separators.
  // Verified against vanilla psql 18 + upstream test line 366.
  if (TailMatches(prevWords, ['SET', MatchAny])) {
    return {
      candidates: filterAndCase(['TO'], currentWord, ctx.settings),
    };
  }
  // Bare SET <TAB>: GUC name OR top-level SET sub-keywords (ROLE, SCHEMA, …).
  if (TailMatches(prevWords, ['SET'])) {
    const staticKw = filterAndCase(
      [
        'CONSTRAINTS',
        'LOCAL',
        'ROLE',
        'SCHEMA',
        'SESSION',
        'TIME ZONE',
        'TRANSACTION',
      ],
      currentWord,
      ctx.settings,
    );
    if (!conn) return { candidates: staticKw };
    const guc = await runCatalogQuery(
      conn,
      Query_for_list_of_set_vars,
      currentWord,
    );
    return { candidates: [...staticKw, ...guc] };
  }

  // SHOW <TAB> — ALL keyword plus the live GUC list.
  if (TailMatches(prevWords, ['SHOW'])) {
    const staticKw = filterAndCase(['ALL'], currentWord, ctx.settings);
    if (!conn) {
      return {
        candidates: [
          ...staticKw,
          ...filterAndCase(
            [
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
        ],
      };
    }
    const guc = await runCatalogQuery(
      conn,
      Query_for_list_of_set_vars,
      currentWord,
    );
    return { candidates: [...staticKw, ...guc] };
  }

  // RESET <TAB> — ALL or the live GUC list.
  if (TailMatches(prevWords, ['RESET'])) {
    const staticKw = filterAndCase(
      ['ALL', 'SESSION AUTHORIZATION', 'ROLE'],
      currentWord,
      ctx.settings,
    );
    if (!conn) return { candidates: staticKw };
    const guc = await runCatalogQuery(
      conn,
      Query_for_list_of_set_vars,
      currentWord,
    );
    return { candidates: [...staticKw, ...guc] };
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
 * AND a list of schemas (so the user can dot through to relations in any
 * schema, mirroring upstream's `complete_from_schema_query`).
 *
 * Schema names are returned with a trailing `.` so the completion engine
 * recognizes them as "in progress" and refrains from appending a space.
 * When a unique candidate is a schema (e.g. `pub<tab>` → `public.`) the
 * user can immediately Tab again to list relations within that schema.
 *
 * Quoted identifier handling: if the user's input starts with `"`, we
 * search the catalog case-sensitively (stripping the opening quote) and
 * return candidates pre-quoted with `"..."` so the line ends up in a
 * valid quoted form — matching upstream readline's behaviour for
 * `select * from "my<tab>` → `"mytab123 "mytab246`.
 */
const completeSchemaOrRelations = async (
  conn: Connection,
  word: string,
  query: string,
): Promise<string[]> => {
  if (word.startsWith('"')) {
    return completeQuotedRelations(conn, word, query);
  }
  const split = splitSchemaPrefix(word);
  if (split) {
    const rows = await runCatalogQuery(
      conn,
      Query_for_list_of_relations_in_schema,
      split.prefix,
      [split.schema],
    );
    // Re-prefix with the catalog's canonical schema name. Upstream folds
    // unquoted schema identifiers to lowercase in the output (mirroring
    // the way Postgres downcases unquoted names), so `PUBLIC.t<tab>`
    // completes to `public.tab1` instead of preserving `PUBLIC` in the
    // returned candidate.
    const canonicalSchema = split.schemaWasQuoted
      ? split.schema
      : split.schema.toLowerCase();
    return rows.map((r) => canonicalSchema + '.' + r);
  }
  // Unqualified: combine relations + schemas (schemas suffixed with `.`).
  const [rels, schemas] = await Promise.all([
    runCatalogQuery(conn, query, word),
    runCatalogQuery(conn, Query_for_list_of_schemas, word),
  ]);
  return [...rels, ...schemas.map((s) => s + '.')];
};

/**
 * Search the catalog for relations matching a user-supplied prefix that
 * begins with `"`. We strip the opening quote, search the RAW relname
 * case-sensitively (so `"mi` → `mixedName` rather than `mytab123`), and
 * emit results wrapped in `"..."` with a closing quote so the editor's
 * unique-completion handler appends the trailing space outside the
 * quoted region (e.g. `"mixedName" `).
 */
const completeQuotedRelations = async (
  conn: Connection,
  word: string,
  query: string,
): Promise<string[]> => {
  // Strip leading `"` (and any trailing `"` the user pre-typed).
  const inside = word.slice(1).replace(/"$/, '');
  // Use a case-sensitive raw-relname LIKE — the inside-the-quote portion
  // is taken verbatim.
  const sql = caseSensitiveRelnameVariant(query);
  if (!sql) return [];
  const rows = await runCatalogQuery(conn, sql, inside);
  return rows.map((name) => '"' + name + '"');
};

/**
 * Build a case-sensitive variant of a relation-list query for quoted
 * input. The standard queries use `ILIKE` on `quote_ident(c.relname)`
 * (which obscures the original case for identifiers like `mixedName`);
 * we swap that for `LIKE` on the raw `c.relname` and return the raw
 * relname so we control the quoting.
 *
 * Returns null if the query isn't a recognised relation query
 * (defensive — keeps the quoted-completion code path bounded).
 */
const caseSensitiveRelnameVariant = (sql: string): string | null => {
  // We rewrite the SELECT/WHERE clauses on the standard relation queries.
  // The only shape we need to support is `c.relname ILIKE $1` against
  // `pg_catalog.pg_class c`, with various `c.relkind IN (...)` filters.
  if (!sql.includes('pg_catalog.pg_class c')) return null;
  if (!sql.includes('c.relname ILIKE $1')) return null;
  return sql
    .replace('SELECT pg_catalog.quote_ident(c.relname)', 'SELECT c.relname')
    .replace('c.relname ILIKE $1', 'c.relname LIKE $1');
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
