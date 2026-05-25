/**
 * SQL builders for psql's `\d*` describe commands.
 *
 * Each exported function returns a {@link DescribeQuery} carrying the SQL the
 * upstream C `describe.c` would have produced for the same `\d*` invocation,
 * adapted for the active `serverVersion`. The header text (column aliases)
 * matches upstream literally so that WP-20's formatter can rely on stable
 * output column names.
 *
 * Pattern matching (the `processSQLNamePattern` flex routine in upstream) is
 * NOT yet implemented; we accept a `pattern` option and emit a placeholder
 * `(<col> ~ $1 OR $1 IS NULL)` clause where needed. WP-20 wires the real
 * pattern parser. See TODO comments throughout.
 *
 * Translation policy: SQL whitespace is normalized but column aliases and
 * catalog table/column names are byte-identical to upstream. Conditional
 * branches in the C source collapse into TS conditional concatenation gated
 * on `serverVersion`.
 */

import type { ServerVersion } from './versionGate.js';
import {
  serverAtLeast,
  serverLess,
  PG_9_5,
  PG_9_6,
  PG_10,
  PG_11,
  PG_12,
  PG_13,
  PG_14,
  PG_15,
  PG_16,
  PG_17,
} from './versionGate.js';

export type DescribeQuery = {
  sql: string;
  params: unknown[];
  description?: string;
};

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reproduces upstream `printACLColumn(buf, colname)`: emits the standard
 * ACL pretty-printing expression with column alias "Access privileges".
 */
const aclColumn = (colname: string): string =>
  `CASE WHEN pg_catalog.array_length(${colname}, 1) = 0 THEN '(none)'` +
  ` ELSE pg_catalog.array_to_string(${colname}, E'\\n') END AS "Access privileges"`;

/**
 * Placeholder pattern clause. WP-20 will replace these stubs with the real
 * `processSQLNamePattern` port. For now the clause is a tautology so the
 * query runs unfiltered; the pattern parameter is still threaded through
 * `params` so callers do not need to change call sites later.
 *
 * @param hasWhere whether a WHERE clause already exists in the SQL
 * @param schemaCol column expression for the schema name, or undefined
 * @param nameCol column expression for the object name
 */
const patternStub = (
  hasWhere: boolean,
  schemaCol: string | undefined,
  nameCol: string,
): string => {
  // TODO(WP-20): real pattern matching via processSQLNamePattern port.
  void schemaCol;
  void nameCol;
  const join = hasWhere ? '  AND ' : 'WHERE ';
  return `${join}true /* TODO(WP-20): pattern matching */\n`;
};

const orderBy = (cols: string): string => `ORDER BY ${cols};`;

type CommonOpts = {
  pattern?: string;
  verbose?: boolean;
  showSystem?: boolean;
  serverVersion: ServerVersion;
};

const params = (opts: { pattern?: string }): unknown[] =>
  opts.pattern === undefined ? [] : [opts.pattern];

/* ------------------------------------------------------------------ */
/* \da — describeAggregates                                           */
/* ------------------------------------------------------------------ */
export const describeAggregates = (opts: CommonOpts): DescribeQuery => {
  const { showSystem, pattern, serverVersion } = opts;
  let sql = '';
  sql +=
    'SELECT n.nspname as "Schema",\n' +
    '  p.proname AS "Name",\n' +
    '  pg_catalog.format_type(p.prorettype, NULL) AS "Result data type",\n' +
    '  CASE WHEN p.pronargs = 0\n' +
    "    THEN CAST('*' AS pg_catalog.text)\n" +
    '    ELSE pg_catalog.pg_get_function_arguments(p.oid)\n' +
    '  END AS "Argument data types",\n' +
    '  pg_catalog.obj_description(p.oid, \'pg_proc\') as "Description"\n' +
    'FROM pg_catalog.pg_proc p\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace\n';
  sql += serverAtLeast(serverVersion, PG_11)
    ? "WHERE p.prokind = 'a'\n"
    : 'WHERE p.proisagg\n';
  if (!showSystem && pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n" +
      "      AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(true, 'n.nspname', 'p.proname');
  sql += orderBy('1, 2, 4');
  return {
    sql,
    params: params(opts),
    description: 'List of aggregate functions',
  };
};

/* ------------------------------------------------------------------ */
/* \dA — describeAccessMethods                                        */
/* ------------------------------------------------------------------ */
export const describeAccessMethods = (opts: CommonOpts): DescribeQuery => {
  const { verbose, serverVersion } = opts;
  if (serverLess(serverVersion, 9, 6)) {
    return {
      sql: '/* server < 9.6 does not support access methods */ SELECT 1 WHERE false;',
      params: [],
      description: 'List of access methods',
    };
  }
  let sql =
    'SELECT amname AS "Name",\n' +
    "  CASE amtype WHEN 'i' THEN 'Index' WHEN 't' THEN 'Table' END AS \"Type\"";
  if (verbose) {
    sql +=
      ',\n  amhandler AS "Handler",\n' +
      '  pg_catalog.obj_description(oid, \'pg_am\') AS "Description"';
  }
  sql += '\nFROM pg_catalog.pg_am\n';
  sql += patternStub(false, undefined, 'amname');
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of access methods' };
};

/* ------------------------------------------------------------------ */
/* \db — describeTablespaces                                          */
/* ------------------------------------------------------------------ */
export const describeTablespaces = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT spcname AS "Name",\n' +
    '  pg_catalog.pg_get_userbyid(spcowner) AS "Owner",\n' +
    '  pg_catalog.pg_tablespace_location(oid) AS "Location"';
  if (verbose) {
    sql += ',\n  ' + aclColumn('spcacl');
    sql +=
      ',\n  spcoptions AS "Options",\n' +
      '  pg_catalog.pg_size_pretty(pg_catalog.pg_tablespace_size(oid)) AS "Size",\n' +
      '  pg_catalog.shobj_description(oid, \'pg_tablespace\') AS "Description"';
  }
  sql += '\nFROM pg_catalog.pg_tablespace\n';
  sql += patternStub(false, undefined, 'spcname');
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of tablespaces' };
};

/* ------------------------------------------------------------------ */
/* \df — describeFunctions                                            */
/* ------------------------------------------------------------------ */
type DescribeFunctionsOpts = CommonOpts & {
  /** Combination of 'a' (aggregate), 'n' (normal), 'p' (procedure), 't' (trigger), 'w' (window). Empty = all. */
  functypes?: string;
};
export const describeFunctions = (
  opts: DescribeFunctionsOpts,
): DescribeQuery => {
  const { verbose, showSystem, pattern, serverVersion } = opts;
  const functypes = opts.functypes ?? '';
  let showAgg = functypes.includes('a');
  let showNorm = functypes.includes('n');
  let showProc = functypes.includes('p');
  let showTrig = functypes.includes('t');
  let showWin = functypes.includes('w');
  if (!showAgg && !showNorm && !showProc && !showTrig && !showWin) {
    showAgg = showNorm = showTrig = showWin = true;
    if (serverAtLeast(serverVersion, PG_11)) showProc = true;
  }

  let sql = 'SELECT n.nspname as "Schema",\n  p.proname as "Name",\n';
  if (serverAtLeast(serverVersion, PG_11)) {
    sql +=
      '  pg_catalog.pg_get_function_result(p.oid) as "Result data type",\n' +
      '  pg_catalog.pg_get_function_arguments(p.oid) as "Argument data types",\n' +
      ' CASE p.prokind\n' +
      "  WHEN 'a' THEN 'agg'\n" +
      "  WHEN 'w' THEN 'window'\n" +
      "  WHEN 'p' THEN 'proc'\n" +
      "  ELSE 'func'\n" +
      ' END as "Type"';
  } else {
    sql +=
      '  pg_catalog.pg_get_function_result(p.oid) as "Result data type",\n' +
      '  pg_catalog.pg_get_function_arguments(p.oid) as "Argument data types",\n' +
      ' CASE\n' +
      "  WHEN p.proisagg THEN 'agg'\n" +
      "  WHEN p.proiswindow THEN 'window'\n" +
      "  WHEN p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype THEN 'trigger'\n" +
      "  ELSE 'func'\n" +
      ' END as "Type"';
  }

  if (verbose) {
    sql +=
      ',\n CASE\n' +
      "  WHEN p.provolatile = 'i' THEN 'immutable'\n" +
      "  WHEN p.provolatile = 's' THEN 'stable'\n" +
      "  WHEN p.provolatile = 'v' THEN 'volatile'\n" +
      ' END as "Volatility"';
    if (serverAtLeast(serverVersion, PG_9_6)) {
      sql +=
        ',\n CASE\n' +
        "  WHEN p.proparallel = 'r' THEN 'restricted'\n" +
        "  WHEN p.proparallel = 's' THEN 'safe'\n" +
        "  WHEN p.proparallel = 'u' THEN 'unsafe'\n" +
        ' END as "Parallel"';
    }
    sql +=
      ',\n pg_catalog.pg_get_userbyid(p.proowner) as "Owner"' +
      ",\n CASE WHEN prosecdef THEN 'definer' ELSE 'invoker' END AS \"Security\"" +
      ",\n CASE WHEN p.proleakproof THEN 'yes' ELSE 'no' END as \"Leakproof?\"";
    sql += ',\n ' + aclColumn('p.proacl');
    sql +=
      ',\n l.lanname as "Language"' +
      ",\n CASE WHEN l.lanname IN ('internal', 'c') THEN p.prosrc END as \"Internal name\"" +
      ',\n pg_catalog.obj_description(p.oid, \'pg_proc\') as "Description"';
  }

  sql +=
    '\nFROM pg_catalog.pg_proc p' +
    '\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace\n';
  if (verbose) {
    sql += '     LEFT JOIN pg_catalog.pg_language l ON l.oid = p.prolang\n';
  }

  let hasWhere = false;
  const allTypes = showAgg && showNorm && showProc && showTrig && showWin;
  if (!allTypes && showNorm) {
    if (!showAgg) {
      sql += hasWhere ? '      AND ' : 'WHERE ';
      hasWhere = true;
      sql += serverAtLeast(serverVersion, PG_11)
        ? "p.prokind <> 'a'\n"
        : 'NOT p.proisagg\n';
    }
    if (!showProc && serverAtLeast(serverVersion, PG_11)) {
      sql += hasWhere ? '      AND ' : 'WHERE ';
      hasWhere = true;
      sql += "p.prokind <> 'p'\n";
    }
    if (!showTrig) {
      sql += hasWhere ? '      AND ' : 'WHERE ';
      hasWhere = true;
      sql += "p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype\n";
    }
    if (!showWin) {
      sql += hasWhere ? '      AND ' : 'WHERE ';
      hasWhere = true;
      sql += serverAtLeast(serverVersion, PG_11)
        ? "p.prokind <> 'w'\n"
        : 'NOT p.proiswindow\n';
    }
  } else if (!allTypes) {
    sql += 'WHERE (\n       ';
    hasWhere = true;
    const parts: string[] = [];
    if (showAgg) {
      parts.push(
        serverAtLeast(serverVersion, PG_11) ? "p.prokind = 'a'" : 'p.proisagg',
      );
    }
    if (showTrig) {
      parts.push("p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype");
    }
    if (showProc) parts.push("p.prokind = 'p'");
    if (showWin) {
      parts.push(
        serverAtLeast(serverVersion, PG_11)
          ? "p.prokind = 'w'"
          : 'p.proiswindow',
      );
    }
    sql += parts.join('\n       OR ') + '\n      )\n';
  }

  sql += patternStub(hasWhere, 'n.nspname', 'p.proname');

  if (!showSystem && pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n" +
      "      AND n.nspname <> 'information_schema'\n";
  }
  sql += orderBy('1, 2, 4');
  return { sql, params: params(opts), description: 'List of functions' };
};

/* ------------------------------------------------------------------ */
/* \dT — describeTypes                                                */
/* ------------------------------------------------------------------ */
export const describeTypes = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern } = opts;
  let sql =
    'SELECT n.nspname as "Schema",\n  pg_catalog.format_type(t.oid, NULL) AS "Name",\n';
  if (verbose) {
    sql +=
      '  t.typname AS "Internal name",\n' +
      '  CASE WHEN t.typrelid != 0\n' +
      "      THEN CAST('tuple' AS pg_catalog.text)\n" +
      '    WHEN t.typlen < 0\n' +
      "      THEN CAST('var' AS pg_catalog.text)\n" +
      '    ELSE CAST(t.typlen AS pg_catalog.text)\n' +
      '  END AS "Size",\n' +
      '  pg_catalog.array_to_string(\n' +
      '      ARRAY(\n' +
      '          SELECT e.enumlabel\n' +
      '          FROM pg_catalog.pg_enum e\n' +
      '          WHERE e.enumtypid = t.oid\n' +
      '          ORDER BY e.enumsortorder\n' +
      '      ),\n' +
      "      E'\\n'\n" +
      '  ) AS "Elements",\n' +
      '  pg_catalog.pg_get_userbyid(t.typowner) AS "Owner",\n  ' +
      aclColumn('t.typacl') +
      ',\n  ';
  }
  sql += '  pg_catalog.obj_description(t.oid, \'pg_type\') as "Description"\n';
  sql +=
    'FROM pg_catalog.pg_type t\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace\n';
  sql += 'WHERE (t.typrelid = 0 ';
  sql +=
    "OR (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid))\n";
  if (!pattern?.includes('[]')) {
    sql +=
      '  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)\n';
  }
  if (!showSystem && pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n" +
      "      AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(true, 'n.nspname', 't.typname');
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'List of data types' };
};

/* ------------------------------------------------------------------ */
/* \do — describeOperators                                            */
/* ------------------------------------------------------------------ */
export const describeOperators = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern } = opts;
  let sql =
    'SELECT n.nspname as "Schema",\n' +
    '  o.oprname AS "Name",\n' +
    '  CASE WHEN o.oprkind=\'l\' THEN NULL ELSE pg_catalog.format_type(o.oprleft, NULL) END AS "Left arg type",\n' +
    '  CASE WHEN o.oprkind=\'r\' THEN NULL ELSE pg_catalog.format_type(o.oprright, NULL) END AS "Right arg type",\n' +
    '  pg_catalog.format_type(o.oprresult, NULL) AS "Result type",\n';
  if (verbose) {
    sql +=
      '  o.oprcode AS "Function",\n' +
      "  CASE WHEN p.proleakproof THEN 'yes' ELSE 'no' END AS \"Leakproof?\",\n";
  }
  sql +=
    "  coalesce(pg_catalog.obj_description(o.oid, 'pg_operator'),\n" +
    '           pg_catalog.obj_description(o.oprcode, \'pg_proc\')) AS "Description"\n' +
    'FROM pg_catalog.pg_operator o\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace\n';
  if (verbose) {
    sql += '     LEFT JOIN pg_catalog.pg_proc p ON p.oid = o.oprcode\n';
  }
  let hasWhere = false;
  if (!showSystem && pattern === undefined) {
    sql +=
      "WHERE n.nspname <> 'pg_catalog'\n      AND n.nspname <> 'information_schema'\n";
    hasWhere = true;
  }
  sql += patternStub(hasWhere, 'n.nspname', 'o.oprname');
  sql += orderBy('1, 2, 3, 4');
  return { sql, params: params(opts), description: 'List of operators' };
};

/* ------------------------------------------------------------------ */
/* \l / \list — listAllDbs                                            */
/* ------------------------------------------------------------------ */
export const listAllDbs = (opts: CommonOpts): DescribeQuery => {
  const { verbose, serverVersion } = opts;
  let sql =
    'SELECT\n' +
    '  d.datname as "Name",\n' +
    '  pg_catalog.pg_get_userbyid(d.datdba) as "Owner",\n' +
    '  pg_catalog.pg_encoding_to_char(d.encoding) as "Encoding",\n';
  if (serverAtLeast(serverVersion, PG_15)) {
    sql +=
      '  CASE d.datlocprovider' +
      " WHEN 'b' THEN 'builtin'" +
      " WHEN 'c' THEN 'libc'" +
      " WHEN 'i' THEN 'icu'" +
      ' END AS "Locale Provider",\n';
  } else {
    sql += '  \'libc\' AS "Locale Provider",\n';
  }
  sql += '  d.datcollate as "Collate",\n  d.datctype as "Ctype",\n';
  if (serverAtLeast(serverVersion, PG_17)) {
    sql += '  d.datlocale as "Locale",\n';
  } else if (serverAtLeast(serverVersion, PG_15)) {
    sql += '  d.daticulocale as "Locale",\n';
  } else {
    sql += '  NULL as "Locale",\n';
  }
  if (serverAtLeast(serverVersion, PG_16)) {
    sql += '  d.daticurules as "ICU Rules",\n';
  } else {
    sql += '  NULL as "ICU Rules",\n';
  }
  sql += '  ' + aclColumn('d.datacl');
  if (verbose) {
    sql +=
      ",\n  CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT')\n" +
      '       THEN pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname))\n' +
      "       ELSE 'No Access'\n" +
      '  END as "Size"' +
      ',\n  t.spcname as "Tablespace"' +
      ',\n  pg_catalog.shobj_description(d.oid, \'pg_database\') as "Description"';
  }
  sql += '\nFROM pg_catalog.pg_database d\n';
  if (verbose) {
    sql += '  JOIN pg_catalog.pg_tablespace t on d.dattablespace = t.oid\n';
  }
  if (opts.pattern !== undefined) {
    sql += patternStub(false, undefined, 'd.datname');
  }
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of databases' };
};

/* ------------------------------------------------------------------ */
/* \dp / \z — permissionsList                                         */
/* ------------------------------------------------------------------ */
export const permissionsList = (opts: CommonOpts): DescribeQuery => {
  const { showSystem, pattern, serverVersion } = opts;
  let sql =
    'SELECT n.nspname as "Schema",\n' +
    '  c.relname as "Name",\n' +
    '  CASE c.relkind' +
    " WHEN 'r' THEN 'table'" +
    " WHEN 'v' THEN 'view'" +
    " WHEN 'm' THEN 'materialized view'" +
    " WHEN 'S' THEN 'sequence'" +
    " WHEN 'f' THEN 'foreign table'" +
    " WHEN 'p' THEN 'partitioned table'" +
    ' END as "Type",\n  ';
  sql += aclColumn('c.relacl');
  sql +=
    ',\n  pg_catalog.array_to_string(ARRAY(\n' +
    "    SELECT attname || E':\\n  ' || pg_catalog.array_to_string(attacl, E'\\n  ')\n" +
    '    FROM pg_catalog.pg_attribute a\n' +
    '    WHERE attrelid = c.oid AND NOT attisdropped AND attacl IS NOT NULL\n' +
    '  ), E\'\\n\') AS "Column privileges"';
  if (serverAtLeast(serverVersion, PG_10)) {
    sql +=
      ',\n  pg_catalog.array_to_string(ARRAY(\n' +
      '    SELECT polname\n' +
      "    || CASE WHEN NOT polpermissive THEN E' (RESTRICTIVE)' ELSE '' END\n" +
      "    || CASE WHEN polcmd != '*' THEN E' (' || polcmd::pg_catalog.text || E'):' ELSE E':' END\n" +
      "    || CASE WHEN polqual IS NOT NULL THEN E'\\n  (u): ' || pg_catalog.pg_get_expr(polqual, polrelid) ELSE E'' END\n" +
      "    || CASE WHEN polwithcheck IS NOT NULL THEN E'\\n  (c): ' || pg_catalog.pg_get_expr(polwithcheck, polrelid) ELSE E'' END\n" +
      "    || CASE WHEN polroles <> '{0}' THEN E'\\n  to: ' || pg_catalog.array_to_string(\n" +
      '             ARRAY(SELECT rolname FROM pg_catalog.pg_roles WHERE oid = ANY (polroles) ORDER BY 1)\n' +
      "             , E', ') ELSE E'' END\n" +
      '    FROM pg_catalog.pg_policy pol\n' +
      '    WHERE polrelid = c.oid), E\'\\n\') AS "Policies"';
  } else if (serverAtLeast(serverVersion, PG_9_5)) {
    sql +=
      ',\n  pg_catalog.array_to_string(ARRAY(\n' +
      '    SELECT polname\n' +
      "    || CASE WHEN polcmd != '*' THEN E' (' || polcmd::pg_catalog.text || E'):' ELSE E':' END\n" +
      "    || CASE WHEN polqual IS NOT NULL THEN E'\\n  (u): ' || pg_catalog.pg_get_expr(polqual, polrelid) ELSE E'' END\n" +
      "    || CASE WHEN polwithcheck IS NOT NULL THEN E'\\n  (c): ' || pg_catalog.pg_get_expr(polwithcheck, polrelid) ELSE E'' END\n" +
      "    || CASE WHEN polroles <> '{0}' THEN E'\\n  to: ' || pg_catalog.array_to_string(\n" +
      '             ARRAY(SELECT rolname FROM pg_catalog.pg_roles WHERE oid = ANY (polroles) ORDER BY 1)\n' +
      "             , E', ') ELSE E'' END\n" +
      '    FROM pg_catalog.pg_policy pol\n' +
      '    WHERE polrelid = c.oid), E\'\\n\') AS "Policies"';
  }
  sql +=
    '\nFROM pg_catalog.pg_class c\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n' +
    "WHERE c.relkind IN ('r','v','m','S','f','p')\n";
  if (!showSystem && pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n      AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(true, 'n.nspname', 'c.relname');
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'Access privileges' };
};

/* ------------------------------------------------------------------ */
/* \ddp — listDefaultACLs                                             */
/* ------------------------------------------------------------------ */
export const listDefaultACLs = (opts: CommonOpts): DescribeQuery => {
  let sql =
    'SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS "Owner",\n' +
    '  n.nspname AS "Schema",\n' +
    '  CASE d.defaclobjtype' +
    " WHEN 'r' THEN 'table'" +
    " WHEN 'S' THEN 'sequence'" +
    " WHEN 'f' THEN 'function'" +
    " WHEN 'T' THEN 'type'" +
    " WHEN 'n' THEN 'schema'" +
    " WHEN 'L' THEN 'large object'" +
    ' END AS "Type",\n  ';
  sql += aclColumn('d.defaclacl');
  sql +=
    '\nFROM pg_catalog.pg_default_acl d\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace\n';
  sql += patternStub(
    false,
    'n.nspname',
    'pg_catalog.pg_get_userbyid(d.defaclrole)',
  );
  sql += orderBy('1, 2, 3');
  return {
    sql,
    params: params(opts),
    description: 'Default access privileges',
  };
};

/* ------------------------------------------------------------------ */
/* \dd — objectDescription                                            */
/* ------------------------------------------------------------------ */
export const objectDescription = (opts: CommonOpts): DescribeQuery => {
  const sysPart = (objLabel: string): string =>
    !opts.showSystem && opts.pattern === undefined
      ? `WHERE n.nspname <> 'pg_catalog' AND n.nspname <> 'information_schema'` +
        ` /* ${objLabel} */ `
      : `WHERE true /* ${objLabel} */ `;
  let sql =
    'SELECT DISTINCT tt.nspname AS "Schema", tt.name AS "Name", tt.object AS "Object", d.description AS "Description"\n' +
    'FROM (\n';
  sql +=
    '  SELECT pgc.oid as oid, pgc.tableoid AS tableoid, n.nspname as nspname,\n' +
    '  CAST(pgc.conname AS pg_catalog.text) as name,' +
    "  CAST('table constraint' AS pg_catalog.text) as object\n" +
    '  FROM pg_catalog.pg_constraint pgc\n' +
    '    JOIN pg_catalog.pg_class c ON c.oid = pgc.conrelid\n' +
    '    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n' +
    sysPart('table constraint') +
    '\n';

  sql +=
    'UNION ALL\n' +
    '  SELECT pgc.oid, pgc.tableoid, n.nspname,\n' +
    '  CAST(pgc.conname AS pg_catalog.text),' +
    "  CAST('domain constraint' AS pg_catalog.text)\n" +
    '  FROM pg_catalog.pg_constraint pgc\n' +
    '    JOIN pg_catalog.pg_type t ON t.oid = pgc.contypid\n' +
    '    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace\n' +
    sysPart('domain constraint') +
    '\n';

  sql +=
    'UNION ALL\n' +
    '  SELECT o.oid, o.tableoid, n.nspname,\n' +
    '  CAST(o.opcname AS pg_catalog.text),' +
    "  CAST('operator class' AS pg_catalog.text)\n" +
    '  FROM pg_catalog.pg_opclass o\n' +
    '    JOIN pg_catalog.pg_am am ON o.opcmethod = am.oid\n' +
    '    JOIN pg_catalog.pg_namespace n ON n.oid = o.opcnamespace\n' +
    sysPart('operator class') +
    '\n';

  sql +=
    'UNION ALL\n' +
    '  SELECT opf.oid, opf.tableoid, n.nspname,\n' +
    '  CAST(opf.opfname AS pg_catalog.text),' +
    "  CAST('operator family' AS pg_catalog.text)\n" +
    '  FROM pg_catalog.pg_opfamily opf\n' +
    '    JOIN pg_catalog.pg_am am ON opf.opfmethod = am.oid\n' +
    '    JOIN pg_catalog.pg_namespace n ON opf.opfnamespace = n.oid\n' +
    sysPart('operator family') +
    '\n';

  sql +=
    'UNION ALL\n' +
    '  SELECT r.oid, r.tableoid, n.nspname,\n' +
    '  CAST(r.rulename AS pg_catalog.text),' +
    "  CAST('rule' AS pg_catalog.text)\n" +
    '  FROM pg_catalog.pg_rewrite r\n' +
    '       JOIN pg_catalog.pg_class c ON c.oid = r.ev_class\n' +
    '       LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n' +
    "  WHERE r.rulename != '_RETURN'\n";

  sql +=
    'UNION ALL\n' +
    '  SELECT t.oid, t.tableoid, n.nspname,\n' +
    '  CAST(t.tgname AS pg_catalog.text),' +
    "  CAST('trigger' AS pg_catalog.text)\n" +
    '  FROM pg_catalog.pg_trigger t\n' +
    '       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid\n' +
    '       LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n' +
    sysPart('trigger') +
    '\n';

  sql +=
    ') AS tt\n' +
    '  JOIN pg_catalog.pg_description d ON (tt.oid = d.objoid AND tt.tableoid = d.classoid AND d.objsubid = 0)\n';
  sql += orderBy('1, 2, 3');
  return { sql, params: params(opts), description: 'Object descriptions' };
};

/* ------------------------------------------------------------------ */
/* \d (no args / \d <name>) — describeTableDetails                    */
/* This WP delivers ONLY the lookup query; the per-relation detail    */
/* render is WP-20.                                                   */
/* ------------------------------------------------------------------ */
export const describeTableDetails = (opts: CommonOpts): DescribeQuery => {
  const { showSystem, pattern } = opts;
  let sql =
    'SELECT c.oid,\n  n.nspname,\n  c.relname\n' +
    'FROM pg_catalog.pg_class c\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n';
  let hasWhere = false;
  if (!showSystem && pattern === undefined) {
    sql +=
      "WHERE n.nspname <> 'pg_catalog'\n      AND n.nspname <> 'information_schema'\n";
    hasWhere = true;
  }
  sql += patternStub(hasWhere, 'n.nspname', 'c.relname');
  sql += orderBy('2, 3');
  return {
    sql,
    params: params(opts),
    description: 'Get matching relations to describe',
  };
};

/* ------------------------------------------------------------------ */
/* \du / \dg — describeRoles                                          */
/* ------------------------------------------------------------------ */
export const describeRoles = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern, serverVersion } = opts;
  let sql =
    'SELECT r.rolname, r.rolsuper, r.rolinherit,\n' +
    '  r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,\n' +
    '  r.rolconnlimit, r.rolvaliduntil';
  if (verbose) {
    sql +=
      "\n, pg_catalog.shobj_description(r.oid, 'pg_authid') AS description";
  }
  sql += '\n, r.rolreplication';
  if (serverAtLeast(serverVersion, PG_9_5)) sql += '\n, r.rolbypassrls';
  sql += '\nFROM pg_catalog.pg_roles r\n';
  if (!showSystem && pattern === undefined) {
    sql += "WHERE r.rolname !~ '^pg_'\n";
  }
  sql += patternStub(true, undefined, 'r.rolname');
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of roles' };
};

/* ------------------------------------------------------------------ */
/* \drds — listDbRoleSettings                                         */
/* ------------------------------------------------------------------ */
type ListDbRoleSettingsOpts = CommonOpts & { pattern2?: string };
export const listDbRoleSettings = (
  opts: ListDbRoleSettingsOpts,
): DescribeQuery => {
  let sql =
    'SELECT rolname AS "Role", datname AS "Database",\n' +
    'pg_catalog.array_to_string(setconfig, E\'\\n\') AS "Settings"\n' +
    'FROM pg_catalog.pg_db_role_setting s\n' +
    'LEFT JOIN pg_catalog.pg_database d ON d.oid = setdatabase\n' +
    'LEFT JOIN pg_catalog.pg_roles r ON r.oid = setrole\n';
  let hasWhere = false;
  if (opts.pattern !== undefined) {
    sql += patternStub(hasWhere, undefined, 'r.rolname');
    hasWhere = true;
  }
  if (opts.pattern2 !== undefined) {
    sql += patternStub(hasWhere, undefined, 'd.datname');
  }
  sql += orderBy('1, 2');
  const ps: unknown[] = [];
  if (opts.pattern !== undefined) ps.push(opts.pattern);
  if (opts.pattern2 !== undefined) ps.push(opts.pattern2);
  return { sql, params: ps, description: 'List of settings' };
};

/* ------------------------------------------------------------------ */
/* \drg — describeRoleGrants                                          */
/* ------------------------------------------------------------------ */
export const describeRoleGrants = (opts: CommonOpts): DescribeQuery => {
  const { showSystem, pattern, serverVersion } = opts;
  let sql =
    'SELECT m.rolname AS "Role name", r.rolname AS "Member of",\n' +
    "  pg_catalog.concat_ws(', ',\n";
  if (serverAtLeast(serverVersion, PG_16)) {
    sql +=
      "    CASE WHEN pam.admin_option THEN 'ADMIN' END,\n" +
      "    CASE WHEN pam.inherit_option THEN 'INHERIT' END,\n" +
      "    CASE WHEN pam.set_option THEN 'SET' END\n";
  } else {
    sql +=
      "    CASE WHEN pam.admin_option THEN 'ADMIN' END,\n" +
      "    CASE WHEN m.rolinherit THEN 'INHERIT' END,\n" +
      "    'SET'\n";
  }
  sql += '  ) AS "Options",\n  g.rolname AS "Grantor"\n';
  sql +=
    'FROM pg_catalog.pg_roles m\n' +
    '     JOIN pg_catalog.pg_auth_members pam ON (pam.member = m.oid)\n' +
    '     LEFT JOIN pg_catalog.pg_roles r ON (pam.roleid = r.oid)\n' +
    '     LEFT JOIN pg_catalog.pg_roles g ON (pam.grantor = g.oid)\n';
  if (!showSystem && pattern === undefined) {
    sql += "WHERE m.rolname !~ '^pg_'\n";
  }
  sql += patternStub(true, undefined, 'm.rolname');
  sql += orderBy('1, 2, 4');
  return { sql, params: params(opts), description: 'List of role grants' };
};

/* ------------------------------------------------------------------ */
/* \dt \di \dv \dm \ds \dE — listTables                               */
/* ------------------------------------------------------------------ */
type ListTablesOpts = CommonOpts & {
  /** Combination of 't' (tables), 'i' (indexes), 'v' (views), 'm' (matviews), 's' (sequences), 'E' (foreign). */
  tabtypes?: string;
};
export const listTables = (opts: ListTablesOpts): DescribeQuery => {
  const { verbose, showSystem, pattern, serverVersion } = opts;
  const tt = opts.tabtypes ?? '';
  let showTables = tt.includes('t');
  const showIndexes = tt.includes('i');
  let showViews = tt.includes('v');
  let showMatViews = tt.includes('m');
  let showSeq = tt.includes('s');
  let showForeign = tt.includes('E');
  const ntypes =
    +showTables +
    +showIndexes +
    +showViews +
    +showMatViews +
    +showSeq +
    +showForeign;
  if (ntypes === 0) {
    showTables = showViews = showMatViews = showSeq = showForeign = true;
  }

  let sql =
    'SELECT n.nspname as "Schema",\n' +
    '  c.relname as "Name",\n' +
    '  CASE c.relkind' +
    " WHEN 'r' THEN 'table'" +
    " WHEN 'v' THEN 'view'" +
    " WHEN 'm' THEN 'materialized view'" +
    " WHEN 'i' THEN 'index'" +
    " WHEN 'S' THEN 'sequence'" +
    " WHEN 't' THEN 'TOAST table'" +
    " WHEN 'f' THEN 'foreign table'" +
    " WHEN 'p' THEN 'partitioned table'" +
    " WHEN 'I' THEN 'partitioned index'" +
    ' END as "Type",\n' +
    '  pg_catalog.pg_get_userbyid(c.relowner) as "Owner"';
  if (showIndexes) sql += ',\n  c2.relname as "Table"';
  if (verbose) {
    sql +=
      ',\n  CASE c.relpersistence' +
      " WHEN 'p' THEN 'permanent'" +
      " WHEN 't' THEN 'temporary'" +
      " WHEN 'u' THEN 'unlogged'" +
      ' END as "Persistence"';
    const wantsAm =
      serverAtLeast(serverVersion, PG_12) &&
      (showTables || showMatViews || showIndexes);
    if (wantsAm) sql += ',\n  am.amname as "Access method"';
    sql +=
      ',\n  pg_catalog.pg_size_pretty(pg_catalog.pg_table_size(c.oid)) as "Size"' +
      ',\n  pg_catalog.obj_description(c.oid, \'pg_class\') as "Description"';
  }
  sql +=
    '\nFROM pg_catalog.pg_class c' +
    '\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace';
  if (
    verbose &&
    serverAtLeast(serverVersion, PG_12) &&
    (showTables || showMatViews || showIndexes)
  ) {
    sql += '\n     LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam';
  }
  if (showIndexes) {
    sql +=
      '\n     LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid' +
      '\n     LEFT JOIN pg_catalog.pg_class c2 ON i.indrelid = c2.oid';
  }
  sql += '\nWHERE c.relkind IN (';
  const kinds: string[] = [];
  if (showTables) {
    kinds.push("'r'", "'p'");
    if (showSystem || pattern !== undefined) kinds.push("'t'");
  }
  if (showViews) kinds.push("'v'");
  if (showMatViews) kinds.push("'m'");
  if (showIndexes) kinds.push("'i'", "'I'");
  if (showSeq) kinds.push("'S'");
  if (showSystem || pattern !== undefined) kinds.push("'s'");
  if (showForeign) kinds.push("'f'");
  kinds.push("''");
  sql += kinds.join(',') + ')\n';
  if (!showSystem && pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n" +
      "      AND n.nspname !~ '^pg_toast'\n" +
      "      AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(true, 'n.nspname', 'c.relname');
  sql += orderBy('1,2');
  return { sql, params: params(opts), description: 'List of relations' };
};

/* ------------------------------------------------------------------ */
/* \dP — listPartitionedTables                                        */
/* ------------------------------------------------------------------ */
type ListPartitionedOpts = CommonOpts & { reltypes?: string };
export const listPartitionedTables = (
  opts: ListPartitionedOpts,
): DescribeQuery => {
  const { verbose, pattern, serverVersion } = opts;
  if (serverLess(serverVersion, PG_10)) {
    return {
      sql: '/* server < 10 does not support declarative partitioning */ SELECT 1 WHERE false;',
      params: [],
      description: 'List of partitioned relations',
    };
  }
  const rt = opts.reltypes ?? '';
  let showTables = rt.includes('t');
  let showIndexes = rt.includes('i');
  const showNested = rt.includes('n');
  if (!showTables && !showIndexes) showTables = showIndexes = true;
  const mixed = showTables && showIndexes;
  let sql =
    'SELECT n.nspname as "Schema",\n' +
    '  c.relname as "Name",\n' +
    '  pg_catalog.pg_get_userbyid(c.relowner) as "Owner"';
  if (mixed) {
    sql +=
      ',\n  CASE c.relkind' +
      " WHEN 'p' THEN 'partitioned table'" +
      " WHEN 'I' THEN 'partitioned index'" +
      ' END as "Type"';
  }
  if (showNested || pattern !== undefined) {
    sql += ',\n  inh.inhparent::pg_catalog.regclass as "Parent name"';
  }
  if (showIndexes) {
    sql += ',\n c2.oid::pg_catalog.regclass as "Table"';
  }
  if (verbose) {
    sql += ',\n  am.amname as "Access method"';
    if (showNested) {
      sql += ',\n  s.dps as "Leaf partition size"';
      sql += ',\n  s.tps as "Total size"';
    } else {
      sql += ',\n  s.tps as "Total size"';
    }
    sql +=
      ',\n  pg_catalog.obj_description(c.oid, \'pg_class\') as "Description"';
  }
  sql +=
    '\nFROM pg_catalog.pg_class c' +
    '\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace';
  if (showIndexes) {
    sql +=
      '\n     LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid' +
      '\n     LEFT JOIN pg_catalog.pg_class c2 ON i.indrelid = c2.oid';
  }
  if (showNested || pattern !== undefined) {
    sql +=
      '\n     LEFT JOIN pg_catalog.pg_inherits inh ON c.oid = inh.inhrelid';
  }
  if (verbose) {
    sql += '\n     LEFT JOIN pg_catalog.pg_am am ON c.relam = am.oid';
    if (serverLess(serverVersion, PG_12)) {
      sql +=
        ',\n     LATERAL (WITH RECURSIVE d AS (\n' +
        '              SELECT inhrelid AS oid, 1 AS level FROM pg_catalog.pg_inherits WHERE inhparent = c.oid\n' +
        '              UNION ALL\n' +
        '              SELECT inhrelid, level + 1 FROM pg_catalog.pg_inherits i JOIN d ON i.inhparent = d.oid)\n' +
        '            SELECT pg_catalog.pg_size_pretty(sum(pg_catalog.pg_table_size(d.oid))) AS tps,\n' +
        '                   pg_catalog.pg_size_pretty(sum(CASE WHEN d.level = 1 THEN pg_catalog.pg_table_size(d.oid) ELSE 0 END)) AS dps\n' +
        '            FROM d) s';
    } else {
      sql +=
        ',\n     LATERAL (SELECT pg_catalog.pg_size_pretty(sum(\n' +
        '              CASE WHEN ppt.isleaf AND ppt.level = 1\n' +
        '                   THEN pg_catalog.pg_table_size(ppt.relid) ELSE 0 END)) AS dps,\n' +
        '              pg_catalog.pg_size_pretty(sum(pg_catalog.pg_table_size(ppt.relid))) AS tps\n' +
        '              FROM pg_catalog.pg_partition_tree(c.oid) ppt) s';
    }
  }
  sql += '\nWHERE c.relkind IN (';
  const kinds: string[] = [];
  if (showTables) kinds.push("'p'");
  if (showIndexes) kinds.push("'I'");
  kinds.push("''");
  sql += kinds.join(',') + ')\n';
  if (!showNested && pattern === undefined) {
    sql += ' AND NOT c.relispartition\n';
  }
  if (pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n" +
      "      AND n.nspname !~ '^pg_toast'\n" +
      "      AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(true, 'n.nspname', 'c.relname');
  sql += `ORDER BY "Schema", ${mixed ? '"Type" DESC, ' : ''}${
    showNested || pattern !== undefined ? '"Parent name" NULLS FIRST, ' : ''
  }"Name";`;
  return {
    sql,
    params: params(opts),
    description: 'List of partitioned relations',
  };
};

/* ------------------------------------------------------------------ */
/* \dL — listLanguages                                                */
/* ------------------------------------------------------------------ */
export const listLanguages = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern } = opts;
  let sql =
    'SELECT l.lanname AS "Name",\n' +
    '       pg_catalog.pg_get_userbyid(l.lanowner) as "Owner",\n' +
    '       l.lanpltrusted AS "Trusted"';
  if (verbose) {
    sql +=
      ',\n       NOT l.lanispl AS "Internal language",\n' +
      '       l.lanplcallfoid::pg_catalog.regprocedure AS "Call handler",\n' +
      '       l.lanvalidator::pg_catalog.regprocedure AS "Validator",\n       ' +
      'l.laninline::pg_catalog.regprocedure AS "Inline handler",\n       ' +
      aclColumn('l.lanacl');
  }
  sql +=
    ',\n       d.description AS "Description"\n' +
    'FROM pg_catalog.pg_language l\n' +
    'LEFT JOIN pg_catalog.pg_description d\n' +
    '  ON d.classoid = l.tableoid AND d.objoid = l.oid AND d.objsubid = 0\n';
  let hasWhere = false;
  if (pattern !== undefined) {
    sql += patternStub(hasWhere, undefined, 'l.lanname');
    hasWhere = true;
  }
  if (!showSystem && pattern === undefined) {
    sql += 'WHERE l.lanplcallfoid != 0\n';
    hasWhere = true;
  }
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of languages' };
};

/* ------------------------------------------------------------------ */
/* \dD — listDomains                                                  */
/* ------------------------------------------------------------------ */
export const listDomains = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern } = opts;
  let sql =
    'SELECT n.nspname as "Schema",\n' +
    '       t.typname as "Name",\n' +
    '       pg_catalog.format_type(t.typbasetype, t.typtypmod) as "Type",\n' +
    '       (SELECT c.collname FROM pg_catalog.pg_collation c, pg_catalog.pg_type bt\n' +
    '        WHERE c.oid = t.typcollation AND bt.oid = t.typbasetype AND t.typcollation <> bt.typcollation) as "Collation",\n' +
    '       CASE WHEN t.typnotnull THEN \'not null\' END as "Nullable",\n' +
    '       t.typdefault as "Default",\n' +
    "       pg_catalog.array_to_string(ARRAY(\n         SELECT pg_catalog.pg_get_constraintdef(r.oid, true) FROM pg_catalog.pg_constraint r WHERE t.oid = r.contypid AND r.contype = 'c' ORDER BY r.conname\n       ), ' ') as \"Check\"";
  if (verbose) {
    sql += ',\n  ' + aclColumn('t.typacl');
    sql += ',\n       d.description as "Description"';
  }
  sql +=
    '\nFROM pg_catalog.pg_type t\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace\n';
  if (verbose) {
    sql +=
      '     LEFT JOIN pg_catalog.pg_description d ON d.classoid = t.tableoid AND d.objoid = t.oid AND d.objsubid = 0\n';
  }
  sql += "WHERE t.typtype = 'd'\n";
  if (!showSystem && pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n      AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(true, 'n.nspname', 't.typname');
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'List of domains' };
};

/* ------------------------------------------------------------------ */
/* \dc — listConversions                                              */
/* ------------------------------------------------------------------ */
export const listConversions = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern } = opts;
  let sql =
    'SELECT n.nspname AS "Schema",\n' +
    '       c.conname AS "Name",\n' +
    '       pg_catalog.pg_encoding_to_char(c.conforencoding) AS "Source",\n' +
    '       pg_catalog.pg_encoding_to_char(c.contoencoding) AS "Destination",\n' +
    "       CASE WHEN c.condefault THEN 'yes' ELSE 'no' END AS \"Default?\"";
  if (verbose) sql += ',\n       d.description AS "Description"';
  sql +=
    '\nFROM pg_catalog.pg_conversion c\n' +
    '     JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace\n';
  if (verbose) {
    sql +=
      'LEFT JOIN pg_catalog.pg_description d ON d.classoid = c.tableoid AND d.objoid = c.oid AND d.objsubid = 0\n';
  }
  sql += 'WHERE true\n';
  if (!showSystem && pattern === undefined) {
    sql +=
      "  AND n.nspname <> 'pg_catalog'\n  AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(true, 'n.nspname', 'c.conname');
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'List of conversions' };
};

/* ------------------------------------------------------------------ */
/* \dconfig — describeConfigurationParameters                         */
/* ------------------------------------------------------------------ */
export const describeConfigurationParameters = (
  opts: CommonOpts,
): DescribeQuery => {
  const { verbose, pattern, serverVersion } = opts;
  let sql =
    'SELECT s.name AS "Parameter", pg_catalog.current_setting(s.name) AS "Value"';
  if (verbose) {
    sql += ', s.vartype AS "Type", s.context AS "Context", ';
    if (serverAtLeast(serverVersion, PG_15)) {
      sql += aclColumn('p.paracl');
    } else {
      sql += 'NULL AS "Access privileges"';
    }
  }
  sql += '\nFROM pg_catalog.pg_settings s\n';
  if (verbose && serverAtLeast(serverVersion, PG_15)) {
    sql +=
      '  LEFT JOIN pg_catalog.pg_parameter_acl p ON pg_catalog.lower(s.name) = p.parname\n';
  }
  if (pattern !== undefined) {
    sql += patternStub(false, undefined, 'pg_catalog.lower(s.name)');
  } else {
    sql +=
      "WHERE s.source <> 'default' AND s.setting IS DISTINCT FROM s.boot_val\n";
  }
  sql += orderBy('1');
  return {
    sql,
    params: params(opts),
    description:
      pattern !== undefined
        ? 'List of configuration parameters'
        : 'List of non-default configuration parameters',
  };
};

/* ------------------------------------------------------------------ */
/* \dy — listEventTriggers                                            */
/* ------------------------------------------------------------------ */
export const listEventTriggers = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT evtname as "Name", evtevent as "Event", pg_catalog.pg_get_userbyid(e.evtowner) as "Owner",\n' +
    " case evtenabled when 'O' then 'enabled' when 'R' then 'replica' when 'A' then 'always' when 'D' then 'disabled' end as \"Enabled\",\n" +
    ' e.evtfoid::pg_catalog.regproc as "Function", ' +
    'pg_catalog.array_to_string(array(select x from pg_catalog.unnest(evttags) as t(x)), \', \') as "Tags"';
  if (verbose) {
    sql +=
      ',\npg_catalog.obj_description(e.oid, \'pg_event_trigger\') as "Description"';
  }
  sql += '\nFROM pg_catalog.pg_event_trigger e\n';
  sql += patternStub(false, undefined, 'evtname');
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of event triggers' };
};

/* ------------------------------------------------------------------ */
/* \dX — listExtendedStats                                            */
/* ------------------------------------------------------------------ */
export const listExtendedStats = (opts: CommonOpts): DescribeQuery => {
  const { verbose, serverVersion } = opts;
  if (serverLess(serverVersion, PG_10)) {
    return {
      sql: '/* server < 10 does not support extended statistics */ SELECT 1 WHERE false;',
      params: [],
      description: 'List of extended statistics',
    };
  }
  let sql =
    'SELECT\n' +
    'es.stxnamespace::pg_catalog.regnamespace::pg_catalog.text AS "Schema",\n' +
    'es.stxname AS "Name",\n';
  if (serverAtLeast(serverVersion, PG_14)) {
    sql +=
      'pg_catalog.format(\'%s FROM %s\', pg_catalog.pg_get_statisticsobjdef_columns(es.oid), es.stxrelid::pg_catalog.regclass) AS "Definition"';
  } else {
    sql +=
      "pg_catalog.format('%s FROM %s',\n" +
      "  (SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname),', ')\n" +
      '   FROM pg_catalog.unnest(es.stxkeys) s(attnum)\n' +
      '   JOIN pg_catalog.pg_attribute a\n' +
      '   ON (es.stxrelid = a.attrelid AND a.attnum = s.attnum AND NOT a.attisdropped)),\n' +
      'es.stxrelid::pg_catalog.regclass) AS "Definition"';
  }
  sql +=
    ",\nCASE WHEN 'd' = any(es.stxkind) THEN 'defined' END AS \"Ndistinct\",\n" +
    "CASE WHEN 'f' = any(es.stxkind) THEN 'defined' END AS \"Dependencies\"";
  if (serverAtLeast(serverVersion, PG_12)) {
    sql += ",\nCASE WHEN 'm' = any(es.stxkind) THEN 'defined' END AS \"MCV\"";
  }
  if (verbose) {
    sql +=
      ', \npg_catalog.obj_description(oid, \'pg_statistic_ext\') AS "Description"';
  }
  sql += '\nFROM pg_catalog.pg_statistic_ext es\n';
  sql += patternStub(
    false,
    'es.stxnamespace::pg_catalog.regnamespace::pg_catalog.text',
    'es.stxname',
  );
  sql += orderBy('1, 2');
  return {
    sql,
    params: params(opts),
    description: 'List of extended statistics',
  };
};

/* ------------------------------------------------------------------ */
/* \dC — listCasts                                                    */
/* ------------------------------------------------------------------ */
export const listCasts = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT pg_catalog.format_type(castsource, NULL) AS "Source type",\n' +
    '       pg_catalog.format_type(casttarget, NULL) AS "Target type",\n' +
    "       CASE WHEN c.castmethod = 'b' THEN '(binary coercible)'\n" +
    "            WHEN c.castmethod = 'i' THEN '(with inout)'\n" +
    '            ELSE p.proname\n' +
    '       END AS "Function",\n' +
    "       CASE WHEN c.castcontext = 'e' THEN 'no'\n" +
    "            WHEN c.castcontext = 'a' THEN 'in assignment'\n" +
    "            ELSE 'yes'\n" +
    '       END AS "Implicit?"';
  if (verbose) {
    sql +=
      ",\n       CASE WHEN p.proleakproof THEN 'yes' ELSE 'no' END AS \"Leakproof?\",\n" +
      '       d.description AS "Description"';
  }
  sql +=
    '\nFROM pg_catalog.pg_cast c LEFT JOIN pg_catalog.pg_proc p\n' +
    '     ON c.castfunc = p.oid\n' +
    '     LEFT JOIN pg_catalog.pg_type ts ON c.castsource = ts.oid\n' +
    '     LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid = ts.typnamespace\n' +
    '     LEFT JOIN pg_catalog.pg_type tt ON c.casttarget = tt.oid\n' +
    '     LEFT JOIN pg_catalog.pg_namespace nt ON nt.oid = tt.typnamespace\n';
  if (verbose) {
    sql +=
      '     LEFT JOIN pg_catalog.pg_description d ON d.classoid = c.tableoid AND d.objoid = c.oid AND d.objsubid = 0\n';
  }
  sql += 'WHERE ( (true';
  sql += patternStub(true, 'ns.nspname', 'ts.typname');
  sql += ') OR (true';
  sql += patternStub(true, 'nt.nspname', 'tt.typname');
  sql += ') )\n';
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'List of casts' };
};

/* ------------------------------------------------------------------ */
/* \dO — listCollations                                               */
/* ------------------------------------------------------------------ */
export const listCollations = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern, serverVersion } = opts;
  let sql = 'SELECT\n  n.nspname AS "Schema",\n  c.collname AS "Name",\n';
  if (serverAtLeast(serverVersion, PG_10)) {
    sql +=
      '  CASE c.collprovider' +
      " WHEN 'd' THEN 'default'" +
      " WHEN 'b' THEN 'builtin'" +
      " WHEN 'c' THEN 'libc'" +
      " WHEN 'i' THEN 'icu'" +
      ' END AS "Provider",\n';
  } else {
    sql += '  \'libc\' AS "Provider",\n';
  }
  sql += '  c.collcollate AS "Collate",\n  c.collctype AS "Ctype",\n';
  if (serverAtLeast(serverVersion, PG_17)) {
    sql += '  c.colllocale AS "Locale",\n';
  } else if (serverAtLeast(serverVersion, PG_15)) {
    sql += '  c.colliculocale AS "Locale",\n';
  } else {
    sql += '  c.collcollate AS "Locale",\n';
  }
  if (serverAtLeast(serverVersion, PG_16)) {
    sql += '  c.collicurules AS "ICU Rules",\n';
  } else {
    sql += '  NULL AS "ICU Rules",\n';
  }
  if (serverAtLeast(serverVersion, PG_12)) {
    sql +=
      "  CASE WHEN c.collisdeterministic THEN 'yes' ELSE 'no' END AS \"Deterministic?\"";
  } else {
    sql += '  \'yes\' AS "Deterministic?"';
  }
  if (verbose) {
    sql +=
      ',\n  pg_catalog.obj_description(c.oid, \'pg_collation\') AS "Description"';
  }
  sql +=
    '\nFROM pg_catalog.pg_collation c, pg_catalog.pg_namespace n\n' +
    'WHERE n.oid = c.collnamespace\n';
  if (!showSystem && pattern === undefined) {
    sql +=
      "      AND n.nspname <> 'pg_catalog'\n      AND n.nspname <> 'information_schema'\n";
  }
  sql +=
    '      AND c.collencoding IN (-1, pg_catalog.pg_char_to_encoding(pg_catalog.getdatabaseencoding()))\n';
  sql += patternStub(true, 'n.nspname', 'c.collname');
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'List of collations' };
};

/* ------------------------------------------------------------------ */
/* \dn — listSchemas                                                  */
/* ------------------------------------------------------------------ */
export const listSchemas = (opts: CommonOpts): DescribeQuery => {
  const { verbose, showSystem, pattern } = opts;
  let sql =
    'SELECT n.nspname AS "Name",\n' +
    '  pg_catalog.pg_get_userbyid(n.nspowner) AS "Owner"';
  if (verbose) {
    sql += ',\n  ' + aclColumn('n.nspacl');
    sql +=
      ',\n  pg_catalog.obj_description(n.oid, \'pg_namespace\') AS "Description"';
  }
  sql += '\nFROM pg_catalog.pg_namespace n\n';
  if (!showSystem && pattern === undefined) {
    sql += "WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'\n";
  }
  sql += patternStub(
    !showSystem && pattern === undefined,
    undefined,
    'n.nspname',
  );
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of schemas' };
};

/* ------------------------------------------------------------------ */
/* \dFp — listTSParsers                                               */
/* ------------------------------------------------------------------ */
export const listTSParsers = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  if (verbose) {
    // Verbose form: fetch (oid, schema, name) so the renderer can issue
    // per-parser detail queries (see describeOneTSParser below). WP-20 will
    // wire the iteration.
    let sql =
      'SELECT p.oid,\n  n.nspname,\n  p.prsname\n' +
      'FROM pg_catalog.pg_ts_parser p\n' +
      'LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.prsnamespace\n';
    sql += patternStub(false, 'n.nspname', 'p.prsname');
    sql += orderBy('1, 2');
    return {
      sql,
      params: params(opts),
      description: 'List of text search parsers (verbose)',
    };
  }
  let sql =
    'SELECT\n  n.nspname as "Schema",\n  p.prsname as "Name",\n' +
    '  pg_catalog.obj_description(p.oid, \'pg_ts_parser\') as "Description"\n' +
    'FROM pg_catalog.pg_ts_parser p\n' +
    'LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.prsnamespace\n';
  sql += patternStub(false, 'n.nspname', 'p.prsname');
  sql += orderBy('1, 2');
  return {
    sql,
    params: params(opts),
    description: 'List of text search parsers',
  };
};

/**
 * Per-parser detail (one row per phase). Caller binds the parser oid.
 * Two queries upstream; we emit both as a UNION via a single string.
 */
export const describeOneTSParser = (opts: { oid: string }): DescribeQuery => {
  const { oid } = opts;
  const sql =
    `SELECT 'Start parse' AS "Method",\n` +
    `   p.prsstart::pg_catalog.regproc AS "Function",\n` +
    `   pg_catalog.obj_description(p.prsstart, 'pg_proc') as "Description"\n` +
    ` FROM pg_catalog.pg_ts_parser p WHERE p.oid = '${oid}'\n` +
    `UNION ALL\n` +
    `SELECT 'Get next token', p.prstoken::pg_catalog.regproc, pg_catalog.obj_description(p.prstoken, 'pg_proc')\n` +
    ` FROM pg_catalog.pg_ts_parser p WHERE p.oid = '${oid}'\n` +
    `UNION ALL\n` +
    `SELECT 'End parse', p.prsend::pg_catalog.regproc, pg_catalog.obj_description(p.prsend, 'pg_proc')\n` +
    ` FROM pg_catalog.pg_ts_parser p WHERE p.oid = '${oid}'\n` +
    `UNION ALL\n` +
    `SELECT 'Get headline', p.prsheadline::pg_catalog.regproc, pg_catalog.obj_description(p.prsheadline, 'pg_proc')\n` +
    ` FROM pg_catalog.pg_ts_parser p WHERE p.oid = '${oid}'\n` +
    `UNION ALL\n` +
    `SELECT 'Get token types', p.prslextype::pg_catalog.regproc, pg_catalog.obj_description(p.prslextype, 'pg_proc')\n` +
    ` FROM pg_catalog.pg_ts_parser p WHERE p.oid = '${oid}';`;
  return { sql, params: [], description: 'Text search parser details' };
};

/* ------------------------------------------------------------------ */
/* \dFd — listTSDictionaries                                          */
/* ------------------------------------------------------------------ */
export const listTSDictionaries = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql = 'SELECT\n  n.nspname as "Schema",\n  d.dictname as "Name",\n';
  if (verbose) {
    sql +=
      "  ( SELECT COALESCE(nt.nspname, '(null)')::pg_catalog.text || '.' || t.tmplname FROM\n" +
      '    pg_catalog.pg_ts_template t\n' +
      '    LEFT JOIN pg_catalog.pg_namespace nt ON nt.oid = t.tmplnamespace\n' +
      '    WHERE d.dicttemplate = t.oid ) AS "Template",\n' +
      '  d.dictinitoption as "Init options",\n';
  }
  sql +=
    '  pg_catalog.obj_description(d.oid, \'pg_ts_dict\') as "Description"\n' +
    'FROM pg_catalog.pg_ts_dict d\n' +
    'LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.dictnamespace\n';
  sql += patternStub(false, 'n.nspname', 'd.dictname');
  sql += orderBy('1, 2');
  return {
    sql,
    params: params(opts),
    description: 'List of text search dictionaries',
  };
};

/* ------------------------------------------------------------------ */
/* \dFt — listTSTemplates                                             */
/* ------------------------------------------------------------------ */
export const listTSTemplates = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql: string;
  if (verbose) {
    sql =
      'SELECT\n  n.nspname AS "Schema",\n  t.tmplname AS "Name",\n' +
      '  t.tmplinit::pg_catalog.regproc AS "Init",\n' +
      '  t.tmpllexize::pg_catalog.regproc AS "Lexize",\n' +
      '  pg_catalog.obj_description(t.oid, \'pg_ts_template\') AS "Description"\n';
  } else {
    sql =
      'SELECT\n  n.nspname AS "Schema",\n  t.tmplname AS "Name",\n' +
      '  pg_catalog.obj_description(t.oid, \'pg_ts_template\') AS "Description"\n';
  }
  sql +=
    'FROM pg_catalog.pg_ts_template t\n' +
    'LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.tmplnamespace\n';
  sql += patternStub(false, 'n.nspname', 't.tmplname');
  sql += orderBy('1, 2');
  return {
    sql,
    params: params(opts),
    description: 'List of text search templates',
  };
};

/* ------------------------------------------------------------------ */
/* \dF — listTSConfigs                                                */
/* ------------------------------------------------------------------ */
export const listTSConfigs = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  if (verbose) {
    let sql =
      'SELECT c.oid, c.cfgname, n.nspname, p.prsname, np.nspname as pnspname\n' +
      'FROM pg_catalog.pg_ts_config c\n' +
      '   LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace,\n' +
      ' pg_catalog.pg_ts_parser p\n' +
      '   LEFT JOIN pg_catalog.pg_namespace np ON np.oid = p.prsnamespace\n' +
      'WHERE p.oid = c.cfgparser\n';
    sql += patternStub(true, 'n.nspname', 'c.cfgname');
    sql += orderBy('3, 2');
    return {
      sql,
      params: params(opts),
      description: 'List of text search configurations (verbose)',
    };
  }
  let sql =
    'SELECT\n   n.nspname as "Schema",\n   c.cfgname as "Name",\n' +
    '   pg_catalog.obj_description(c.oid, \'pg_ts_config\') as "Description"\n' +
    'FROM pg_catalog.pg_ts_config c\n' +
    'LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace\n';
  sql += patternStub(false, 'n.nspname', 'c.cfgname');
  sql += orderBy('1, 2');
  return {
    sql,
    params: params(opts),
    description: 'List of text search configurations',
  };
};

/* ------------------------------------------------------------------ */
/* \dew — listForeignDataWrappers                                     */
/* ------------------------------------------------------------------ */
export const listForeignDataWrappers = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT fdw.fdwname AS "Name",\n' +
    '  pg_catalog.pg_get_userbyid(fdw.fdwowner) AS "Owner",\n' +
    '  fdw.fdwhandler::pg_catalog.regproc AS "Handler",\n' +
    '  fdw.fdwvalidator::pg_catalog.regproc AS "Validator"';
  if (verbose) {
    sql += ',\n  ' + aclColumn('fdwacl');
    sql +=
      ",\n CASE WHEN fdwoptions IS NULL THEN '' ELSE\n" +
      "  '(' || pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.quote_ident(option_name) || ' ' || pg_catalog.quote_literal(option_value) FROM pg_catalog.pg_options_to_table(fdwoptions)), ', ') || ')'\n" +
      '  END AS "FDW options",\n' +
      '  d.description AS "Description" ';
  }
  sql += '\nFROM pg_catalog.pg_foreign_data_wrapper fdw\n';
  if (verbose) {
    sql +=
      'LEFT JOIN pg_catalog.pg_description d ON d.classoid = fdw.tableoid AND d.objoid = fdw.oid AND d.objsubid = 0\n';
  }
  sql += patternStub(false, undefined, 'fdwname');
  sql += orderBy('1');
  return {
    sql,
    params: params(opts),
    description: 'List of foreign-data wrappers',
  };
};

/* ------------------------------------------------------------------ */
/* \des — listForeignServers                                          */
/* ------------------------------------------------------------------ */
export const listForeignServers = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT s.srvname AS "Name",\n' +
    '  pg_catalog.pg_get_userbyid(s.srvowner) AS "Owner",\n' +
    '  f.fdwname AS "Foreign-data wrapper"';
  if (verbose) {
    sql += ',\n  ' + aclColumn('s.srvacl');
    sql +=
      ',\n  s.srvtype AS "Type",\n' +
      '  s.srvversion AS "Version",\n' +
      "  CASE WHEN srvoptions IS NULL THEN '' ELSE\n" +
      "  '(' || pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.quote_ident(option_name) || ' ' || pg_catalog.quote_literal(option_value) FROM pg_catalog.pg_options_to_table(srvoptions)), ', ') || ')'\n" +
      '  END AS "FDW options",\n' +
      '  d.description AS "Description"';
  }
  sql +=
    '\nFROM pg_catalog.pg_foreign_server s\n' +
    '     JOIN pg_catalog.pg_foreign_data_wrapper f ON f.oid=s.srvfdw\n';
  if (verbose) {
    sql +=
      'LEFT JOIN pg_catalog.pg_description d ON d.classoid = s.tableoid AND d.objoid = s.oid AND d.objsubid = 0\n';
  }
  sql += patternStub(false, undefined, 's.srvname');
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of foreign servers' };
};

/* ------------------------------------------------------------------ */
/* \deu — listUserMappings                                            */
/* ------------------------------------------------------------------ */
export const listUserMappings = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql = 'SELECT um.srvname AS "Server",\n  um.usename AS "User name"';
  if (verbose) {
    sql +=
      ",\n CASE WHEN umoptions IS NULL THEN '' ELSE\n" +
      "  '(' || pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.quote_ident(option_name) || ' ' || pg_catalog.quote_literal(option_value) FROM pg_catalog.pg_options_to_table(umoptions)), ', ') || ')'\n" +
      '  END AS "FDW options"';
  }
  sql += '\nFROM pg_catalog.pg_user_mappings um\n';
  sql += patternStub(false, undefined, 'um.srvname');
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'List of user mappings' };
};

/* ------------------------------------------------------------------ */
/* \det — listForeignTables                                           */
/* ------------------------------------------------------------------ */
export const listForeignTables = (opts: CommonOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT n.nspname AS "Schema",\n  c.relname AS "Table",\n  s.srvname AS "Server"';
  if (verbose) {
    sql +=
      ",\n CASE WHEN ftoptions IS NULL THEN '' ELSE\n" +
      "  '(' || pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.quote_ident(option_name) || ' ' || pg_catalog.quote_literal(option_value) FROM pg_catalog.pg_options_to_table(ftoptions)), ', ') || ')'\n" +
      '  END AS "FDW options",\n' +
      '  d.description AS "Description"';
  }
  sql +=
    '\nFROM pg_catalog.pg_foreign_table ft\n' +
    '  INNER JOIN pg_catalog.pg_class c ON c.oid = ft.ftrelid\n' +
    '  INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n' +
    '  INNER JOIN pg_catalog.pg_foreign_server s ON s.oid = ft.ftserver\n';
  if (verbose) {
    sql +=
      '   LEFT JOIN pg_catalog.pg_description d ON d.classoid = c.tableoid AND d.objoid = c.oid AND d.objsubid = 0\n';
  }
  sql += patternStub(false, 'n.nspname', 'c.relname');
  sql += orderBy('1, 2');
  return { sql, params: params(opts), description: 'List of foreign tables' };
};

/* ------------------------------------------------------------------ */
/* \dx — listExtensions  /  \dx+ — listExtensionContents              */
/* ------------------------------------------------------------------ */
export const listExtensions = (opts: CommonOpts): DescribeQuery => {
  let sql =
    'SELECT e.extname AS "Name", e.extversion AS "Version", ae.default_version AS "Default version",' +
    'n.nspname AS "Schema", d.description AS "Description"\n' +
    'FROM pg_catalog.pg_extension e ' +
    'LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace ' +
    "LEFT JOIN pg_catalog.pg_description d ON d.objoid = e.oid AND d.classoid = 'pg_catalog.pg_extension'::pg_catalog.regclass " +
    'LEFT JOIN pg_catalog.pg_available_extensions() ae(name, default_version, comment) ON ae.name = e.extname\n';
  sql += patternStub(false, undefined, 'e.extname');
  sql += orderBy('1');
  return {
    sql,
    params: params(opts),
    description: 'List of installed extensions',
  };
};

export const listExtensionContents = (opts: CommonOpts): DescribeQuery => {
  let sql = 'SELECT e.extname, e.oid\nFROM pg_catalog.pg_extension e\n';
  sql += patternStub(false, undefined, 'e.extname');
  sql += orderBy('1');
  return {
    sql,
    params: params(opts),
    description: 'Get matching extensions to list contents for',
  };
};

/**
 * Per-extension contents (`\dx+ foo`). Caller binds the extension oid.
 */
export const listOneExtensionContents = (opts: {
  oid: string;
}): DescribeQuery => {
  const sql =
    'SELECT pg_catalog.pg_describe_object(classid, objid, 0) AS "Object description"\n' +
    'FROM pg_catalog.pg_depend\n' +
    `WHERE refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND refobjid = '${opts.oid}' AND deptype = 'e'\n` +
    'ORDER BY 1;';
  return { sql, params: [], description: 'Objects in extension' };
};

/* ------------------------------------------------------------------ */
/* \dRp — listPublications  /  describePublications (\dRp+)           */
/* ------------------------------------------------------------------ */
export const listPublications = (opts: CommonOpts): DescribeQuery => {
  const { serverVersion } = opts;
  if (serverLess(serverVersion, PG_10)) {
    return {
      sql: '/* server < 10 does not support publications */ SELECT 1 WHERE false;',
      params: [],
      description: 'List of publications',
    };
  }
  let sql =
    'SELECT pubname AS "Name",\n' +
    '  pg_catalog.pg_get_userbyid(pubowner) AS "Owner",\n' +
    '  puballtables AS "All tables"';
  if (serverAtLeast(serverVersion, 19)) {
    sql += ',\n  puballsequences AS "All sequences"';
  }
  sql +=
    ',\n  pubinsert AS "Inserts",\n  pubupdate AS "Updates",\n  pubdelete AS "Deletes"';
  if (serverAtLeast(serverVersion, PG_11)) {
    sql += ',\n  pubtruncate AS "Truncates"';
  }
  if (serverAtLeast(serverVersion, 18)) {
    sql +=
      ',\n (CASE pubgencols ' +
      "WHEN 'n' THEN 'none' WHEN 's' THEN 'stored' END) AS \"Generated columns\"";
  }
  if (serverAtLeast(serverVersion, PG_13)) {
    sql += ',\n  pubviaroot AS "Via root"';
  }
  sql += '\nFROM pg_catalog.pg_publication\n';
  sql += patternStub(false, undefined, 'pubname');
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of publications' };
};

/**
 * Detail-lookup query for `\dRp+`. Output columns match the unmodified
 * `describePublications` upstream lookup (positional columns are then
 * fanned-out into per-publication detail blocks by WP-20).
 */
export const describePublications = (opts: CommonOpts): DescribeQuery => {
  const { serverVersion } = opts;
  if (serverLess(serverVersion, PG_10)) {
    return {
      sql: '/* server < 10 does not support publications */ SELECT 1 WHERE false;',
      params: [],
      description: 'Details of publications',
    };
  }
  const hasSeq = serverAtLeast(serverVersion, 19);
  const hasTrunc = serverAtLeast(serverVersion, PG_11);
  const hasGen = serverAtLeast(serverVersion, 18);
  const hasViaRoot = serverAtLeast(serverVersion, PG_13);
  let sql =
    'SELECT oid, pubname,\n  pg_catalog.pg_get_userbyid(pubowner) AS owner,\n  puballtables';
  sql += hasSeq ? ', puballsequences' : ', false AS puballsequences';
  sql += ', pubinsert, pubupdate, pubdelete';
  sql += hasTrunc ? ', pubtruncate' : ', false AS pubtruncate';
  if (hasGen) {
    sql +=
      ", (CASE pubgencols WHEN 'n' THEN 'none' WHEN 's' THEN 'stored' END) AS pubgencols";
  } else {
    sql += ", 'none' AS pubgencols";
  }
  sql += hasViaRoot ? ', pubviaroot' : ', false AS pubviaroot';
  sql += ", pg_catalog.obj_description(oid, 'pg_publication')";
  sql += '\nFROM pg_catalog.pg_publication\n';
  sql += patternStub(false, undefined, 'pubname');
  sql += orderBy('2');
  return { sql, params: params(opts), description: 'Details of publications' };
};

/* ------------------------------------------------------------------ */
/* \dRs — describeSubscriptions                                       */
/* ------------------------------------------------------------------ */
export const describeSubscriptions = (opts: CommonOpts): DescribeQuery => {
  const { verbose, serverVersion } = opts;
  if (serverLess(serverVersion, PG_10)) {
    return {
      sql: '/* server < 10 does not support subscriptions */ SELECT 1 WHERE false;',
      params: [],
      description: 'List of subscriptions',
    };
  }
  let sql =
    'SELECT subname AS "Name"\n' +
    ',  pg_catalog.pg_get_userbyid(subowner) AS "Owner"\n' +
    ',  subenabled AS "Enabled"\n' +
    ',  subpublications AS "Publication"\n';
  if (verbose) {
    if (serverAtLeast(serverVersion, PG_14)) {
      sql += ', subbinary AS "Binary"\n';
      if (serverAtLeast(serverVersion, PG_16)) {
        sql +=
          ', (CASE substream\n' +
          "    WHEN 'f' THEN 'off'\n" +
          "    WHEN 't' THEN 'on'\n" +
          "    WHEN 'p' THEN 'parallel'\n" +
          '   END) AS "Streaming"\n';
      } else {
        sql += ', substream AS "Streaming"\n';
      }
    }
    if (serverAtLeast(serverVersion, PG_15)) {
      sql +=
        ', subtwophasestate AS "Two-phase commit"\n' +
        ', subdisableonerr AS "Disable on error"\n';
    }
    if (serverAtLeast(serverVersion, PG_16)) {
      sql +=
        ', suborigin AS "Origin"\n' +
        ', subpasswordrequired AS "Password required"\n' +
        ', subrunasowner AS "Run as owner?"\n';
    }
    if (serverAtLeast(serverVersion, PG_17)) {
      sql += ', subfailover AS "Failover"\n';
    }
    sql +=
      ',  subsynccommit AS "Synchronous commit"\n' +
      ',  subconninfo AS "Conninfo"\n';
    if (serverAtLeast(serverVersion, PG_15)) {
      sql += ', subskiplsn AS "Skip LSN"\n';
    }
    sql +=
      ',  pg_catalog.obj_description(oid, \'pg_subscription\') AS "Description"\n';
  }
  sql +=
    'FROM pg_catalog.pg_subscription\n' +
    'WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())';
  sql += patternStub(true, undefined, 'subname');
  sql += orderBy('1');
  return { sql, params: params(opts), description: 'List of subscriptions' };
};

/* ------------------------------------------------------------------ */
/* \dAc — listOperatorClasses                                         */
/* ------------------------------------------------------------------ */
type OpClassFamilyOpts = Omit<CommonOpts, 'pattern'> & {
  amPattern?: string;
  typePattern?: string;
};
export const listOperatorClasses = (opts: OpClassFamilyOpts): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT\n  am.amname AS "AM",\n' +
    '  pg_catalog.format_type(c.opcintype, NULL) AS "Input type",\n' +
    '  CASE\n' +
    '    WHEN c.opckeytype <> 0 AND c.opckeytype <> c.opcintype\n' +
    '    THEN pg_catalog.format_type(c.opckeytype, NULL)\n' +
    '    ELSE NULL\n' +
    '  END AS "Storage type",\n' +
    '  CASE\n' +
    '    WHEN pg_catalog.pg_opclass_is_visible(c.oid)\n' +
    "    THEN pg_catalog.format('%I', c.opcname)\n" +
    "    ELSE pg_catalog.format('%I.%I', n.nspname, c.opcname)\n" +
    '  END AS "Operator class",\n' +
    "  (CASE WHEN c.opcdefault THEN 'yes' ELSE 'no' END) AS \"Default?\"";
  if (verbose) {
    sql +=
      ',\n  CASE\n' +
      '    WHEN pg_catalog.pg_opfamily_is_visible(of.oid)\n' +
      "    THEN pg_catalog.format('%I', of.opfname)\n" +
      "    ELSE pg_catalog.format('%I.%I', ofn.nspname, of.opfname)\n" +
      '  END AS "Operator family",\n' +
      ' pg_catalog.pg_get_userbyid(c.opcowner) AS "Owner"\n';
  }
  sql +=
    '\nFROM pg_catalog.pg_opclass c\n' +
    '  LEFT JOIN pg_catalog.pg_am am on am.oid = c.opcmethod\n' +
    '  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.opcnamespace\n' +
    '  LEFT JOIN pg_catalog.pg_type t ON t.oid = c.opcintype\n' +
    '  LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace\n';
  if (verbose) {
    sql +=
      '  LEFT JOIN pg_catalog.pg_opfamily of ON of.oid = c.opcfamily\n' +
      '  LEFT JOIN pg_catalog.pg_namespace ofn ON ofn.oid = of.opfnamespace\n';
  }
  let hasWhere = false;
  if (opts.amPattern !== undefined) {
    sql += patternStub(hasWhere, undefined, 'am.amname');
    hasWhere = true;
  }
  if (opts.typePattern !== undefined) {
    sql += patternStub(hasWhere, 'tn.nspname', 't.typname');
  }
  sql += orderBy('1, 2, 4');
  const ps: unknown[] = [];
  if (opts.amPattern !== undefined) ps.push(opts.amPattern);
  if (opts.typePattern !== undefined) ps.push(opts.typePattern);
  return { sql, params: ps, description: 'List of operator classes' };
};

/* ------------------------------------------------------------------ */
/* \dAf — listOperatorFamilies                                        */
/* ------------------------------------------------------------------ */
export const listOperatorFamilies = (
  opts: OpClassFamilyOpts,
): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT\n  am.amname AS "AM",\n' +
    '  CASE\n' +
    '    WHEN pg_catalog.pg_opfamily_is_visible(f.oid)\n' +
    "    THEN pg_catalog.format('%I', f.opfname)\n" +
    "    ELSE pg_catalog.format('%I.%I', n.nspname, f.opfname)\n" +
    '  END AS "Operator family",\n' +
    '  (SELECT\n' +
    "     pg_catalog.string_agg(pg_catalog.format_type(oc.opcintype, NULL), ', ')\n" +
    '   FROM pg_catalog.pg_opclass oc\n' +
    '   WHERE oc.opcfamily = f.oid) "Applicable types"';
  if (verbose) {
    sql += ',\n  pg_catalog.pg_get_userbyid(f.opfowner) AS "Owner"\n';
  }
  sql +=
    '\nFROM pg_catalog.pg_opfamily f\n' +
    '  LEFT JOIN pg_catalog.pg_am am on am.oid = f.opfmethod\n' +
    '  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = f.opfnamespace\n';
  let hasWhere = false;
  if (opts.amPattern !== undefined) {
    sql += patternStub(hasWhere, undefined, 'am.amname');
    hasWhere = true;
  }
  if (opts.typePattern !== undefined) {
    sql +=
      `  ${hasWhere ? 'AND' : 'WHERE'} EXISTS (\n` +
      '    SELECT 1 FROM pg_catalog.pg_type t\n' +
      '    JOIN pg_catalog.pg_opclass oc ON oc.opcintype = t.oid\n' +
      '    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace\n' +
      '    WHERE oc.opcfamily = f.oid\n' +
      patternStub(true, 'tn.nspname', 't.typname') +
      '  )\n';
  }
  sql += orderBy('1, 2');
  const ps: unknown[] = [];
  if (opts.amPattern !== undefined) ps.push(opts.amPattern);
  if (opts.typePattern !== undefined) ps.push(opts.typePattern);
  return { sql, params: ps, description: 'List of operator families' };
};

/* ------------------------------------------------------------------ */
/* \dAo — listOpFamilyOperators                                       */
/* ------------------------------------------------------------------ */
type OpFamilyMembersOpts = Omit<CommonOpts, 'pattern'> & {
  amPattern?: string;
  familyPattern?: string;
};
export const listOpFamilyOperators = (
  opts: OpFamilyMembersOpts,
): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT\n  am.amname AS "AM",\n' +
    '  CASE\n' +
    '    WHEN pg_catalog.pg_opfamily_is_visible(of.oid)\n' +
    "    THEN pg_catalog.format('%I', of.opfname)\n" +
    "    ELSE pg_catalog.format('%I.%I', nsf.nspname, of.opfname)\n" +
    '  END AS "Operator family",\n' +
    '  o.amopopr::pg_catalog.regoperator AS "Operator"\n,' +
    '  o.amopstrategy AS "Strategy",\n' +
    '  CASE o.amoppurpose\n' +
    "    WHEN 'o' THEN 'ordering'\n" +
    "    WHEN 's' THEN 'search'\n" +
    '  END AS "Purpose"\n';
  if (verbose) {
    sql +=
      ', ofs.opfname AS "Sort opfamily",\n' +
      "  CASE WHEN p.proleakproof THEN 'yes' ELSE 'no' END AS \"Leakproof?\"\n";
  }
  sql +=
    'FROM pg_catalog.pg_amop o\n' +
    '  LEFT JOIN pg_catalog.pg_opfamily of ON of.oid = o.amopfamily\n' +
    '  LEFT JOIN pg_catalog.pg_am am ON am.oid = of.opfmethod AND am.oid = o.amopmethod\n' +
    '  LEFT JOIN pg_catalog.pg_namespace nsf ON of.opfnamespace = nsf.oid\n';
  if (verbose) {
    sql +=
      '  LEFT JOIN pg_catalog.pg_opfamily ofs ON ofs.oid = o.amopsortfamily\n' +
      '  LEFT JOIN pg_catalog.pg_operator op ON op.oid = o.amopopr\n' +
      '  LEFT JOIN pg_catalog.pg_proc p ON p.oid = op.oprcode\n';
  }
  let hasWhere = false;
  if (opts.amPattern !== undefined) {
    sql += patternStub(hasWhere, undefined, 'am.amname');
    hasWhere = true;
  }
  if (opts.familyPattern !== undefined) {
    sql += patternStub(hasWhere, 'nsf.nspname', 'of.opfname');
  }
  sql +=
    'ORDER BY 1, 2,\n' +
    '  o.amoplefttype = o.amoprighttype DESC,\n' +
    '  pg_catalog.format_type(o.amoplefttype, NULL),\n' +
    '  pg_catalog.format_type(o.amoprighttype, NULL),\n' +
    '  o.amopstrategy;';
  const ps: unknown[] = [];
  if (opts.amPattern !== undefined) ps.push(opts.amPattern);
  if (opts.familyPattern !== undefined) ps.push(opts.familyPattern);
  return {
    sql,
    params: ps,
    description: 'List of operators of operator families',
  };
};

/* ------------------------------------------------------------------ */
/* \dAp — listOpFamilyFunctions                                       */
/* ------------------------------------------------------------------ */
export const listOpFamilyFunctions = (
  opts: OpFamilyMembersOpts,
): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT\n  am.amname AS "AM",\n' +
    '  CASE\n' +
    '    WHEN pg_catalog.pg_opfamily_is_visible(of.oid)\n' +
    "    THEN pg_catalog.format('%I', of.opfname)\n" +
    "    ELSE pg_catalog.format('%I.%I', ns.nspname, of.opfname)\n" +
    '  END AS "Operator family",\n' +
    '  pg_catalog.format_type(ap.amproclefttype, NULL) AS "Registered left type",\n' +
    '  pg_catalog.format_type(ap.amprocrighttype, NULL) AS "Registered right type",\n' +
    '  ap.amprocnum AS "Number"\n';
  sql += verbose
    ? ', ap.amproc::pg_catalog.regprocedure AS "Function"\n'
    : ', p.proname AS "Function"\n';
  sql +=
    'FROM pg_catalog.pg_amproc ap\n' +
    '  LEFT JOIN pg_catalog.pg_opfamily of ON of.oid = ap.amprocfamily\n' +
    '  LEFT JOIN pg_catalog.pg_am am ON am.oid = of.opfmethod\n' +
    '  LEFT JOIN pg_catalog.pg_namespace ns ON of.opfnamespace = ns.oid\n' +
    '  LEFT JOIN pg_catalog.pg_proc p ON ap.amproc = p.oid\n';
  let hasWhere = false;
  if (opts.amPattern !== undefined) {
    sql += patternStub(hasWhere, undefined, 'am.amname');
    hasWhere = true;
  }
  if (opts.familyPattern !== undefined) {
    sql += patternStub(hasWhere, 'ns.nspname', 'of.opfname');
  }
  sql +=
    'ORDER BY 1, 2,\n  ap.amproclefttype = ap.amprocrighttype DESC,\n  3, 4, 5;';
  const ps: unknown[] = [];
  if (opts.amPattern !== undefined) ps.push(opts.amPattern);
  if (opts.familyPattern !== undefined) ps.push(opts.familyPattern);
  return {
    sql,
    params: ps,
    description: 'List of support functions of operator families',
  };
};

/* ------------------------------------------------------------------ */
/* \dl / \lo_list — listLargeObjects                                  */
/* ------------------------------------------------------------------ */
export const listLargeObjects = (
  opts: Pick<CommonOpts, 'verbose' | 'serverVersion'>,
): DescribeQuery => {
  const { verbose } = opts;
  let sql =
    'SELECT oid as "ID",\n  pg_catalog.pg_get_userbyid(lomowner) as "Owner",\n  ';
  if (verbose) {
    sql += aclColumn('lomacl') + ',\n  ';
  }
  sql +=
    'pg_catalog.obj_description(oid, \'pg_largeobject\') as "Description"\n' +
    'FROM pg_catalog.pg_largeobject_metadata\n' +
    'ORDER BY oid';
  return { sql, params: [], description: 'Large objects' };
};

/* ------------------------------------------------------------------ */
/* \sf — show function definition                                     */
/* \sv — show view definition                                         */
/* These are command-level (in command.c) but the SQL is trivial and  */
/* belongs with the rest of the describe SQL.                         */
/* ------------------------------------------------------------------ */

/**
 * Look up function OID by name for `\sf` / `\sf+`. Caller renders
 * `pg_catalog.pg_get_functiondef(oid)` afterwards. The lookup itself
 * uses regprocedure casting via the placeholder; WP-20 will replace.
 */
export const showFunction = (opts: {
  name: string;
  serverVersion: ServerVersion;
}): DescribeQuery => {
  // We emit a select returning the function definition by name; upstream
  // psql resolves to oid then calls pg_get_functiondef(oid). Combine.
  const sql = `SELECT pg_catalog.pg_get_functiondef('${opts.name.replace(/'/g, "''")}'::pg_catalog.regprocedure) AS def;`;
  return { sql, params: [], description: 'Function definition' };
};

/**
 * Look up view definition for `\sv` / `\sv+`.
 */
export const showView = (opts: {
  name: string;
  serverVersion: ServerVersion;
}): DescribeQuery => {
  const sql = `SELECT pg_catalog.pg_get_viewdef('${opts.name.replace(/'/g, "''")}'::pg_catalog.regclass, true) AS def;`;
  return { sql, params: [], description: 'View definition' };
};
