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
