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
import {
  fetchForeignTableInfo,
  fetchInheritedBy,
  fetchInherits,
  fetchPartitionKey,
  fetchPartitionOf,
  fetchPerColumnFdwOptions,
  fetchPolicies,
  fetchStatisticsObjects,
  fetchTableInfo,
  fetchTablePublications,
  fetchTableSubscriptions,
  fetchToastOwningTable,
} from './queries.js';
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
  // ----- One-shot relation info (RLS flags, replica identity,
  //       partition flag, tablespace, access method). Fetched before
  //       columns so the matview header can carry an "Access method:"
  //       line and the per-column FDW options can be merged inline.
  const relInfo = await fetchRelationInfo(conn, oid);

  // Compose the title. Matviews with a non-default access method get
  // a second line ("Access method: <amname>") between the header and
  // the column table — see upstream `describeOneTableDetails`.
  const baseTitle = headerForRelkind(relkind, schema, name);
  const title =
    relkind === 'm' && relInfo.relam !== 0 && relInfo.amname
      ? `${baseTitle}\nAccess method: ${relInfo.amname}`
      : baseTitle;

  // ----- Pre-fetch per-column FDW options (foreign tables only) so we
  //       can fold them into each column row. Upstream renders these
  //       inline as a trailing "FDW options: (k 'v', ...)" annotation
  //       rather than a separate footer section.
  const fdwOptionsByColumn =
    relkind === 'f'
      ? await fetchPerColumnFdwOptionsMap(conn, oid)
      : new Map<string, string>();

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

  // Foreign tables get an extra "FDW options" column when at least one
  // attribute actually has options set (matches upstream — the column
  // slot is conditional on the row data, not just the relkind).
  const hasAnyFdwOptions = fdwOptionsByColumn.size > 0;

  // Synthesize a printable result set: Column, Type, Collation, Nullable, Default[, FDW options]
  const fields = [
    fakeField('Column'),
    fakeField('Type'),
    fakeField('Collation'),
    fakeField('Nullable'),
    fakeField('Default'),
  ];
  if (hasAnyFdwOptions) fields.push(fakeField('FDW options'));
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
      // STORED generated column (PG 12+).
      dflt = dflt ? `generated always as (${dflt}) stored` : '';
    } else if (generated === 'v') {
      // VIRTUAL generated column (PG 18+). Same expression rendering as
      // STORED but without the trailing keyword.
      dflt = dflt ? `generated always as (${dflt})` : '';
    }
    const row: unknown[] = [colName, colType, collation ?? '', nullable, dflt];
    if (hasAnyFdwOptions) {
      const opts = fdwOptionsByColumn.get(colName);
      row.push(opts ? `(${opts})` : '');
    }
    return row;
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

  // ----- Partition-key (partitioned-table parent only) -----
  if (relkind === 'p') {
    await renderPartitionKeySection(conn, oid, out);
  }

  // ----- Partition-of (child partition only) -----
  if (relInfo.relispartition) {
    await renderPartitionOfSection(conn, oid, verbose, out);
  }

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

  // ----- RLS policies (regular + partitioned tables) -----
  if (relkind === 'r' || relkind === 'p') {
    await renderPoliciesSection(conn, oid, relInfo, out);
  }

  // ----- Foreign-table footer: Server + FDW options -----
  // Per-column FDW options are rendered inline within the columns
  // table (see fdwOptionsByColumn above); no separate footer here.
  if (relkind === 'f') {
    await renderForeignTableFooter(conn, oid, out);
  }

  // ----- Inherits: (parents) — for tables, partitioned tables, foreign -----
  if (relkind === 'r' || relkind === 'p' || relkind === 'f') {
    await renderInheritsSection(conn, oid, out);
  }

  // ----- Inherited by / Partitions / Number of [child tables|partitions] -----
  if (relkind === 'r' || relkind === 'p' || relkind === 'f') {
    await renderInheritedBySection(conn, oid, relkind, verbose, out);
  }

  // ----- Publications (any publishable relkind) -----
  if (
    relkind === 'r' ||
    relkind === 'p' ||
    relkind === 'm' ||
    relkind === 'f'
  ) {
    await renderPublicationsSection(conn, oid, out);
  }

  // ----- Subscriptions (any publishable relkind; permission-denied silent) -----
  if (
    relkind === 'r' ||
    relkind === 'p' ||
    relkind === 'm' ||
    relkind === 'f'
  ) {
    await renderSubscriptionsSection(conn, oid, out);
  }

  // ----- Statistics objects (verbose; r/m/p/f) -----
  if (
    verbose &&
    (relkind === 'r' || relkind === 'm' || relkind === 'p' || relkind === 'f')
  ) {
    await renderStatisticsObjectsSection(conn, oid, out);
  }

  // ----- Replica Identity (verbose, non-default, regular & matview).
  //       INDEX mode is rendered inline within Indexes:, so the footer
  //       is only emitted for FULL / NOTHING.
  if (verbose && (relkind === 'r' || relkind === 'm')) {
    renderReplicaIdentitySection(schema, relInfo, out);
  }

  // ----- Tablespace footer (verbose: explicit tablespace only) -----
  if (verbose) {
    renderTablespaceFooter(relkind, relInfo, out);
  }

  // ----- Access method footer (verbose: relkind r/p with relam set).
  //       Matviews ('m') show their access method inline in the header,
  //       so we don't double up here.
  if (verbose && (relkind === 'r' || relkind === 'p')) {
    renderAccessMethodFooter(relInfo, out);
  }

  // ----- Owning table (TOAST tables only) -----
  if (relkind === 't') {
    await renderToastOwningTableFooter(conn, oid, out);
  }
};

/**
 * Parsed footer-relevant fields for the relation under inspection. The
 * names mirror the C struct in upstream `describe.c`.
 */
type RelationInfo = {
  rowsecurity: boolean;
  forcerowsecurity: boolean;
  relreplident: string;
  relispartition: boolean;
  reltablespace: number;
  relam: number;
  spcname: string | null;
  amname: string | null;
};

/**
 * Helper that runs {@link fetchTableInfo} and parses the resulting row
 * into a {@link RelationInfo}. Returns sensible falsy defaults when the
 * row is missing (shouldn't happen given the caller already looked up
 * the relation, but we don't want to throw mid-render).
 */
const fetchRelationInfo = async (
  conn: Connection,
  oid: number,
): Promise<RelationInfo> => {
  const q = fetchTableInfo({ oid, serverVersion: conn.serverVersion });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) {
    return {
      rowsecurity: false,
      forcerowsecurity: false,
      relreplident: 'd',
      relispartition: false,
      reltablespace: 0,
      relam: 0,
      spcname: null,
      amname: null,
    };
  }
  const r = rs.rows[0];
  return {
    rowsecurity: parseBool(r[0]),
    forcerowsecurity: parseBool(r[1]),
    relreplident: cellToString(r[2] ?? 'd') || 'd',
    relispartition: parseBool(r[3]),
    reltablespace: Number(cellToString(r[4] ?? '0')) || 0,
    relam: Number(cellToString(r[5] ?? '0')) || 0,
    spcname: r[6] === null || r[6] === undefined ? null : cellToString(r[6]),
    amname: r[7] === null || r[7] === undefined ? null : cellToString(r[7]),
  };
};

/** Coerce a Postgres "t"/"f" text-mode boolean (or a real bool) to JS. */
const parseBool = (v: unknown): boolean =>
  v === true || (typeof v === 'string' && (v === 't' || v === 'true'));

/**
 * Render `Partition key: <partkeydef>` for partitioned-table parents.
 */
const renderPartitionKeySection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchPartitionKey({ oid });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) return;
  const def = cellToString(rs.rows[0][0] ?? '');
  if (def === '') return;
  out.write(`Partition key: ${def}\n`);
};

/**
 * Render the "Partition of: <parent> <bound>[ DETACH PENDING]" line and
 * the verbose-only "Partition constraint:" follow-up for a child
 * partition (`relispartition = true`).
 */
const renderPartitionOfSection = async (
  conn: Connection,
  oid: number,
  verbose: boolean,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchPartitionOf({
    oid,
    serverVersion: conn.serverVersion,
    withConstraint: verbose,
  });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) return;
  const row = rs.rows[0];
  const parent = cellToString(row[0] ?? '');
  const bound = cellToString(row[1] ?? '');
  const detached = parseBool(row[2]);
  const tail = detached ? ' DETACH PENDING' : '';
  out.write(`Partition of: ${parent} ${bound}${tail}\n`);
  if (verbose) {
    const constraintdef =
      row[3] === null || row[3] === undefined ? '' : cellToString(row[3]);
    if (constraintdef === '') {
      out.write('No partition constraint\n');
    } else {
      out.write(`Partition constraint: ${constraintdef}\n`);
    }
  }
};

/**
 * Render the `Policies[...]:` header + one POLICY line per row. The
 * exact header text encodes (rowsecurity, forcerowsecurity, has-policies)
 * the same way upstream does, including the "(none)" tail for the
 * enabled-but-no-policies cases.
 */
const renderPoliciesSection = async (
  conn: Connection,
  oid: number,
  relInfo: RelationInfo,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchPolicies({ oid, serverVersion: conn.serverVersion });
  const rs = await conn.query(q.sql, q.params);
  const tuples = rs.rows.length;
  const { rowsecurity, forcerowsecurity } = relInfo;

  let header: string | null = null;
  if (rowsecurity && !forcerowsecurity && tuples > 0) {
    header = 'Policies:';
  } else if (rowsecurity && forcerowsecurity && tuples > 0) {
    header = 'Policies (forced row security enabled):';
  } else if (rowsecurity && !forcerowsecurity && tuples === 0) {
    header = 'Policies (row security enabled): (none)';
  } else if (rowsecurity && forcerowsecurity && tuples === 0) {
    header = 'Policies (forced row security enabled): (none)';
  } else if (!rowsecurity && tuples > 0) {
    header = 'Policies (row security disabled):';
  }

  if (header === null) return;
  out.write(`${header}\n`);

  for (const r of rs.rows) {
    const polname = cellToString(r[0]);
    const permissive = parseBool(r[1]);
    const roles =
      r[2] === null || r[2] === undefined ? null : cellToString(r[2]);
    const qual =
      r[3] === null || r[3] === undefined ? null : cellToString(r[3]);
    const withcheck =
      r[4] === null || r[4] === undefined ? null : cellToString(r[4]);
    const cmd = r[5] === null || r[5] === undefined ? null : cellToString(r[5]);
    let line = `    POLICY "${polname}"`;
    if (!permissive) line += ' AS RESTRICTIVE';
    if (cmd !== null && cmd !== '') line += ` FOR ${cmd}`;
    if (roles !== null) line += `\n      TO ${roles}`;
    if (qual !== null) line += `\n      USING (${qual})`;
    if (withcheck !== null) line += `\n      WITH CHECK (${withcheck})`;
    out.write(`${line}\n`);
  }
};

/**
 * Render the foreign-table footer: `Server: <name>` + optional
 * `FDW options: (key 'val', key 'val')`. Upstream pulls these in a
 * single follow-up query; we mirror that shape via
 * {@link fetchForeignTableInfo}.
 */
const renderForeignTableFooter = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchForeignTableInfo({ oid });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) return;
  const row = rs.rows[0];
  const server = cellToString(row[0] ?? '');
  const ftoptions =
    row[1] === null || row[1] === undefined ? '' : cellToString(row[1]);
  if (server !== '') out.write(`Server: ${server}\n`);
  if (ftoptions !== '') out.write(`FDW options: (${ftoptions})\n`);
};

/**
 * Render `Inherits: <parent>[, ...]` for relations with parents in
 * `pg_inherits`. Partition parents are excluded (they're rendered via
 * `Partition of:` instead) inside the query builder.
 */
const renderInheritsSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchInherits({ oid });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) return;
  const label = 'Inherits';
  const indent = ' '.repeat(label.length);
  rs.rows.forEach((r, idx) => {
    const parent = cellToString(r[0]);
    const prefix = idx === 0 ? `${label}: ` : `${indent}  `;
    const trailing = idx < rs.rows.length - 1 ? ',' : '';
    out.write(`${prefix}${parent}${trailing}\n`);
  });
};

/**
 * Render the child-relation footer for inheritance / partition parents.
 *
 * - Partitioned parents always emit a `Number of partitions: N` footer
 *   (even when zero, even in verbose mode); when verbose=false and N>0
 *   the footer adds the `(Use \d+ to list them.)` hint. Verbose mode
 *   replaces the count with a full `Partitions:` list including bounds.
 * - Non-partition parents (regular tables) emit `Number of child
 *   tables: N (Use \d+ to list them.)` (non-verbose) or `Child tables:`
 *   list (verbose).
 */
const renderInheritedBySection = async (
  conn: Connection,
  oid: number,
  relkind: string,
  verbose: boolean,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const isPartitioned = relkind === 'p' || relkind === 'I';
  const q = fetchInheritedBy({ oid, serverVersion: conn.serverVersion });
  const rs = await conn.query(q.sql, q.params);
  const tuples = rs.rows.length;

  if (isPartitioned && tuples === 0) {
    out.write('Number of partitions: 0\n');
    return;
  }

  if (!verbose) {
    if (tuples === 0) return;
    if (isPartitioned) {
      out.write(`Number of partitions: ${tuples} (Use \\d+ to list them.)\n`);
    } else {
      out.write(`Number of child tables: ${tuples} (Use \\d+ to list them.)\n`);
    }
    return;
  }

  // Verbose mode: list each child with its bound (for partitions) and
  // child-relkind annotations.
  const label = isPartitioned ? 'Partitions' : 'Child tables';
  const indent = ' '.repeat(label.length);
  rs.rows.forEach((r, idx) => {
    const relname = cellToString(r[0]);
    const childKind = cellToString(r[1] ?? '');
    const detached = parseBool(r[2]);
    const bound = r[3] === null || r[3] === undefined ? '' : cellToString(r[3]);
    const prefix = idx === 0 ? `${label}: ` : `${indent}  `;
    let line = `${prefix}${relname}`;
    if (bound !== '') line += ` ${bound}`;
    if (childKind === 'p' || childKind === 'I') line += ', PARTITIONED';
    else if (childKind === 'f') line += ', FOREIGN';
    if (detached) line += ' (DETACH PENDING)';
    if (idx < rs.rows.length - 1) line += ',';
    out.write(`${line}\n`);
  });
};

/**
 * Render `Replica Identity: <value>` when the relation's `relreplident`
 * is non-default and non-INDEX. Upstream skips this footer entirely for
 * the default value ('d' in user schemas, 'n' for pg_catalog relations);
 * INDEX-mode (relreplident = 'i') is surfaced inline on the matching
 * index line in the Indexes: section, so no footer is emitted there
 * either.
 */
const renderReplicaIdentitySection = (
  schema: string,
  relInfo: RelationInfo,
  out: NodeJS.WritableStream,
): void => {
  const ri = relInfo.relreplident;
  // INDEX mode is rendered inline on the matching index — no footer.
  if (ri === 'i') return;
  // pg_catalog relations default to 'n', user relations to 'd' — both
  // suppress the footer when the value matches the schema default.
  const isCatalog = schema === 'pg_catalog';
  if (!isCatalog && ri === 'd') return;
  if (isCatalog && ri === 'n') return;
  const label =
    ri === 'f'
      ? 'FULL'
      : ri === 'd'
        ? 'NOTHING'
        : ri === 'n'
          ? 'NOTHING'
          : '???';
  out.write(`Replica Identity: ${label}\n`);
};

/**
 * Emit `Tablespace: "<name>"` when the relation has an explicit
 * (non-default) tablespace. Only meaningful for relkinds that support
 * tablespaces — caller enforces the relkind filter.
 */
const renderTablespaceFooter = (
  relkind: string,
  relInfo: RelationInfo,
  out: NodeJS.WritableStream,
): void => {
  const tsSupported =
    relkind === 'r' ||
    relkind === 'm' ||
    relkind === 'i' ||
    relkind === 'I' ||
    relkind === 'p' ||
    relkind === 't';
  if (!tsSupported) return;
  if (relInfo.reltablespace === 0 || !relInfo.spcname) return;
  out.write(`Tablespace: "${relInfo.spcname}"\n`);
};

/**
 * Emit `Access method: <name>` when the relation has an explicit table
 * access method (PG 12+). Indexes have their AM rendered inline within
 * the index definition string, so this footer covers only
 * tables / materialized views / partitioned tables.
 */
const renderAccessMethodFooter = (
  relInfo: RelationInfo,
  out: NodeJS.WritableStream,
): void => {
  if (relInfo.relam === 0 || !relInfo.amname) return;
  out.write(`Access method: ${relInfo.amname}\n`);
};

/**
 * Render `Indexes:\n    "name" PRIMARY KEY, btree (col)` for each index
 * on `oid`. Free-form section — not a table.
 *
 * When the relation has INDEX-mode replica identity (relreplident = 'i'),
 * the corresponding index gets a trailing " REPLICA IDENTITY" marker on
 * its line, matching upstream `\d` output. The marker comes from each
 * index's own `pg_index.indisreplident` flag — only one index can carry
 * it, so no follow-up footer is needed for INDEX-mode RI.
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
    const isReplIdent = String(r[10]) === 't' || r[10] === true;
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
    if (isReplIdent) line += ' REPLICA IDENTITY';
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
 * Render `Statistics objects:\n    "schema"."name" (kinds) ON cols FROM tbl`
 * for each `pg_statistic_ext` row on the relation. Verbose-only.
 *
 * Upstream concatenates the active "kinds" (ndistinct / dependencies / mcv)
 * inside parentheses; we preserve insertion order matching upstream.
 */
const renderStatisticsObjectsSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchStatisticsObjects({ oid, serverVersion: conn.serverVersion });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) return;
  out.write('Statistics objects:\n');
  for (const r of rs.rows) {
    const nsp = cellToString(r[0] ?? '');
    const name = cellToString(r[1] ?? '');
    const ndist = parseBool(r[2]);
    const deps = parseBool(r[3]);
    const mcv = parseBool(r[4]);
    const columns = cellToString(r[5] ?? '');
    const relname = cellToString(r[6] ?? '');
    const kinds: string[] = [];
    if (ndist) kinds.push('ndistinct');
    if (deps) kinds.push('dependencies');
    if (mcv) kinds.push('mcv');
    const kindStr = kinds.length > 0 ? ` (${kinds.join(', ')})` : '';
    out.write(
      `    "${nsp}"."${name}"${kindStr} ON ${columns} FROM ${relname}\n`,
    );
  }
};

/**
 * Render `Publications:\n    "name"` (one per row) for any publication
 * the relation belongs to (explicit, FOR ALL TABLES, or FOR ALL TABLES
 * IN SCHEMA). No-op when the result set is empty.
 */
const renderPublicationsSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchTablePublications({ oid, serverVersion: conn.serverVersion });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) return;
  out.write('Publications:\n');
  for (const r of rs.rows) {
    out.write(`    "${cellToString(r[0] ?? '')}"\n`);
  }
};

/**
 * Render `Subscriptions:\n    "name"` (one per row). Requires superuser
 * access to `pg_subscription` — when the query fails with a permission
 * error, the section is silently omitted (mirroring upstream behaviour).
 */
const renderSubscriptionsSection = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchTableSubscriptions({ oid, serverVersion: conn.serverVersion });
  let rs;
  try {
    rs = await conn.query(q.sql, q.params);
  } catch (err) {
    if (isPermissionDeniedError(err)) return;
    throw err;
  }
  if (rs.rows.length === 0) return;
  out.write('Subscriptions:\n');
  for (const r of rs.rows) {
    out.write(`    "${cellToString(r[0] ?? '')}"\n`);
  }
};

/**
 * Pre-fetch per-column FDW options for a foreign table and index them by
 * column name so the column-table renderer can fold them in inline.
 * Upstream renders these as a trailing "FDW options: (k 'v', ...)" cell
 * on each affected column row, not as a separate footer.
 */
const fetchPerColumnFdwOptionsMap = async (
  conn: Connection,
  oid: number,
): Promise<Map<string, string>> => {
  const q = fetchPerColumnFdwOptions({ oid });
  const rs = await conn.query(q.sql, q.params);
  const m = new Map<string, string>();
  for (const r of rs.rows) {
    const attname = cellToString(r[0] ?? '');
    const opts = cellToString(r[1] ?? '');
    if (attname !== '' && opts !== '') m.set(attname, opts);
  }
  return m;
};

/**
 * Render `Owning table: "schema"."name"` for a TOAST relation. Matches
 * upstream's `\d <toast>` footer.
 */
const renderToastOwningTableFooter = async (
  conn: Connection,
  oid: number,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const q = fetchToastOwningTable({ oid });
  const rs = await conn.query(q.sql, q.params);
  if (rs.rows.length === 0) return;
  const owner = cellToString(rs.rows[0][0] ?? '');
  if (owner === '') return;
  out.write(`Owning table: ${owner}\n`);
};

/**
 * Detect a "permission denied" PostgresError (SQLSTATE 42501) on a
 * thrown value. We look at both `code` (SQLSTATE) and the message text
 * because not every transport layer surfaces the code. The check is
 * intentionally conservative — we only swallow genuine privilege
 * errors, not arbitrary failures.
 */
const isPermissionDeniedError = (err: unknown): boolean => {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code === '42501') return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && /permission denied/i.test(message)) {
    return true;
  }
  return false;
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
