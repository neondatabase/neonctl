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
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Views. */
export const Query_for_list_of_views = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'v'
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Materialized views. */
export const Query_for_list_of_matviews = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'm'
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Sequences. */
export const Query_for_list_of_sequences = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'S'
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Indexes. */
export const Query_for_list_of_indexes = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind IN ('i','I')
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Foreign tables. */
export const Query_for_list_of_foreign_tables = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind = 'f'
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Any relation (tables, views, mviews, indexes, sequences, foreign tables). */
export const Query_for_list_of_relations = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind IN ('r','v','m','S','f','p')
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Tables + views + matviews (what FROM/UPDATE/INSERT INTO accept). */
export const Query_for_list_of_tables_views = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  WHERE c.relkind IN ('r','v','m','p','f')
    AND c.relname LIKE $1
    AND pg_catalog.pg_table_is_visible(c.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Schemas. */
export const Query_for_list_of_schemas = `
  SELECT pg_catalog.quote_ident(nspname)
  FROM pg_catalog.pg_namespace
  WHERE nspname LIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Functions (not procedures). */
export const Query_for_list_of_functions = `
  SELECT pg_catalog.quote_ident(p.proname)
  FROM pg_catalog.pg_proc p
  WHERE p.proname LIKE $1
    AND pg_catalog.pg_function_is_visible(p.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Roles. */
export const Query_for_list_of_roles = `
  SELECT pg_catalog.quote_ident(rolname)
  FROM pg_catalog.pg_roles
  WHERE rolname LIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Extensions. */
export const Query_for_list_of_extensions = `
  SELECT pg_catalog.quote_ident(extname)
  FROM pg_catalog.pg_extension
  WHERE extname LIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Available extensions (installable). */
export const Query_for_list_of_available_extensions = `
  SELECT pg_catalog.quote_ident(name)
  FROM pg_catalog.pg_available_extensions
  WHERE name LIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Databases. */
export const Query_for_list_of_databases = `
  SELECT pg_catalog.quote_ident(datname)
  FROM pg_catalog.pg_database
  WHERE datname LIKE $1
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
    AND t.typname LIKE $1
    AND pg_catalog.pg_type_is_visible(t.oid)
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Languages. */
export const Query_for_list_of_languages = `
  SELECT pg_catalog.quote_ident(lanname)
  FROM pg_catalog.pg_language
  WHERE lanname != 'internal'
    AND lanname LIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Tablespaces. */
export const Query_for_list_of_tablespaces = `
  SELECT pg_catalog.quote_ident(spcname)
  FROM pg_catalog.pg_tablespace
  WHERE spcname LIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/** Operators. */
export const Query_for_list_of_operators = `
  SELECT pg_catalog.quote_ident(o.oprname)
  FROM pg_catalog.pg_operator o
  WHERE o.oprname LIKE $1
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
        || pg_catalog.format_type(casttarget, NULL) LIKE $1
  ORDER BY 1
  LIMIT ${LIMIT}
`;

/**
 * Relations qualified by an explicit schema. The caller passes the schema
 * name as $1 and the LIKE prefix as $2 — this lets `SELECT * FROM pg_catalog.x`
 * complete to `pg_catalog.xxxx`.
 */
export const Query_for_list_of_relations_in_schema = `
  SELECT pg_catalog.quote_ident(c.relname)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  WHERE c.relkind IN ('r','v','m','S','f','p','i')
    AND n.nspname = $1
    AND c.relname LIKE $2
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
