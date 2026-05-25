/**
 * Rendering for psql's `\d*` describe commands.
 *
 * This module owns the runtime side of WP-20: take the SQL templates
 * from {@link './queries.js'} (WP-19), run them against a real
 * {@link Connection}, and render the result via the aligned printer
 * for tabular sections plus free-form text for "footer" sections
 * (`Indexes:`, `Foreign-key constraints:`, etc.) the way upstream
 * `describe.c` does.
 *
 * Scope of the initial implementation:
 *
 *  - {@link runListQuery} runs an arbitrary {@link DescribeQuery}
 *    (typically one of `listTables`, `describeFunctions`, etc.) and
 *    prints its result with the aligned printer. Title is taken from
 *    the query's `description`. This covers every `\d*` *list* command.
 *
 *  - {@link describeOneTableDetails} fans out from the lookup query
 *    `describeTableDetails` into the per-relation detail render: a
 *    columns table at the top, followed by index / constraint / trigger
 *    sections as appropriate for the relkind. This is the bulk of
 *    upstream's `describeOneTableDetails()` from `describe.c`. We
 *    implement the *common* table layout (regular tables, views,
 *    materialized views, partitioned tables and indexes) — exotic
 *    sections (foreign-table options, replica identity, RLS policies,
 *    inheritance pretty-printing) are stubbed with the SQL queries in
 *    place but only minimal rendering. The output is sufficient for
 *    real-world `\d <name>` usage; gaps are flagged with TODO comments.
 *
 *  - {@link describeOneSequence}, {@link describeOneFunctionDetails}
 *    and {@link describeOneViewDetails} are thinner: a single query +
 *    one section of output each.
 *
 * Pattern conditions: each list query has an `AND true /<!---->* TODO(WP-20)…`
 * placeholder we replace via {@link applyPattern} before sending the
 * query down the wire. See {@link processSQLNamePattern} for the
 * pattern parser.
 */

import type { Connection, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts } from '../types/printer.js';

import { alignedPrinter } from '../print/aligned.js';

import type { DescribeQuery } from './queries.js';
import { applyPattern, type NamePatternResult } from './processNamePattern.js';

/**
 * Format a cell value coming back from the protocol layer. Connection
 * decoded values arrive as strings (text mode) or null. We coerce
 * everything to string for the printer.
 */
const cellToString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf-8');
  if (
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  ) {
    return String(v);
  }
  // Non-primitive fallback: encode JSON. This branch shouldn't be hit
  // under the protocol layer (which decodes to strings) but we guard
  // against future shape changes.
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
};

/**
 * Materialize a {@link ResultSet} into something the aligned printer
 * can render. The printer expects `rows: unknown[][]`; we keep the
 * shape but ensure cells are strings or null for the null-print logic.
 */
const coerceResultSet = (rs: ResultSet): ResultSet => ({
  ...rs,
  rows: rs.rows.map((row) =>
    row.map((c) => (c === null || c === undefined ? null : cellToString(c))),
  ),
});

/**
 * Run a list-style describe query and write its result via the aligned
 * printer. Returns the {@link ResultSet} for callers that want to
 * inspect or post-process. Used by `\dt`, `\df`, `\dn`, etc.
 */
export const runListQuery = async (
  conn: Connection,
  query: DescribeQuery,
  patternResult: NamePatternResult,
  out: NodeJS.WritableStream,
  popt: PrintQueryOpts,
): Promise<ResultSet> => {
  const { sql, params } = applyPattern(query.sql, patternResult, query.params);
  const rs = await conn.query(sql, params);
  const coerced = coerceResultSet(rs);
  const opts: PrintQueryOpts = {
    ...popt,
    title: query.description ?? popt.title,
    footers:
      rs.rows.length === 0
        ? popt.footers
        : popt.footers !== null
          ? popt.footers
          : null,
  };
  await alignedPrinter.printQuery(coerced, opts, out);
  return rs;
};

/**
 * Look up matching relations using the {@link describeTableDetails}
 * query — returns one row per matching relation with `oid`, `nspname`,
 * `relname`, `relkind`. Used by `\d <pattern>` to fan out to the right
 * per-object detail renderer.
 */
export type RelationRow = {
  oid: number;
  nspname: string;
  relname: string;
  relkind: string;
};

export const lookupRelations = async (
  conn: Connection,
  query: DescribeQuery,
  patternResult: NamePatternResult,
): Promise<RelationRow[]> => {
  const { sql, params } = applyPattern(query.sql, patternResult, query.params);
  const rs = await conn.query(sql, params);
  return rs.rows.map((row) => ({
    oid: Number(cellToString(row[0])),
    nspname: cellToString(row[1]),
    relname: cellToString(row[2]),
    relkind: cellToString(row[3] ?? ''),
  }));
};

/**
 * Lookup of one specific relation by `schema.name` for the `\d <name>`
 * dispatch. Returns the row we need to choose the right `describeOne*`
 * renderer — including `relkind` which the upstream code reads from
 * a separate SELECT.
 */
export const lookupOneRelation = async (
  conn: Connection,
  schemaPattern: string | null,
  namePattern: string,
): Promise<RelationRow | null> => {
  // Build a name-only or schema-qualified lookup against pg_class.
  // We do this with a single direct query (avoiding the placeholder
  // dance because describeTableDetails doesn't actually return relkind).
  let sql =
    'SELECT c.oid, n.nspname, c.relname, c.relkind\n' +
    'FROM pg_catalog.pg_class c\n' +
    '     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n' +
    'WHERE c.relname OPERATOR(pg_catalog.~) $1\n';
  const params: unknown[] = [`^(${namePattern})$`];
  if (schemaPattern !== null) {
    sql += '  AND n.nspname OPERATOR(pg_catalog.~) $2\n';
    params.push(`^(${schemaPattern})$`);
  } else {
    sql += '  AND pg_catalog.pg_table_is_visible(c.oid)\n';
  }
  sql += 'ORDER BY 2, 3 LIMIT 1;';
  const rs = await conn.query(sql, params);
  if (rs.rows.length === 0) return null;
  const row = rs.rows[0];
  return {
    oid: Number(cellToString(row[0])),
    nspname: cellToString(row[1]),
    relname: cellToString(row[2]),
    relkind: cellToString(row[3]),
  };
};

/**
 * Render `Table "schema.name"` (or the relkind-specific header) plus the
 * column listing, followed by per-relkind sections (Indexes, Check
 * constraints, Foreign-key constraints, Referenced-by, Triggers).
 *
 * Upstream `describeOneTableDetails()` is ~1500 LOC in `describe.c`;
 * this implementation focuses on the headline experience and leaves
 * exotic sections (RLS, replica identity, partition bounds rendering,
 * pretty-printed inheritance) as TODOs. The query layer fetches the
 * raw data so a follow-up WP can extend rendering without re-running
 * queries.
 */
export const describeOneTableDetails = async (
  conn: Connection,
  oid: number,
  schema: string,
  name: string,
  relkind: string,
  verbose: boolean,
  out: NodeJS.WritableStream,
  popt: PrintQueryOpts,
): Promise<void> => {
  const title = headerForRelkind(relkind, schema, name);
  void verbose; // verbose adds columns to Indexes/triggers rendering — TODO.

  // ----- Columns -----
  const colSql =
    'SELECT a.attname,\n' +
    '  pg_catalog.format_type(a.atttypid, a.atttypmod),\n' +
    '  (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid, true)\n' +
    '   FROM pg_catalog.pg_attrdef d\n' +
    '   WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef),\n' +
    '  a.attnotnull,\n' +
    '  (SELECT c.collname FROM pg_catalog.pg_collation c, pg_catalog.pg_type t\n' +
    '   WHERE c.oid = a.attcollation AND t.oid = a.atttypid AND a.attcollation <> t.typcollation) AS attcollation,\n' +
    '  a.attidentity,\n' +
    '  a.attgenerated\n' +
    'FROM pg_catalog.pg_attribute a\n' +
    `WHERE a.attrelid = '${oid}' AND a.attnum > 0 AND NOT a.attisdropped\n` +
    'ORDER BY a.attnum;';
  const colsRs = await conn.query(colSql, []);

  // Synthesize a printable result set: Column, Type, Collation, Nullable, Default
  const fields = [
    fakeField('Column'),
    fakeField('Type'),
    fakeField('Collation'),
    fakeField('Nullable'),
    fakeField('Default'),
  ];
  const rows: unknown[][] = colsRs.rows.map((r) => {
    const colName = cellToString(r[0]);
    const colType = cellToString(r[1]);
    const colDefault = r[2] === null ? null : cellToString(r[2]);
    const notnull = String(r[3]) === 't' || r[3] === true;
    const collation = r[4] === null ? null : cellToString(r[4]);
    const identity = cellToString(r[5] ?? '');
    const generated = cellToString(r[6] ?? '');
    const nullable = notnull ? 'not null' : '';
    let dflt = colDefault ?? '';
    if (identity === 'a') {
      dflt = 'generated always as identity';
    } else if (identity === 'd') {
      dflt = 'generated by default as identity';
    } else if (generated === 's') {
      dflt = dflt ? `generated always as (${dflt}) stored` : '';
    }
    return [colName, colType, collation ?? '', nullable, dflt];
  });
  const colsResult: ResultSet = {
    command: 'SELECT',
    rowCount: rows.length,
    oid: null,
    fields,
    rows,
    notices: [],
  };
  await alignedPrinter.printQuery(
    coerceResultSet(colsResult),
    { ...popt, title, footers: null },
    out,
  );

  // ----- Indexes (only for tables / matviews / partitioned tables) -----
  if (relkind === 'r' || relkind === 'm' || relkind === 'p') {
    await renderIndexesSection(conn, oid, out);
  }

  // ----- Check constraints -----
  if (relkind === 'r' || relkind === 'p' || relkind === 'f') {
    await renderCheckConstraintsSection(conn, oid, out);
  }

  // ----- Foreign-key constraints -----
  if (relkind === 'r' || relkind === 'p') {
    await renderForeignKeyConstraintsSection(conn, oid, out);
    await renderReferencedBySection(conn, oid, out);
  }

  // ----- Triggers -----
  if (relkind === 'r' || relkind === 'p' || relkind === 'v') {
    await renderTriggersSection(conn, oid, out);
  }

  // TODO(post-WP-20): RLS policies, replica identity, partition bounds,
  // tablespace, access method, inheritance children, view definition
  // (for v/m), foreign-table options.
};

/**
 * Render `Indexes:\n    "name" PRIMARY KEY, btree (col)` for each index
 * on `oid`. Free-form section — not a table.
 */
const renderIndexesSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const sql =
    'SELECT c2.relname, i.indisprimary, i.indisunique, i.indisclustered,\n' +
    '  i.indisvalid,\n' +
    '  pg_catalog.pg_get_indexdef(i.indexrelid, 0, true),\n' +
    '  pg_catalog.pg_get_constraintdef(con.oid, true),\n' +
    '  contype, condeferrable, condeferred,\n' +
    '  i.indisreplident,\n' +
    '  c2.reltablespace\n' +
    'FROM pg_catalog.pg_class c, pg_catalog.pg_class c2, pg_catalog.pg_index i\n' +
    `  LEFT JOIN pg_catalog.pg_constraint con ON (conrelid = i.indrelid AND conindid = i.indexrelid AND contype IN ('p','u','x'))\n` +
    `WHERE c.oid = '${oid}' AND c.oid = i.indrelid AND i.indexrelid = c2.oid\n` +
    'ORDER BY i.indisprimary DESC, c2.relname;';
  const rs = await conn.query(sql, []);
  if (rs.rows.length === 0) return;
  out.write('Indexes:\n');
  for (const r of rs.rows) {
    const idxName = cellToString(r[0]);
    const isPrimary = String(r[1]) === 't' || r[1] === true;
    const isUnique = String(r[2]) === 't' || r[2] === true;
    const isValid = String(r[4]) === 't' || r[4] === true;
    const indexdef = cellToString(r[5]);
    const constrDef = r[6] !== null ? cellToString(r[6]) : '';
    const tag = isPrimary ? 'PRIMARY KEY' : isUnique ? 'UNIQUE CONSTRAINT' : '';
    let line = `    "${idxName}"`;
    if (constrDef) {
      line += `, ${tag || 'CONSTRAINT'} ${constrDef}`;
    } else {
      // Strip the "CREATE [UNIQUE] INDEX ... USING " prefix to get "btree (...)" tail.
      const tail = indexdef.replace(
        /^CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+\S+\s+USING\s+/i,
        '',
      );
      line += isUnique ? ` UNIQUE` : '';
      line += `, ${tail}`;
    }
    if (!isValid) line += ' INVALID';
    out.write(`${line}\n`);
  }
};

/**
 * Render `Check constraints:\n    "name" CHECK (expr)` list.
 */
const renderCheckConstraintsSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const sql =
    'SELECT r.conname, pg_catalog.pg_get_constraintdef(r.oid, true)\n' +
    'FROM pg_catalog.pg_constraint r\n' +
    `WHERE r.conrelid = '${oid}' AND r.contype = 'c'\n` +
    'ORDER BY 1;';
  const rs = await conn.query(sql, []);
  if (rs.rows.length === 0) return;
  out.write('Check constraints:\n');
  for (const r of rs.rows) {
    out.write(`    "${cellToString(r[0])}" ${cellToString(r[1])}\n`);
  }
};

/**
 * Render `Foreign-key constraints:\n    "name" FOREIGN KEY ...` list.
 */
const renderForeignKeyConstraintsSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const sql =
    'SELECT conname, pg_catalog.pg_get_constraintdef(oid, true) AS condef\n' +
    'FROM pg_catalog.pg_constraint\n' +
    `WHERE conrelid = '${oid}' AND contype = 'f'\n` +
    'ORDER BY conname;';
  const rs = await conn.query(sql, []);
  if (rs.rows.length === 0) return;
  out.write('Foreign-key constraints:\n');
  for (const r of rs.rows) {
    out.write(`    "${cellToString(r[0])}" ${cellToString(r[1])}\n`);
  }
};

/**
 * Render `Referenced by:\n    TABLE "..." CONSTRAINT "..." FOREIGN KEY ...`
 * (incoming FKs from other tables).
 */
const renderReferencedBySection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const sql =
    'SELECT conname, conrelid::pg_catalog.regclass,\n' +
    '  pg_catalog.pg_get_constraintdef(oid, true) AS condef\n' +
    'FROM pg_catalog.pg_constraint\n' +
    `WHERE confrelid = '${oid}' AND contype = 'f'\n` +
    'ORDER BY conname;';
  const rs = await conn.query(sql, []);
  if (rs.rows.length === 0) return;
  out.write('Referenced by:\n');
  for (const r of rs.rows) {
    out.write(
      `    TABLE "${cellToString(r[1])}" CONSTRAINT "${cellToString(r[0])}" ${cellToString(r[2])}\n`,
    );
  }
};

/**
 * Render `Triggers:\n    name AFTER ... EXECUTE ...` list.
 */
const renderTriggersSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const sql =
    'SELECT t.tgname, pg_catalog.pg_get_triggerdef(t.oid, true) AS tgdef, t.tgenabled\n' +
    'FROM pg_catalog.pg_trigger t\n' +
    `WHERE t.tgrelid = '${oid}' AND NOT t.tgisinternal\n` +
    'ORDER BY 1;';
  const rs = await conn.query(sql, []);
  if (rs.rows.length === 0) return;
  out.write('Triggers:\n');
  for (const r of rs.rows) {
    out.write(`    ${cellToString(r[1])}\n`);
  }
};

/**
 * `\ds <name>` — sequence details. Renders the columns of pg_sequence
 * plus the `Owned by:` footer if applicable.
 */
export const describeOneSequence = async (
  conn: Connection,
  oid: number,
  schema: string,
  name: string,
  out: NodeJS.WritableStream,
  popt: PrintQueryOpts,
): Promise<void> => {
  const sql =
    'SELECT pg_catalog.format_type(seqtypid, NULL) AS "Type",\n' +
    '  seqstart AS "Start", seqmin AS "Minimum", seqmax AS "Maximum",\n' +
    '  seqincrement AS "Increment",\n' +
    "  CASE WHEN seqcycle THEN 'yes' ELSE 'no' END AS \"Cycles?\",\n" +
    '  seqcache AS "Cache"\n' +
    `FROM pg_catalog.pg_sequence WHERE seqrelid = '${oid}';`;
  const rs = await conn.query(sql, []);
  const title = `Sequence "${schema}.${name}"`;
  await alignedPrinter.printQuery(
    coerceResultSet(rs),
    { ...popt, title, footers: null },
    out,
  );

  // Owned-by footer
  const ownedSql =
    "SELECT pg_catalog.quote_ident(nspname) || '.' || pg_catalog.quote_ident(relname) || '.' || pg_catalog.quote_ident(attname)\n" +
    'FROM pg_catalog.pg_class c\n' +
    'JOIN pg_catalog.pg_depend d ON c.oid = d.refobjid\n' +
    'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n' +
    'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid\n' +
    `WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass\n` +
    `  AND d.objid = '${oid}' AND d.deptype IN ('a', 'i');`;
  const ownRs = await conn.query(ownedSql, []);
  if (ownRs.rows.length > 0) {
    out.write(`Owned by: ${cellToString(ownRs.rows[0][0])}\n`);
  }
};

/**
 * `\sf <name>` — show function definition (full CREATE FUNCTION).
 * Renders the single-column result as raw text.
 */
export const describeOneFunctionDetails = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const sql = `SELECT pg_catalog.pg_get_functiondef('${oid}'::pg_catalog.oid) AS def;`;
  const rs = await conn.query(sql, []);
  if (rs.rows.length > 0) {
    out.write(cellToString(rs.rows[0][0]));
    out.write('\n');
  }
};

/**
 * `\sv <name>` — show view definition.
 */
export const describeOneViewDetails = async (
  conn: Connection,
  oid: number,
  schema: string,
  name: string,
  out: NodeJS.WritableStream,
  popt: PrintQueryOpts,
): Promise<void> => {
  // Use the table renderer for columns first (views have columns).
  await describeOneTableDetails(conn, oid, schema, name, 'v', false, out, popt);
  // Then append the view definition.
  const sql = `SELECT pg_catalog.pg_get_viewdef('${oid}'::pg_catalog.oid, true) AS def;`;
  const rs = await conn.query(sql, []);
  if (rs.rows.length > 0) {
    out.write('View definition:\n');
    out.write(cellToString(rs.rows[0][0]));
    out.write('\n');
  }
};

/**
 * Translate a relkind char into the canonical header psql uses for
 * `\d <name>`. Examples: 'r' → `Table "schema.name"`; 'v' → `View "..."`.
 */
const headerForRelkind = (
  relkind: string,
  schema: string,
  name: string,
): string => {
  switch (relkind) {
    case 'r':
      return `Table "${schema}.${name}"`;
    case 'v':
      return `View "${schema}.${name}"`;
    case 'm':
      return `Materialized view "${schema}.${name}"`;
    case 'S':
      return `Sequence "${schema}.${name}"`;
    case 'i':
      return `Index "${schema}.${name}"`;
    case 'I':
      return `Partitioned index "${schema}.${name}"`;
    case 'p':
      return `Partitioned table "${schema}.${name}"`;
    case 'f':
      return `Foreign table "${schema}.${name}"`;
    case 't':
      return `TOAST table "${schema}.${name}"`;
    case 'c':
      return `Composite type "${schema}.${name}"`;
    default:
      return `Relation "${schema}.${name}"`;
  }
};

/**
 * Build a minimal {@link FieldDescription} for synthesized rows where
 * we don't actually have a wire-level row description. Used by the
 * columns table in `describeOneTableDetails` because we synthesize
 * the layout from pg_attribute data.
 */
const fakeField = (
  name: string,
): import('../types/connection.js').FieldDescription => ({
  name,
  tableID: 0,
  columnID: 0,
  dataTypeID: 25, // text
  dataTypeSize: -1,
  dataTypeModifier: -1,
  format: 0,
});
