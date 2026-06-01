/**
 * Catalog-query templates for tab completion.
 *
 * Each template returns a single column of completion candidates and takes
 * one parameter — the LIKE pattern (i.e. the user's partial prefix with a
 * trailing `%`). We use `pg_catalog.quote_ident()` so identifiers that need
 * quoting come back already wrapped in `"..."`.
 *
 * The templates are intentionally narrow: psql's upstream tab-complete uses
 * elaborate `SchemaQuery` structs that synthesize visibility predicates
 * (search-path awareness) at runtime. We trade that nuance for portability
 * — these queries just `LIKE` against the system catalogs and let the user
 * see everything they have access to, sorted alphabetically.
 *
 * Every query takes a single `$1` parameter (the LIKE pattern) and is
 * capped at 1000 rows so a wildcard `%` doesn't dump entire databases.
 */

import type { Connection } from '../types/connection.js';

const LIMIT = 1000;

/** Tables (incl. partitioned tables). */
export const Query_for_list_of_tables = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind IN ('r','p')
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Views. */
export const Query_for_list_of_views = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'v'
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Materialized views. */
export const Query_for_list_of_matviews = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'm'
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Sequences. */
export const Query_for_list_of_sequences = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'S'
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Indexes. */
export const Query_for_list_of_indexes = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind IN ('i','I')
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Foreign tables. */
export const Query_for_list_of_foreign_tables = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'f'
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Any relation (tables, views, mviews, indexes, sequences, foreign tables). */
export const Query_for_list_of_relations = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind IN ('r','v','m','S','f','p')
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Tables + views + matviews (what FROM/UPDATE/INSERT INTO accept). */
export const Query_for_list_of_tables_views = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind IN ('r','v','m','p','f')
    AND c.relname ILIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Schemas. */
export const Query_for_list_of_schemas = `
  SELECT pg_catalog.quote_ident(nspname)
  FROM pg_catalog.pg_namespace
  WHERE nspname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Functions (not procedures). */
export const Query_for_list_of_functions = `
  SELECT pg_catalog.quote_ident(p.proname)
  FROM pg_catalog.pg_proc p
  WHERE p.proname ILIKE $1
    AND pg_catalog.pg_function_is_visible(p.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Roles. */
export const Query_for_list_of_roles = `
  SELECT pg_catalog.quote_ident(rolname)
  FROM pg_catalog.pg_roles
  WHERE rolname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Extensions. */
export const Query_for_list_of_extensions = `
  SELECT pg_catalog.quote_ident(extname)
  FROM pg_catalog.pg_extension
  WHERE extname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Available extensions (installable). */
export const Query_for_list_of_available_extensions = `
  SELECT pg_catalog.quote_ident(name)
  FROM pg_catalog.pg_available_extensions
  WHERE name ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Databases. */
export const Query_for_list_of_databases = `
  SELECT pg_catalog.quote_ident(datname)
  FROM pg_catalog.pg_database
  WHERE datname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Types. */
export const Query_for_list_of_types = `
  SELECT pg_catalog.quote_ident(t.typname)
  FROM pg_catalog.pg_type t
  WHERE (t.typrelid = 0 OR
         (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid))
    AND t.typname NOT LIKE E'\\\\_%'
    AND t.typname ILIKE $1
    AND pg_catalog.pg_type_is_visible(t.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Languages. */
export const Query_for_list_of_languages = `
  SELECT pg_catalog.quote_ident(lanname)
  FROM pg_catalog.pg_language
  WHERE lanname != 'internal'
    AND lanname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Tablespaces. */
export const Query_for_list_of_tablespaces = `
  SELECT pg_catalog.quote_ident(spcname)
  FROM pg_catalog.pg_tablespace
  WHERE spcname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Operators. */
export const Query_for_list_of_operators = `
  SELECT pg_catalog.quote_ident(o.oprname)
  FROM pg_catalog.pg_operator o
  WHERE o.oprname ILIKE $1
    AND pg_catalog.pg_operator_is_visible(o.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Casts (no quoting; format is "type AS type" — used rarely). */
export const Query_for_list_of_casts = `
  SELECT pg_catalog.format_type(castsource, NULL)
         || ' AS '
         || pg_catalog.format_type(casttarget, NULL) AS cast
  FROM pg_catalog.pg_cast
  WHERE pg_catalog.format_type(castsource, NULL)
        || ' AS '
        || pg_catalog.format_type(casttarget, NULL) ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Configuration parameter (GUC) names — `pg_settings`. */
export const Query_for_list_of_set_vars = `
  SELECT pg_catalog.lower(name)
  FROM pg_catalog.pg_settings
  WHERE name ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Allowed values of an enum-typed GUC — `pg_settings.enumvals`.
 *
 * The GUC name is the first parameter (matched case-insensitively against
 * `pg_settings.name`, since names like `IntervalStyle` appear mixed-case in
 * the catalog but are addressed in lowercase from user input). The ILIKE
 * prefix on the unnested values is the trailing parameter.
 *
 * Mirrors upstream `tab-complete.in.c`'s `Query_for_values_of_enum_GUC`. The
 * catalog stores enum values in lowercase (e.g. `iso_8601`, `use_column`),
 * which matches how `SET <name> TO <value>` expects them.
 */
export const Query_for_values_of_enum_GUC = `
  SELECT val
  FROM (
    SELECT pg_catalog.unnest(enumvals) AS val
    FROM pg_catalog.pg_settings
    WHERE pg_catalog.lower(name) = pg_catalog.lower($1)
      AND enumvals IS NOT NULL
  ) sub
  WHERE val ILIKE $2
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Access methods (index AMs primarily). */
export const Query_for_list_of_access_methods = `
  SELECT pg_catalog.quote_ident(amname)
  FROM pg_catalog.pg_am
  WHERE amname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Index access methods only (`amtype = 'i'`). */
export const Query_for_list_of_index_access_methods = `
  SELECT pg_catalog.quote_ident(amname)
  FROM pg_catalog.pg_am
  WHERE amname ILIKE $1
    AND amtype = 'i'
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Built-in type names — for CREATE TABLE column-type completion. */
export const Query_for_list_of_datatypes = `
  SELECT pg_catalog.format_type(t.oid, NULL)
  FROM pg_catalog.pg_type t
  WHERE (t.typrelid = 0 OR
         (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid))
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type el
      WHERE el.typarray = t.oid
    )
    AND pg_catalog.format_type(t.oid, NULL) ILIKE $1
    AND pg_catalog.pg_type_is_visible(t.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Publications. */
export const Query_for_list_of_publications = `
  SELECT pg_catalog.quote_ident(pubname)
  FROM pg_catalog.pg_publication
  WHERE pubname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Subscriptions. */
export const Query_for_list_of_subscriptions = `
  SELECT pg_catalog.quote_ident(subname)
  FROM pg_catalog.pg_subscription
  WHERE subname ILIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Relations qualified by an explicit schema. The caller passes the schema
 * name as $1 and the ILIKE prefix as $2 — this lets `SELECT * FROM pg_catalog.x`
 * complete to `pg_catalog.xxxx`. The schema name is matched
 * case-insensitively so `PUBLIC.t` resolves to relations in `public`.
 *
 * Note: deliberately excludes `relkind = 'i'` (indexes) so that
 * `SELECT * FROM public.tab<tab>` doesn't include `tab1_pkey` alongside
 * `tab1`. Index-qualifying completions (REINDEX, DROP INDEX, ALTER INDEX)
 * have their own table-kind queries and don't route through this helper.
 */
export const Query_for_list_of_relations_in_schema = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  WHERE c.relkind IN ('r','v','m','S','f','p')
    AND pg_catalog.lower(n.nspname) = pg_catalog.lower($1)
    AND c.relname ILIKE $2
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Constraint names attached to a referenced table. Mirrors upstream's
 * `Query_for_constraint_of_table` (tab-complete.in.c ~line 453), which
 * joins `pg_constraint` to `pg_class` via `conrelid` and filters by the
 * referenced table name.
 *
 * Caller passes `[refName]` (the table the user typed between
 * `ALTER TABLE` and `DROP CONSTRAINT`, already case-folded for unquoted
 * input — see `parseTableRef` in rules.ts) and the ILIKE prefix.
 *
 * Visibility is checked via `pg_table_is_visible(c.oid)` so the user's
 * `search_path` controls which schema's `tab1` is matched when the user
 * gives an unqualified reference.
 */
export const Query_for_constraint_of_table = `
  SELECT pg_catalog.quote_ident(con.conname)
  FROM pg_catalog.pg_constraint con, pg_catalog.pg_class c
  WHERE con.conrelid = c.oid
    AND c.relname = $1
    AND pg_catalog.pg_table_is_visible(c.oid)
    AND con.conname ILIKE $2
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Constraint names attached to a referenced table within a specific
 * schema. Used when the user qualified the reference, e.g.
 * `ALTER TABLE public."tab1" DROP CONSTRAINT t<TAB>`. The schema name is
 * matched case-insensitively against `pg_namespace.nspname` so
 * `PUBLIC.tab1` still resolves to constraints in the `public` schema.
 *
 * Caller passes `[schema, refName]` (with `refName` already case-folded
 * for the unquoted form), and the ILIKE prefix as the trailing parameter.
 */
export const Query_for_constraint_of_table_in_schema = `
  SELECT pg_catalog.quote_ident(con.conname)
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON con.conrelid = c.oid
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  WHERE pg_catalog.lower(n.nspname) = pg_catalog.lower($1)
    AND c.relname = $2
    AND con.conname ILIKE $3
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Tables (regular + partitioned) that have a constraint with the given
 * name. The reverse direction of `Query_for_constraint_of_table` — used by
 * the `COMMENT ON CONSTRAINT <name> ON <prefix>` completion to resolve the
 * relation that owns the named constraint.
 *
 * Caller passes `[constraintName]`, then the ILIKE prefix on the relname.
 * Mirrors upstream's `Query_for_list_of_tables_for_constraint` SchemaQuery
 * (tab-complete.in.c ~line 694), which uses
 * `selcondition = "c.oid=con.conrelid and c.relkind IN ('r','p')"` and
 * `refname = "con.conname"`. The `quote_ident()` wrapper ensures
 * names that need quoting (mixed case, reserved words) come back in a
 * paste-safe form.
 */
export const Query_for_list_of_tables_for_constraint = `
  SELECT DISTINCT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c, pg_catalog.pg_constraint con
  WHERE c.oid = con.conrelid
    AND c.relkind IN ('r', 'p')
    AND pg_catalog.pg_table_is_visible(c.oid)
    AND con.conname = $1
    AND c.relname ILIKE $2
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Same as `Query_for_list_of_tables_for_constraint` but scoped to a
 * specific schema (so `COMMENT ON CONSTRAINT foo ON public.<TAB>` only
 * shows relations in `public`).
 *
 * Caller passes `[constraintName, schema]`, then the ILIKE prefix. Schema
 * is matched case-insensitively to handle `PUBLIC.<TAB>` → `public.*`.
 */
export const Query_for_list_of_tables_for_constraint_in_schema = `
  SELECT DISTINCT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_constraint con ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  WHERE c.relkind IN ('r', 'p')
    AND pg_catalog.lower(n.nspname) = pg_catalog.lower($2)
    AND con.conname = $1
    AND c.relname ILIKE $3
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Enum label values for the named enum type. Mirrors upstream's
 * `Query_for_list_of_enum_values_quoted` / `…_unquoted` (tab-complete.in.c
 * ~line 602-618), with a parameter-bound type name in place of upstream's
 * `set_completion_reference()` macro state.
 *
 * The caller picks the variant based on whether the user is mid-string-
 * literal (current word starts with `'`), and passes `[typeName]` along
 * with the ILIKE prefix as the trailing parameter. The quoted variant
 * uses `quote_literal` so candidates come back as `'BLACK'` rather than
 * bare `BLACK`, and the case-sensitive `enumlabel LIKE` ensures upstream
 * parity for tests like `RENAME VALUE 'B<TAB>` → `'BLACK'`.
 */
export const Query_for_list_of_enum_values_quoted = `
  SELECT pg_catalog.quote_literal(e.enumlabel)
  FROM pg_catalog.pg_enum e, pg_catalog.pg_type t
  WHERE t.oid = e.enumtypid
    AND t.typname = $1
    AND pg_catalog.pg_type_is_visible(t.oid)
    AND e.enumlabel LIKE $2
  ORDER BY 1
  LIMIT ${LIMIT}
`;

export const Query_for_list_of_enum_values_unquoted = `
  SELECT e.enumlabel
  FROM pg_catalog.pg_enum e, pg_catalog.pg_type t
  WHERE t.oid = e.enumtypid
    AND t.typname = $1
    AND pg_catalog.pg_type_is_visible(t.oid)
    AND e.enumlabel LIKE $2
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Timezone names from `pg_timezone_names()`. Three variants mirror
 * upstream's `COMPLETE_WITH_TIMEZONE_NAME()` macro (tab-complete.in.c
 * ~line 1160-1173) — different result shapes for the three contexts:
 *
 *   - `…_unquoted`     emits the bare name `America/New_York`. Used when
 *                      the cursor is already inside an opened single-
 *                      quoted string (`SET timezone TO 'America/New_<TAB>`),
 *                      so the editor inserts the rest of the name and the
 *                      closing quote.
 *   - `…_quoted_out`   emits the candidate wrapped in single quotes —
 *                      `'America/New_York'`. Used when the user hasn't
 *                      typed any quote yet (`SET timezone TO am<TAB>` →
 *                      `'America/`).
 *   - `…_quoted_in`    emits the quoted form AND matches the quoted form
 *                      against the LIKE pattern. Used when the user's
 *                      partial word itself starts with `'` (so we feed
 *                      `'am%` to the LIKE), so the editor can complete
 *                      from inside the literal.
 *
 * All three are case-insensitive on the name (lower(name) LIKE lower(pat))
 * because IANA names like `America/New_York` mix case but should still
 * match a lowercase prefix.
 */
export const Query_for_list_of_timezone_names_unquoted = `
  SELECT name
  FROM pg_catalog.pg_timezone_names()
  WHERE pg_catalog.lower(name) LIKE pg_catalog.lower($1)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

export const Query_for_list_of_timezone_names_quoted_out = `
  SELECT pg_catalog.quote_literal(name) AS name
  FROM pg_catalog.pg_timezone_names()
  WHERE pg_catalog.lower(name) LIKE pg_catalog.lower($1)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

export const Query_for_list_of_timezone_names_quoted_in = `
  SELECT pg_catalog.quote_literal(name) AS name
  FROM pg_catalog.pg_timezone_names()
  WHERE pg_catalog.quote_literal(pg_catalog.lower(name)) LIKE pg_catalog.lower($1)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Run one of the templates above against a connection and return the
 * single-column results as a string array. Empty array on any error so the
 * completer degrades gracefully — a flaky catalog query shouldn't crash the
 * REPL.
 *
 * `pattern` is the user's partial input; we append `%` automatically.
 */
export const runCatalogQuery = async (
  conn: Connection,
  sql: string,
  pattern: string,
  extraParams: string[] = [],
): Promise<string[]> => {
  try {
    const likePattern = pattern + '%';
    const params =
      extraParams.length > 0 ? [...extraParams, likePattern] : [likePattern];
    const rs = await conn.query(sql, params);
    const out: string[] = [];
    for (const row of rs.rows) {
      const v = row[0];
      if (typeof v === 'string') out.push(v);
    }
    return out;
  } catch {
    return [];
  }
};
