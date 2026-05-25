import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { BackslashContext } from '../types/backslash.js';
import type { Connection, ResultSet } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import { createBackslashRegistry } from './dispatch.js';
import { registerDescribeCommands } from './cmd_describe.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

type QuerySpy = { sql: string; params: unknown[] };

const mkConnection = (
  responses: { match: (sql: string) => boolean; rs: ResultSet }[],
  spy?: QuerySpy[],
): Connection => ({
  serverVersion: 170000,
  parameterStatus: () => undefined,
  query: ((sql: string, params?: unknown[]) => {
    spy?.push({ sql, params: params ?? [] });
    const found = responses.find((r) => r.match(sql));
    if (!found) {
      return Promise.reject(
        new Error(`mock: unexpected sql: ${sql.slice(0, 120)}`),
      );
    }
    return Promise.resolve(found.rs);
  }) as Connection['query'],
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
});

const mkSettings = (db: Connection | null): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  s.db = db;
  return s;
};

const mkCtx = (
  cmdName: string,
  rawArgs: string,
  settings: PsqlSettings,
): BackslashContext => {
  let cursor = 0;
  return {
    settings,
    cmdName,
    queryBuf: '',
    rawArgs,
    nextArg: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      if (cursor >= rawArgs.length) return null;
      const start = cursor;
      while (cursor < rawArgs.length && !/\s/.test(rawArgs[cursor])) cursor++;
      return rawArgs.slice(start, cursor);
    },
    restOfLine: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      const tail = rawArgs.slice(cursor);
      cursor = rawArgs.length;
      return tail;
    },
  };
};

// stdout/stderr capture.
let stdoutChunks: string[];
let stderrChunks: string[];
let stdoutOrig: typeof process.stdout.write;
let stderrOrig: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  stdoutOrig = process.stdout.write.bind(process.stdout);
  stderrOrig = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = stdoutOrig;
  process.stderr.write = stderrOrig;
});

const buildRegistry = () => {
  const r = createBackslashRegistry();
  registerDescribeCommands(r);
  return r;
};

/** Look up a spec by name; fail the test if absent. */
const mustLookup = (r: ReturnType<typeof buildRegistry>, name: string) => {
  const spec = r.lookup(name);
  if (!spec) throw new Error(`registry: spec not found: ${name}`);
  return spec;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cmd_describe', () => {
  it('connection guard: \\dt with null db returns error', async () => {
    const r = buildRegistry();
    const spec = mustLookup(r, 'dt');
    expect(spec).toBeDefined();
    const settings = mkSettings(null);
    const ctx = mkCtx('dt', '', settings);
    const res = await spec.run(ctx);
    expect(res.status).toBe('error');
    expect(stderrChunks.join('')).toContain('no current connection');
  });

  it('\\dt lists tables with the listTables query', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_class'),
          rs: mkResultSet(
            ['Schema', 'Name', 'Type', 'Owner'],
            [['public', 'users', 'table', 'alice']],
          ),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'dt');
    const ctx = mkCtx('dt', '', mkSettings(conn));
    const res = await spec.run(ctx);
    expect(res.status).toBe('ok');
    expect(spy[0].sql).toContain('c.relkind IN');
    expect(stdoutChunks.join('')).toContain('users');
  });

  it('\\dt+ adds verbose columns to the query', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_class'),
          rs: mkResultSet(['Schema', 'Name'], []),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'dt+');
    expect(spec).toBeDefined();
    const ctx = mkCtx('dt+', '', mkSettings(conn));
    await spec.run(ctx);
    expect(spy[0].sql).toContain('Size');
  });

  it('\\dtS includes system tables in WHERE', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_class'),
          rs: mkResultSet(['Schema', 'Name'], []),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'dtS');
    expect(spec).toBeDefined();
    const ctx = mkCtx('dtS', '', mkSettings(conn));
    await spec.run(ctx);
    // showSystem branch in listTables drops the "n.nspname <> 'pg_catalog'"
    // filter, so we shouldn't see that string in the emitted SQL.
    expect(spy[0].sql).not.toContain("n.nspname <> 'pg_catalog'");
  });

  it('\\d <name> dispatches to detail renderer for relkind r', async () => {
    const spy: QuerySpy[] = [];
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
      [['id', 'integer', null, 't', null, '', '']],
    );
    const conn = mkConnection(
      [
        // lookupOneRelation
        {
          match: (s) =>
            s.includes('FROM pg_catalog.pg_class') && s.includes('c.relkind'),
          rs: mkResultSet(
            ['oid', 'nspname', 'relname', 'relkind'],
            [[1, 'public', 'foo', 'r']],
          ),
        },
        // describeOneTableDetails column query
        { match: (s) => s.includes('FROM pg_catalog.pg_attribute'), rs: cols },
        // every other follow-up returns empty
        { match: () => true, rs: mkResultSet([], []) },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'd');
    const ctx = mkCtx('d', 'foo', mkSettings(conn));
    const res = await spec.run(ctx);
    expect(res.status).toBe('ok');
    expect(stdoutChunks.join('')).toContain('Table "public.foo"');
  });

  it('\\d <wildcard> goes through list path, not detail', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_class'),
          rs: mkResultSet(['oid', 'Schema', 'Name'], []),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'd');
    const ctx = mkCtx('d', 'foo*', mkSettings(conn));
    await spec.run(ctx);
    // The * triggers list mode; we don't hit lookupOneRelation's
    // visibility-check shape.
    expect(spy[0].sql).toContain('OPERATOR(pg_catalog.~)');
  });

  it('\\d with no args runs the list query', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_class'),
          rs: mkResultSet(['oid', 'Schema', 'Name'], []),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'd');
    const ctx = mkCtx('d', '', mkSettings(conn));
    const res = await spec.run(ctx);
    expect(res.status).toBe('ok');
    expect(spy.length).toBeGreaterThan(0);
  });

  it('\\df runs describeFunctions and matches functions', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('pg_catalog.pg_proc'),
          rs: mkResultSet(['Schema', 'Name'], []),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'df');
    const ctx = mkCtx('df', '', mkSettings(conn));
    const res = await spec.run(ctx);
    expect(res.status).toBe('ok');
    expect(spy[0].sql).toContain('FROM pg_catalog.pg_proc');
  });

  it('\\dn lists schemas', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_namespace'),
          rs: mkResultSet(['Name', 'Owner'], [['public', 'alice']]),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'dn');
    const ctx = mkCtx('dn', '', mkSettings(conn));
    const res = await spec.run(ctx);
    expect(res.status).toBe('ok');
    expect(stdoutChunks.join('')).toContain('public');
  });

  it('\\l lists databases', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_database'),
          rs: mkResultSet(['Name'], [['postgres']]),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'l');
    const ctx = mkCtx('l', '', mkSettings(conn));
    const res = await spec.run(ctx);
    expect(res.status).toBe('ok');
    expect(stdoutChunks.join('')).toContain('postgres');
  });

  it('\\dx lists extensions', async () => {
    const spy: QuerySpy[] = [];
    const conn = mkConnection(
      [
        {
          match: (s) => s.includes('FROM pg_catalog.pg_extension'),
          rs: mkResultSet(['Name', 'Version'], [['plpgsql', '1.0']]),
        },
      ],
      spy,
    );
    const r = buildRegistry();
    const spec = mustLookup(r, 'dx');
    const ctx = mkCtx('dx', '', mkSettings(conn));
    const res = await spec.run(ctx);
    expect(res.status).toBe('ok');
    expect(stdoutChunks.join('')).toContain('plpgsql');
  });

  it('unknown command name returns undefined in lookup', () => {
    const r = buildRegistry();
    expect(r.lookup('nope')).toBeUndefined();
  });
});
