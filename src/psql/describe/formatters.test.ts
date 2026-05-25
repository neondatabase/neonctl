import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';

import type { Connection, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts } from '../types/printer.js';

import {
  describeOneTableDetails,
  lookupOneRelation,
  runListQuery,
} from './formatters.js';
import { processSQLNamePattern } from './processNamePattern.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const captureStream = (): {
  out: NodeJS.WritableStream;
  text: () => string;
} => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    },
  });
  return {
    out: stream,
    text: () => Buffer.concat(chunks).toString('utf-8'),
  };
};

const mkResultSet = (fields: string[], rows: unknown[][]): ResultSet => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: null,
  fields: fields.map((name) => ({
    name,
    tableID: 0,
    columnID: 0,
    dataTypeID: 25,
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: 0 as const,
  })),
  rows,
  notices: [],
});

const mkConnection = (
  responses: { match: (sql: string) => boolean; rs: ResultSet }[],
): Connection => {
  const query = vi.fn((sql: string) => {
    const found = responses.find((r) => r.match(sql));
    if (!found) {
      return Promise.reject(
        new Error(`mock: unexpected sql: ${sql.slice(0, 80)}`),
      );
    }
    return Promise.resolve(found.rs);
  });
  return {
    serverVersion: 170000,
    parameterStatus: () => undefined,
    query: query as Connection['query'],
    execSimple: vi.fn(() => Promise.resolve([])) as Connection['execSimple'],
    prepare: vi.fn() as unknown as Connection['prepare'],
    startCopyIn: vi.fn() as unknown as Connection['startCopyIn'],
    startCopyOut: vi.fn() as unknown as Connection['startCopyOut'],
    pipeline: vi.fn() as unknown as Connection['pipeline'],
    cancel: vi.fn(() => Promise.resolve()),
    escapeIdentifier: (s) => `"${s}"`,
    escapeLiteral: (s) => `'${s}'`,
    onNotice: () => () => undefined,
    onNotification: () => () => undefined,
    close: vi.fn(() => Promise.resolve()),
    isClosed: () => false,
  };
};

const defaultPopt = (): PrintQueryOpts => ({
  topt: {
    format: 'aligned',
    expanded: 'off',
    border: 1,
    pager: 'off',
    pagerMinLines: 0,
    tuplesOnly: false,
    startTable: true,
    stopTable: true,
    defaultFooter: true,
    prior: 0,
    encoding: 'UTF8',
    envColumns: 0,
    columns: 0,
    unicodeBorderLineStyle: 'ascii',
    unicodeColumnLineStyle: 'ascii',
    unicodeHeaderLineStyle: 'ascii',
    fieldSep: '|',
    recordSep: '\n',
    numericLocale: false,
    tableAttr: null,
    title: null,
    footers: null,
    translateHeader: false,
    translateColumns: null,
    nullPrint: '',
    csvFieldSep: ',',
  },
  nullPrint: '',
  title: null,
  footers: null,
  translateHeader: false,
  translateColumns: null,
  nTranslateColumns: 0,
});

// ---------------------------------------------------------------------------
// describeOneTableDetails
// ---------------------------------------------------------------------------

/**
 * Standard match predicate for the tableInfo follow-up. Returns the
 * caller-supplied row (or the default "boring, no extras" row) so each
 * test can pick whichever flags it needs.
 */
const tableInfoMatch = (
  row?: unknown[],
): { match: (sql: string) => boolean; rs: ResultSet } => ({
  match: (s) => s.includes('c.relreplident') && s.includes('c.reltablespace'),
  rs: mkResultSet(
    [
      'relrowsecurity',
      'relforcerowsecurity',
      'relreplident',
      'relispartition',
      'reltablespace',
      'relam',
      'spcname',
      'amname',
    ],
    [row ?? ['f', 'f', 'd', 'f', 0, 0, null, null]],
  ),
});

describe('describeOneTableDetails', () => {
  it('renders columns + Indexes + Check constraints + FK sections', async () => {
    const cols = mkResultSet(
      [
        'attname',
        'type',
        'default',
        'attnotnull',
        'collation',
        'identity',
        'generated',
      ],
      [
        ['id', 'integer', null, 't', null, '', ''],
        ['name', 'text', "''::text", 'f', null, '', ''],
      ],
    );
    const indexes = mkResultSet(
      [
        'relname',
        'indisprimary',
        'indisunique',
        'indisclustered',
        'indisvalid',
        'indexdef',
        'condef',
        'contype',
        'condeferrable',
        'condeferred',
        'indisreplident',
        'reltablespace',
      ],
      [
        [
          'foo_pkey',
          't',
          't',
          'f',
          't',
          'CREATE UNIQUE INDEX foo_pkey ON public.foo USING btree (id)',
          'PRIMARY KEY (id)',
          'p',
          'f',
          'f',
          'f',
          0,
        ],
      ],
    );
    const checks = mkResultSet(
      ['conname', 'condef'],
      [['foo_name_check', 'CHECK (length(name) > 0)']],
    );
    const fks = mkResultSet(['conname', 'condef'], []);
    const refby = mkResultSet(['conname', 'conrelid', 'condef'], []);
    const triggers = mkResultSet(['tgname', 'tgdef', 'tgenabled'], []);

    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(),
      {
        match: (s) =>
          s.includes(
            'FROM pg_catalog.pg_class c, pg_catalog.pg_class c2, pg_catalog.pg_index',
          ),
        rs: indexes,
      },
      {
        match: (s) => s.includes("r.contype = 'c'"),
        rs: checks,
      },
      {
        match: (s) => s.includes("contype = 'f'") && s.includes('conrelid'),
        rs: fks,
      },
      {
        match: (s) => s.includes("contype = 'f'") && s.includes('confrelid'),
        rs: refby,
      },
      {
        match: (s) => s.includes('pg_catalog.pg_trigger'),
        rs: triggers,
      },
      // Empty fallbacks for the new sections (policies, inherits,
      // inherited-by) so the test passes through them.
      { match: () => true, rs: mkResultSet([], []) },
    ]);

    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      12345,
      'public',
      'foo',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Table "public.foo"');
    expect(text).toContain('Column');
    expect(text).toContain('id');
    expect(text).toContain('integer');
    expect(text).toContain('not null');
    expect(text).toContain('name');
    expect(text).toContain('Indexes:');
    expect(text).toContain('foo_pkey');
    expect(text).toContain('PRIMARY KEY');
    expect(text).toContain('Check constraints:');
    expect(text).toContain('foo_name_check');
  });

  it('omits Indexes section when no indexes', async () => {
    const cols = mkResultSet(
      [
        'attname',
        'type',
        'default',
        'attnotnull',
        'collation',
        'identity',
        'generated',
      ],
      [['x', 'int', null, 'f', null, '', '']],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(),
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'bar',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).not.toContain('Indexes:');
    expect(text).not.toContain('Check constraints:');
    expect(text).not.toContain('Foreign-key constraints:');
  });

  it('uses correct title for views', async () => {
    const cols = mkResultSet(
      [
        'attname',
        'type',
        'default',
        'attnotnull',
        'collation',
        'identity',
        'generated',
      ],
      [['x', 'int', null, 'f', null, '', '']],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(),
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'v',
      'v',
      false,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).toContain('View "public.v"');
  });

  // -------------------------------------------------------------------
  // New sections (WP-20 follow-up): RLS policies, replica identity,
  // partition bounds + child partitions, tablespace, access method,
  // inheritance, foreign-table options.
  // -------------------------------------------------------------------

  /**
   * Helper that builds a minimal "boring" column set + one-row
   * `attribute` response so a test can focus on the section under test.
   */
  const boringCols = (): ResultSet =>
    mkResultSet(
      [
        'attname',
        'type',
        'default',
        'attnotnull',
        'collation',
        'identity',
        'generated',
      ],
      [['id', 'int', null, 'f', null, '', '']],
    );

  it('renders Policies with permissive + restrictive entries', async () => {
    const cols = boringCols();
    const policies = mkResultSet(
      ['polname', 'polpermissive', 'roles', 'qual', 'withcheck', 'cmd'],
      [
        ['allow_owner', 't', 'app_user', 'user_id = current_user', null, null],
        ['deny_others', 'f', null, null, 'tenant_id = 0', 'UPDATE'],
      ],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['t', 'f', 'd', 'f', 0, 0, null, null]),
      { match: (s) => s.includes('FROM pg_catalog.pg_policy'), rs: policies },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Policies:');
    expect(text).toContain('POLICY "allow_owner"');
    expect(text).toContain('TO app_user');
    expect(text).toContain('USING (user_id = current_user)');
    expect(text).toContain('POLICY "deny_others" AS RESTRICTIVE');
    expect(text).toContain('FOR UPDATE');
    expect(text).toContain('WITH CHECK (tenant_id = 0)');
  });

  it('renders "Policies (forced row security enabled):" header when forced', async () => {
    const cols = boringCols();
    const policies = mkResultSet(
      ['polname', 'polpermissive', 'roles', 'qual', 'withcheck', 'cmd'],
      [['p1', 't', null, null, null, null]],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['t', 't', 'd', 'f', 0, 0, null, null]),
      { match: (s) => s.includes('FROM pg_catalog.pg_policy'), rs: policies },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).toContain('Policies (forced row security enabled):');
  });

  it('renders Replica Identity: FULL when relreplident = f (verbose)', async () => {
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'f', 'f', 0, 0, null, null]),
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'r',
      true,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).toContain('Replica Identity: FULL');
  });

  it('does NOT render Replica Identity for default relreplident', async () => {
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 0, null, null]),
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'r',
      true,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).not.toContain('Replica Identity');
  });

  it('renders Partition key + summary count for partitioned table (3 children)', async () => {
    const cols = boringCols();
    const partkey = mkResultSet(['partkeydef'], [['RANGE (created_at)']]);
    const children = mkResultSet(
      ['relname', 'relkind', 'inhdetachpending', 'partbound'],
      [
        [
          'foo_2023',
          'r',
          'f',
          "FOR VALUES FROM ('2023-01-01') TO ('2024-01-01')",
        ],
        [
          'foo_2024',
          'r',
          'f',
          "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
        ],
        ['foo_default', 'r', 'f', 'DEFAULT'],
      ],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 0, null, null]),
      {
        match: (s) => s.includes('pg_get_partkeydef'),
        rs: partkey,
      },
      {
        match: (s) => s.includes('i.inhparent =') && s.includes('pg_inherits'),
        rs: children,
      },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'p',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Partition key: RANGE (created_at)');
    expect(text).toContain('Number of partitions: 3 (Use \\d+ to list them.)');
    // In non-verbose mode we don't print the children themselves.
    expect(text).not.toContain('foo_2023');
  });

  it('renders Partitions: list in verbose mode for partitioned table', async () => {
    const cols = boringCols();
    const partkey = mkResultSet(['partkeydef'], [['RANGE (created_at)']]);
    const children = mkResultSet(
      ['relname', 'relkind', 'inhdetachpending', 'partbound'],
      [
        [
          'foo_2023',
          'r',
          'f',
          "FOR VALUES FROM ('2023-01-01') TO ('2024-01-01')",
        ],
        ['foo_default', 'r', 'f', 'DEFAULT'],
      ],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 0, null, null]),
      {
        match: (s) => s.includes('pg_get_partkeydef'),
        rs: partkey,
      },
      {
        match: (s) => s.includes('i.inhparent =') && s.includes('pg_inherits'),
        rs: children,
      },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'p',
      true,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Partitions: foo_2023');
    expect(text).toContain('foo_default DEFAULT');
    expect(text).not.toContain('Number of partitions:');
  });

  it('renders Partition of: for child partition with default bound', async () => {
    const cols = boringCols();
    const partOf = mkResultSet(
      ['parent', 'bound', 'inhdetachpending'],
      [['public.foo', 'DEFAULT', 'f']],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 't', 0, 0, null, null]),
      {
        match: (s) =>
          s.includes('inhparent::pg_catalog.regclass') &&
          s.includes('c.oid = i.inhrelid'),
        rs: partOf,
      },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo_default',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).toContain('Partition of: public.foo DEFAULT');
  });

  it('renders Partition constraint in verbose mode for child partition', async () => {
    const cols = boringCols();
    const partOf = mkResultSet(
      ['parent', 'bound', 'inhdetachpending', 'constraintdef'],
      [
        [
          'public.foo',
          "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
          'f',
          "((created_at >= '2024-01-01'::timestamp) AND (created_at < '2025-01-01'::timestamp))",
        ],
      ],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 't', 0, 0, null, null]),
      {
        match: (s) =>
          s.includes('inhparent::pg_catalog.regclass') &&
          s.includes('c.oid = i.inhrelid'),
        rs: partOf,
      },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo_2024',
      'r',
      true,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Partition of: public.foo FOR VALUES FROM');
    expect(text).toContain('Partition constraint:');
    expect(text).toContain("created_at >= '2024-01-01'");
  });

  it('renders Server + FDW options footer for foreign table', async () => {
    const cols = boringCols();
    const ftInfo = mkResultSet(
      ['srvname', 'ftoptions'],
      [['remote_srv', "schema_name 'public', table_name 'remote_t'"]],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 0, null, null]),
      {
        match: (s) => s.includes('pg_catalog.pg_foreign_table'),
        rs: ftInfo,
      },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'remote_t',
      'f',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Server: remote_srv');
    expect(text).toContain(
      "FDW options: (schema_name 'public', table_name 'remote_t')",
    );
  });

  it('renders Inherits: list for inherited table', async () => {
    const cols = boringCols();
    const inherits = mkResultSet(
      ['parent'],
      [['public.parent_a'], ['public.parent_b']],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(),
      {
        match: (s) => s.includes('c.oid = i.inhparent AND i.inhrelid'),
        rs: inherits,
      },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'child',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Inherits: public.parent_a,');
    expect(text).toContain('public.parent_b');
  });

  it('renders Tablespace footer when relation has non-default tablespace (verbose)', async () => {
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 16385, 0, 'fast_ssd', null]),
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'r',
      true,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).toContain('Tablespace: "fast_ssd"');
  });

  it('renders Access method footer for matview with custom AM (verbose)', async () => {
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 7777, null, 'columnar']),
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'mv',
      'm',
      true,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).toContain('Access method: columnar');
  });

  it('does NOT render Access method footer in non-verbose mode', async () => {
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 7777, null, 'columnar']),
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'mv',
      'm',
      false,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).not.toContain('Access method:');
  });

  it('renders Number of partitions: 0 for empty partitioned table', async () => {
    const cols = boringCols();
    const partkey = mkResultSet(['partkeydef'], [['RANGE (id)']]);
    const empty = mkResultSet(
      ['relname', 'relkind', 'inhdetachpending', 'partbound'],
      [],
    );
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 0, null, null]),
      { match: (s) => s.includes('pg_get_partkeydef'), rs: partkey },
      {
        match: (s) => s.includes('i.inhparent =') && s.includes('pg_inherits'),
        rs: empty,
      },
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'foo',
      'p',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Number of partitions: 0');
    expect(text).not.toContain('(Use \\d+ to list them.)');
  });
});

// ---------------------------------------------------------------------------
// lookupOneRelation
// ---------------------------------------------------------------------------

describe('lookupOneRelation', () => {
  it('returns null when no row matches', async () => {
    const conn = mkConnection([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_class'),
        rs: mkResultSet(['oid', 'nspname', 'relname', 'relkind'], []),
      },
    ]);
    const r = await lookupOneRelation(conn, null, 'nope');
    expect(r).toBeNull();
  });

  it('extracts relkind for found row', async () => {
    const conn = mkConnection([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_class'),
        rs: mkResultSet(
          ['oid', 'nspname', 'relname', 'relkind'],
          [[42, 'public', 'users', 'r']],
        ),
      },
    ]);
    const r = await lookupOneRelation(conn, null, 'users');
    expect(r).toEqual({
      oid: 42,
      nspname: 'public',
      relname: 'users',
      relkind: 'r',
    });
  });

  it('includes schema constraint when schemaPattern provided', async () => {
    const queryCalls: string[] = [];
    const wrappedConn = mkConnection([
      {
        match: (s) => {
          queryCalls.push(s);
          return s.includes('FROM pg_catalog.pg_class');
        },
        rs: mkResultSet(
          ['oid', 'nspname', 'relname', 'relkind'],
          [[1, 'pg_catalog', 'pg_class', 'r']],
        ),
      },
    ]);
    await lookupOneRelation(wrappedConn, 'pg_catalog', 'pg_class');
    expect(queryCalls[0]).toContain('n.nspname OPERATOR(pg_catalog.~) $2');
    expect(queryCalls[0]).not.toContain('pg_table_is_visible');
  });

  it('uses visibility check when no schemaPattern', async () => {
    const queryCalls: string[] = [];
    const wrappedConn = mkConnection([
      {
        match: (s) => {
          queryCalls.push(s);
          return s.includes('FROM pg_catalog.pg_class');
        },
        rs: mkResultSet(['oid', 'nspname', 'relname', 'relkind'], []),
      },
    ]);
    await lookupOneRelation(wrappedConn, null, 'foo');
    expect(queryCalls[0]).toContain('pg_table_is_visible');
  });
});

// ---------------------------------------------------------------------------
// runListQuery
// ---------------------------------------------------------------------------

describe('runListQuery', () => {
  it('substitutes pattern placeholder before sending', async () => {
    const recorded: { sql: string; params: unknown[] }[] = [];
    const conn: Connection = {
      ...mkConnection([{ match: () => true, rs: mkResultSet(['x'], [['1']]) }]),
      query: ((sql: string, params?: unknown[]) => {
        recorded.push({ sql, params: params ?? [] });
        return Promise.resolve(mkResultSet(['x'], [['1']]));
      }) as Connection['query'],
    };
    const result = processSQLNamePattern({
      pattern: 'foo',
      namevar: 'c.relname',
      schemavar: 'n.nspname',
    });
    const query = {
      sql: 'SELECT * FROM pg_class WHERE true /* TODO(WP-20): pattern matching */;',
      params: [],
      description: 'List',
    };
    const cap = captureStream();
    await runListQuery(conn, query, result, cap.out, defaultPopt());
    expect(recorded[0].sql).toContain('OPERATOR(pg_catalog.~)');
    expect(recorded[0].params).toEqual(['^(foo)$']);
  });
});
