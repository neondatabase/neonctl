import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';

import type { Connection, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts } from '../types/printer.js';

import {
  describeOneTableDetails,
  describeOneViewDetails,
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

// Non-verbose single-column result set shared by the PG18-parity blocks.
const boringCols2 = (): ResultSet =>
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
    [['id', 'integer', null, 't', null, '', '']],
  );

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

  it('annotates the replica-identity index inline within Indexes:', async () => {
    // Round 3 polish: INDEX-mode replica identity is rendered as a
    // " REPLICA IDENTITY" suffix on the matching index line instead of
    // a `Replica Identity: INDEX "name"` footer.
    const cols = boringCols();
    // Two indexes on the relation: a primary key (no RI) + a unique
    // index marked as INDEX replica identity (indisreplident = 't').
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
        [
          'foo_x_key',
          'f',
          't',
          'f',
          't',
          'CREATE UNIQUE INDEX foo_x_key ON public.foo USING btree (x)',
          'UNIQUE (x)',
          'u',
          'f',
          'f',
          't',
          0,
        ],
      ],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'i', 'f', 0, 0, null, null]),
      {
        match: (s) =>
          s.includes(
            'FROM pg_catalog.pg_class c, pg_catalog.pg_class c2, pg_catalog.pg_index',
          ),
        rs: indexes,
      },
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
    const text = cap.text();
    expect(text).toContain('Indexes:');
    // Primary key line: no REPLICA IDENTITY suffix.
    const lines = text.split('\n');
    const pkLine = lines.find((l) => l.includes('foo_pkey'));
    expect(pkLine).toBeDefined();
    expect(pkLine).not.toMatch(/REPLICA IDENTITY/);
    // Unique-index line: trailing REPLICA IDENTITY marker.
    const riLine = lines.find((l) => l.includes('foo_x_key'));
    expect(riLine).toBeDefined();
    expect(riLine).toMatch(/REPLICA IDENTITY/);
    // INDEX-mode RI footer is suppressed — only the inline marker.
    expect(text).not.toContain('Replica Identity: INDEX');
    expect(text).not.toContain('Replica Identity:');
  });

  it('renders Replica Identity: NOTHING footer for relreplident = n (verbose)', async () => {
    // NOTHING (and FULL) modes still have a footer — only INDEX moved
    // inline.
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'n', 'f', 0, 0, null, null]),
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
    expect(cap.text()).toContain('Replica Identity: NOTHING');
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

  it('renders Access method for matview with custom AM (verbose, in header)', async () => {
    // Round 3 polish: matview AM is rendered inline in the header,
    // independent of verbose. The verbose footer for matview is
    // suppressed so we don't double up.
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
    const text = cap.text();
    expect(text).toContain('Access method: columnar');
    // Matview AM appears once — in the header, not duplicated in the
    // footer.
    expect(text.match(/Access method:/g)?.length).toBe(1);
  });

  it('renders Access method footer for regular table with custom AM (verbose, in footer)', async () => {
    // Plain tables still have the verbose footer rendering — only
    // matviews switched to inline-in-header.
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 7777, null, 'heap']),
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
    const text = cap.text();
    expect(text).toContain('Access method: heap');
    // Confirm it really is in the footer (after the columns table),
    // not woven into the title line.
    const lines = text.split('\n');
    const titleIdx = lines.findIndex((l) => l.includes('Table "public.foo"'));
    const amIdx = lines.findIndex((l) => l.includes('Access method: heap'));
    expect(amIdx).toBeGreaterThan(titleIdx + 2);
    // Footer sits flush against the last data row (no blank line
    // between data and footer) and is followed by a single trailing
    // blank line — matches upstream `printTableAddFooter` semantics.
    // The last data row is the one containing ` id ` (boringCols).
    const lastDataIdx = lines.findIndex(
      (l, i) => i > titleIdx + 2 && /\bid\b/.test(l) && !l.startsWith('---'),
    );
    expect(lastDataIdx).toBeGreaterThan(-1);
    expect(amIdx).toBe(lastDataIdx + 1);
    expect(lines[amIdx + 1]).toBe('');
  });

  it('renders matview Access method in the header even in non-verbose mode', async () => {
    // Round 3 polish moved matview access-method rendering from a
    // verbose-only footer to a header line so it matches upstream
    // (`Materialized view "x"\nAccess method: <am>\n  Column | …`).
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
    const text = cap.text();
    // The matview title is now multi-line: title + access-method line
    // immediately above the columns table.
    expect(text).toContain('Materialized view "public.mv"');
    expect(text).toContain('Access method: columnar');
    const lines = text.split('\n');
    const titleIdx = lines.findIndex((l) =>
      l.includes('Materialized view "public.mv"'),
    );
    const amIdx = lines.findIndex((l) => l.includes('Access method: columnar'));
    expect(amIdx).toBe(titleIdx + 1);
  });

  it('omits matview Access method header when relam = 0 (default AM)', async () => {
    // No access method means no extra header line — the title falls
    // back to the single-line "Materialized view "x"".
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

  // -------------------------------------------------------------------
  // Round-2 sections: Statistics objects, Publications, Subscriptions,
  // Per-column FDW options, TOAST Owning table.
  // -------------------------------------------------------------------

  it('renders Statistics objects section with mixed kinds (verbose)', async () => {
    const cols = boringCols();
    const stats = mkResultSet(
      [
        'stxnsp',
        'stxname',
        'ndist_enabled',
        'deps_enabled',
        'mcv_enabled',
        'columns',
        'stxrelname',
        'stxstattarget',
      ],
      [
        ['public', 'foo_stats', 't', 't', 'f', 'a, b', 'public.foo', '-1'],
        ['public', 'foo_mcv', 'f', 'f', 't', 'c', 'public.foo', '-1'],
      ],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 0, null, null]),
      {
        match: (s) => s.includes('FROM pg_catalog.pg_statistic_ext'),
        rs: stats,
      },
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
    const text = cap.text();
    expect(text).toContain('Statistics objects:');
    expect(text).toContain(
      '"public"."foo_stats" (ndistinct, dependencies) ON a, b FROM public.foo',
    );
    expect(text).toContain('"public"."foo_mcv" (mcv) ON c FROM public.foo');
  });

  it('does NOT render Statistics objects in non-verbose mode', async () => {
    const cols = boringCols();
    const stats = mkResultSet(
      [
        'stxnsp',
        'stxname',
        'ndist_enabled',
        'deps_enabled',
        'mcv_enabled',
        'columns',
        'stxrelname',
        'stxstattarget',
      ],
      [['public', 'foo_stats', 't', 'f', 'f', 'a', 'public.foo', '-1']],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(['f', 'f', 'd', 'f', 0, 0, null, null]),
      // Even if returned, non-verbose mode must not query / render this.
      {
        match: (s) => s.includes('FROM pg_catalog.pg_statistic_ext'),
        rs: stats,
      },
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
    expect(cap.text()).not.toContain('Statistics objects:');
  });

  it('renders Publications with explicit + FOR ALL TABLES entries', async () => {
    const cols = boringCols();
    const pubs = mkResultSet(
      ['pubname'],
      [['pub_all_tables'], ['pub_explicit_a'], ['pub_explicit_b']],
    );
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(),
      {
        match: (s) =>
          s.includes('FROM pg_catalog.pg_publication') &&
          s.includes('puballtables'),
        rs: pubs,
      },
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
    expect(text).toContain('Publications:');
    expect(text).toContain('"pub_all_tables"');
    expect(text).toContain('"pub_explicit_a"');
    expect(text).toContain('"pub_explicit_b"');
  });

  it('omits Publications section when no rows', async () => {
    const cols = boringCols();
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
      'foo',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).not.toContain('Publications:');
  });

  it('renders Subscriptions section listing matched subs', async () => {
    const cols = boringCols();
    const subs = mkResultSet(['subname'], [['sub_a']]);
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(),
      {
        match: (s) =>
          s.includes('FROM pg_catalog.pg_subscription') &&
          s.includes('pg_subscription_rel'),
        rs: subs,
      },
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
    expect(text).toContain('Subscriptions:');
    expect(text).toContain('"sub_a"');
  });

  it('silently omits Subscriptions on permission denied', async () => {
    const cols = boringCols();
    const empty = mkResultSet([], []);
    const denied = Object.assign(
      new Error('permission denied for table pg_subscription'),
      { code: '42501' },
    );
    // The subscription query must reject; everything after it must still
    // run normally. We use a stateful counter on the matcher to ensure
    // only the subscription query fails.
    const conn: Connection = {
      ...mkConnection([
        { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
        tableInfoMatch(),
        { match: () => true, rs: empty },
      ]),
      query: vi.fn((sql: string) => {
        if (
          sql.includes('FROM pg_catalog.pg_subscription') &&
          sql.includes('pg_subscription_rel')
        ) {
          return Promise.reject(denied);
        }
        if (sql.includes('FROM pg_catalog.pg_attribute')) {
          return Promise.resolve(cols);
        }
        if (sql.includes('c.relreplident')) {
          return Promise.resolve(
            mkResultSet(
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
              [['f', 'f', 'd', 'f', 0, 0, null, null]],
            ),
          );
        }
        return Promise.resolve(empty);
      }) as Connection['query'],
    };
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
    expect(cap.text()).not.toContain('Subscriptions:');
  });

  it('renders per-column FDW options inline on the columns table', async () => {
    // Foreign table with three columns; c1 and c3 carry per-column FDW
    // options, c2 does not. Round 3 polish moved this from a `Per-column
    // FDW options:` footer to a trailing `FDW options` cell in the
    // columns table.
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
        ['c1', 'text', null, 'f', null, '', ''],
        ['c2', 'integer', null, 'f', null, '', ''],
        ['c3', 'text', null, 'f', null, '', ''],
      ],
    );
    const ftInfo = mkResultSet(
      ['srvname', 'ftoptions'],
      [['srv1', "table_name 'remote_t'"]],
    );
    const colOpts = mkResultSet(
      ['attname', 'opts'],
      [
        ['c1', "column_name 'remote_c1'"],
        ['c3', "column_name 'remote_c3', max_length '32'"],
      ],
    );
    const empty = mkResultSet([], []);
    // The per-column FDW options query reaches `FROM pg_catalog.pg_attribute a`
    // (with a trailing 'a') AND filters on `a.attfdwoptions IS NOT NULL`.
    // We route to `colOpts` based on the IS NOT NULL clause.
    const conn = mkConnection([
      {
        match: (s) => s.includes('a.attfdwoptions IS NOT NULL'),
        rs: colOpts,
      },
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
    // The "FDW options" column header is added to the columns table…
    expect(text).toContain('FDW options');
    // …and each annotated column carries its options on the same row
    // with parens.
    expect(text).toContain("(column_name 'remote_c1')");
    expect(text).toContain("(column_name 'remote_c3', max_length '32')");
    // c2 has no per-column options — it should still appear in the
    // table but with an empty FDW-options cell.
    expect(text).toContain('c2');
    // Footer rendering removed: no separate "Per-column FDW options:"
    // section any more.
    expect(text).not.toContain('Per-column FDW options:');
    // Server-level FDW options footer is still rendered.
    expect(text).toContain('Server: srv1');
    expect(text).toContain("FDW options: (table_name 'remote_t')");
  });

  it('renders Owning table footer for TOAST relation', async () => {
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
      [['chunk_id', 'oid', null, 't', null, '', '']],
    );
    const owner = mkResultSet(['nspname', 'relname'], [['public', 'foo']]);
    const empty = mkResultSet([], []);
    const conn = mkConnection([
      { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
      tableInfoMatch(),
      {
        match: (s) =>
          s.includes('FROM pg_catalog.pg_class') && s.includes('reltoastrelid'),
        rs: owner,
      },
      { match: () => true, rs: empty },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'pg_toast',
      'pg_toast_12345',
      't',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('TOAST table "pg_toast.pg_toast_12345"');
    expect(text).toContain('Owning table: "public.foo"');
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
    const r = await lookupOneRelation(conn, 'nope');
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
    const r = await lookupOneRelation(conn, 'users');
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
    await lookupOneRelation(wrappedConn, 'pg_catalog.pg_class');
    expect(queryCalls[0]).toMatch(/n\.nspname OPERATOR\(pg_catalog\.~\)/);
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
    await lookupOneRelation(wrappedConn, 'foo');
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

// ---------------------------------------------------------------------------
// \d / \d+ PG18 parity: view-definition gating, Compression column,
// view verbose columns, Not-null constraints footer.
// ---------------------------------------------------------------------------

describe('describeOneTableDetails — verbose Compression column', () => {
  // Verbose column result set: attname, type, default, attnotnull,
  // collation, identity, generated, storage, compression, stattarget,
  // description. The formatter reads storage at r[7], compression at
  // r[8] (when present), stats at the next slot, description last.
  const verboseColsWithCompression = (): ResultSet =>
    mkResultSet(
      [
        'attname',
        'type',
        'default',
        'attnotnull',
        'collation',
        'identity',
        'generated',
        'attstorage',
        'attcompression',
        'attstattarget',
        'description',
      ],
      [['id', 'integer', null, 't', null, '', '', 'plain', 'pglz', null, null]],
    );

  it('includes Compression column in verbose mode for a regular table (PG14+, HIDE off)', async () => {
    const conn = mkConnection([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_attribute'),
        rs: verboseColsWithCompression(),
      },
      tableInfoMatch(),
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'acct',
      'r',
      true,
      cap.out,
      defaultPopt(),
      false, // hideTableam
      false, // hideCompression
    );
    const text = cap.text();
    expect(text).toContain('Storage');
    expect(text).toContain('Compression');
    expect(text).toContain('pglz');
  });

  it('suppresses Compression column when HIDE_TOAST_COMPRESSION is on', async () => {
    // With hideCompression=true the column SQL omits attcompression, so
    // the result set has no compression slot; storage at r[7], stats at
    // r[8], description at r[9].
    const colsNoCompression = mkResultSet(
      [
        'attname',
        'type',
        'default',
        'attnotnull',
        'collation',
        'identity',
        'generated',
        'attstorage',
        'attstattarget',
        'description',
      ],
      [['id', 'integer', null, 't', null, '', '', 'plain', null, null]],
    );
    const conn = mkConnection([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_attribute'),
        rs: colsNoCompression,
      },
      tableInfoMatch(),
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'acct',
      'r',
      true,
      cap.out,
      defaultPopt(),
      false, // hideTableam
      true, // hideCompression
    );
    const text = cap.text();
    expect(text).toContain('Storage');
    expect(text).not.toContain('Compression');
  });

  it('omits Compression column in non-verbose mode', async () => {
    const conn = mkConnection([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_attribute'),
        rs: boringCols2(),
      },
      tableInfoMatch(),
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'acct',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).not.toContain('Compression');
    expect(text).not.toContain('Storage');
  });
});

describe('describeOneTableDetails — Not-null constraints footer (PG18)', () => {
  const pg18Conn = (
    responses: { match: (sql: string) => boolean; rs: ResultSet }[],
  ): Connection => ({ ...mkConnection(responses), serverVersion: 180000 });

  it('renders Not-null constraints footer in verbose mode (PG18)', async () => {
    const notnull = mkResultSet(
      ['conname', 'attname', 'connoinherit', 'conislocal'],
      [
        ['acct_id_not_null', 'id', 'f', 't'],
        ['acct_name_not_null', 'name', 'f', 't'],
      ],
    );
    const conn = pg18Conn([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_attribute'),
        rs: boringCols2(),
      },
      tableInfoMatch(),
      { match: (s) => s.includes("co.contype = 'n'"), rs: notnull },
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'acct',
      'r',
      true,
      cap.out,
      defaultPopt(),
    );
    const text = cap.text();
    expect(text).toContain('Not-null constraints:');
    expect(text).toContain('"acct_id_not_null" NOT NULL "id"');
    expect(text).toContain('"acct_name_not_null" NOT NULL "name"');
  });

  it('omits Not-null constraints footer in non-verbose mode', async () => {
    const conn = pg18Conn([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_attribute'),
        rs: boringCols2(),
      },
      tableInfoMatch(),
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneTableDetails(
      conn,
      1,
      'public',
      'acct',
      'r',
      false,
      cap.out,
      defaultPopt(),
    );
    expect(cap.text()).not.toContain('Not-null constraints:');
  });
});

describe('describeOneViewDetails — view definition gating + verbose columns', () => {
  const viewCols = (verbose: boolean): ResultSet =>
    verbose
      ? mkResultSet(
          [
            'attname',
            'type',
            'default',
            'attnotnull',
            'collation',
            'identity',
            'generated',
            'attstorage',
            'attstattarget',
            'description',
          ],
          [['id', 'integer', null, 'f', null, '', '', 'plain', null, 'a col']],
        )
      : mkResultSet(
          [
            'attname',
            'type',
            'default',
            'attnotnull',
            'collation',
            'identity',
            'generated',
          ],
          [['id', 'integer', null, 'f', null, '', '']],
        );

  it('does NOT print View definition in plain (non-verbose) \\d <view>', async () => {
    const conn = mkConnection([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_attribute'),
        rs: viewCols(false),
      },
      tableInfoMatch(),
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneViewDetails(
      conn,
      1,
      'public',
      'acct_v',
      cap.out,
      defaultPopt(),
      false,
    );
    const text = cap.text();
    expect(text).toContain('View "public.acct_v"');
    expect(text).not.toContain('View definition:');
    // No verbose-only Storage/Description columns either.
    expect(text).not.toContain('Storage');
  });

  it('prints View definition AND Storage/Description columns in verbose \\d+ <view>', async () => {
    const viewdef = mkResultSet(['def'], [['SELECT acct.id FROM acct;']]);
    const conn = mkConnection([
      {
        match: (s) => s.includes('FROM pg_catalog.pg_attribute'),
        rs: viewCols(true),
      },
      tableInfoMatch(),
      { match: (s) => s.includes('pg_get_viewdef'), rs: viewdef },
      { match: () => true, rs: mkResultSet([], []) },
    ]);
    const cap = captureStream();
    await describeOneViewDetails(
      conn,
      1,
      'public',
      'acct_v',
      cap.out,
      defaultPopt(),
      true,
    );
    const text = cap.text();
    expect(text).toContain('View "public.acct_v"');
    expect(text).toContain('Storage');
    expect(text).toContain('Description');
    expect(text).toContain('View definition:');
    expect(text).toContain('SELECT acct.id FROM acct;');
    // Views never carry the Compression column even in verbose mode.
    expect(text).not.toContain('Compression');
  });
});
