import { describe, it, expect } from 'vitest';

import type { Connection, ResultSet } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import { psqlCompleter } from './index.js';
import { findCompletions } from './rules.js';

// ---------------------------------------------------------------------------
// Mock Connection: a tiny stub that pattern-matches against the SQL string
// the rule engine sends. Any unmatched SQL returns an empty rowset.
// ---------------------------------------------------------------------------

type Canned = Record<string, string[]>;

const makeRs = (rows: string[]): ResultSet => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: null,
  fields: [
    {
      name: 'name',
      tableID: 0,
      columnID: 0,
      dataTypeID: 25,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: 0,
    },
  ],
  rows: rows.map((r) => [r]),
  notices: [],
});

const makeMockConn = (canned: Canned): Connection => ({
  serverVersion: 160000,
  parameterStatus: () => undefined,
  query: (sql: string, params?: unknown[]) => {
    // Find a key that is a substring of sql.
    for (const key of Object.keys(canned)) {
      if (sql.includes(key)) {
        const last =
          params && params.length > 0 ? params[params.length - 1] : '';
        const pattern = typeof last === 'string' ? last : '';
        const all = canned[key];
        const like = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern;
        const filtered = all.filter((r) =>
          r.toLowerCase().startsWith(like.toLowerCase()),
        );
        return Promise.resolve(makeRs(filtered));
      }
    }
    return Promise.resolve(makeRs([]));
  },
  execSimple: () => Promise.resolve([]),
  prepare: () => Promise.reject(new Error('not impl')),
  startCopyIn: () => Promise.reject(new Error('not impl')),
  startCopyOut: () => Promise.reject(new Error('not impl')),
  pipeline: () => {
    throw new Error('not impl');
  },
  cancel: () => Promise.resolve(),
  escapeIdentifier: (v) => '"' + v.replace(/"/g, '""') + '"',
  escapeLiteral: (v) => "'" + v.replace(/'/g, "''") + "'",
  onNotice: () => () => undefined,
  onNotification: () => () => undefined,
  close: () => Promise.resolve(),
  isClosed: () => false,
});

const makeSettings = (db: Connection | null = null): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  s.db = db;
  return s;
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('findCompletions: backslash command names', () => {
  it('completes \\d to all backslash commands starting with \\d', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], '\\d', ctx);
    expect(r.candidates.length).toBeGreaterThan(5);
    expect(r.candidates).toContain('\\dt');
    expect(r.candidates).toContain('\\df');
    expect(r.candidates).toContain('\\du');
    // None should fail to start with \d.
    for (const c of r.candidates) {
      expect(c.toLowerCase().startsWith('\\d')).toBe(true);
    }
  });

  it('completes \\c to commands beginning with \\c', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], '\\c', ctx);
    expect(r.candidates).toContain('\\c');
    expect(r.candidates).toContain('\\connect');
    expect(r.candidates).toContain('\\copy');
  });

  it('returns no candidates for nonsense prefix', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], '\\xyznotacmd', ctx);
    expect(r.candidates).toEqual([]);
  });
});

describe('findCompletions: SQL keyword completion at start of statement', () => {
  it('completes SE → SELECT (among others)', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], 'SE', ctx);
    expect(r.candidates).toContain('SELECT');
  });

  it('completes empty prefix to the full keyword list (lowercased by default)', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], '', ctx);
    expect(r.candidates).toContain('select');
    expect(r.candidates).toContain('update');
    expect(r.candidates).toContain('insert into');
    expect(r.candidates).toContain('delete from');
  });

  it('keyword candidates are lowercased by default', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], 'sel', ctx);
    expect(r.candidates).toContain('select');
    expect(r.candidates).not.toContain('SELECT');
  });

  it('preserves uppercase when user types uppercase', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], 'SEL', ctx);
    expect(r.candidates).toContain('SELECT');
    expect(r.candidates).not.toContain('select');
  });
});

describe('findCompletions: catalog completion after FROM', () => {
  it('completes tables matching pg_c', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['pg_class', 'pg_constraint'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['SELECT', '*', 'FROM'], 'pg_c', ctx);
    expect(r.candidates).toEqual(['pg_class', 'pg_constraint']);
  });

  it('returns empty when no connection is available', async () => {
    const ctx = { settings: makeSettings(null) };
    const r = await findCompletions(['SELECT', '*', 'FROM'], 'pg_c', ctx);
    expect(r.candidates).toEqual([]);
  });

  it('completes UPDATE to tables', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['users', 'orders'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['UPDATE'], 'u', ctx);
    expect(r.candidates).toEqual(['users']);
  });

  it('completes DELETE FROM to tables', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['users', 'sessions'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['DELETE', 'FROM'], '', ctx);
    expect(r.candidates).toContain('users');
    expect(r.candidates).toContain('sessions');
  });

  it('completes ALTER TABLE to tables', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['users', 'orders'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['ALTER', 'TABLE'], '', ctx);
    expect(r.candidates).toContain('users');
    expect(r.candidates).toContain('orders');
  });
});

describe('findCompletions: backslash arg catalog completion', () => {
  it('\\c TAB → database names', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_database': ['neondb', 'postgres'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\c'], '', ctx);
    expect(r.candidates).toEqual(['neondb', 'postgres']);
  });

  it('\\connect <prefix> → database names matching prefix', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_database': ['neondb', 'mydb', 'postgres'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\connect'], 'my', ctx);
    expect(r.candidates).toEqual(['mydb']);
  });

  it('\\dn → schema names', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_namespace': ['public', 'pg_catalog'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\dn'], 'p', ctx);
    // findCompletions returns the raw catalog result (mock preserves input order);
    // psqlCompleter sorts later.
    expect(r.candidates.sort()).toEqual(['pg_catalog', 'public']);
  });

  it('\\df → function names', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_proc': ['now', 'nextval'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\df'], 'n', ctx);
    expect(r.candidates.sort()).toEqual(['nextval', 'now']);
  });

  it('\\du → role names', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_roles': ['alice', 'bob'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\du'], '', ctx);
    expect(r.candidates).toEqual(['alice', 'bob']);
  });

  it('\\dx → extension names', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_extension': ['plpgsql', 'postgis'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\dx'], 'p', ctx);
    expect(r.candidates).toEqual(['plpgsql', 'postgis']);
  });

  it('\\dt → tables', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['users'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\dt'], '', ctx);
    expect(r.candidates).toContain('users');
  });
});

describe('findCompletions: static-list backslash args', () => {
  it('\\pset → option names', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['\\pset'], 'f', ctx);
    expect(r.candidates).toContain('format');
    expect(r.candidates).toContain('fieldsep');
    expect(r.candidates).toContain('fieldsep_zero');
    expect(r.candidates).toContain('footer');
  });

  it('\\pset format → format values', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['\\pset', 'format'], '', ctx);
    expect(r.candidates).toContain('aligned');
    expect(r.candidates).toContain('csv');
    expect(r.candidates).toContain('wrapped');
  });

  it('\\encoding → encoding names', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['\\encoding'], 'U', ctx);
    expect(r.candidates).toContain('UTF8');
    expect(r.candidates).toContain('UHC');
  });

  it('\\set NAME → known special variables', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['\\set'], 'ON_', ctx);
    expect(r.candidates).toContain('ON_ERROR_STOP');
    expect(r.candidates).toContain('ON_ERROR_ROLLBACK');
  });

  it('\\set ON_ERROR_STOP → on/off values', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['\\set', 'ON_ERROR_STOP'], '', ctx);
    expect(r.candidates).toEqual(['on', 'off']);
  });
});

describe('findCompletions: empty input', () => {
  it('returns the top-level keyword set, not an empty list', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], '', ctx);
    expect(r.candidates.length).toBeGreaterThan(20);
  });
});

describe('findCompletions: variable expansion', () => {
  it(': prefix completes known variables', async () => {
    const settings = makeSettings();
    settings.vars.set('MY_VAR', 'value');
    const ctx = { settings };
    const r = await findCompletions([], ':MY', ctx);
    expect(r.candidates).toContain(':MY_VAR');
  });

  it('does not interpret :: as variable', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions([], '::', ctx);
    // Should NOT trigger var completion (returns top-level keywords instead).
    expect(r.candidates).not.toContain(':');
  });
});

// ---------------------------------------------------------------------------
// psqlCompleter integration.
// ---------------------------------------------------------------------------

describe('psqlCompleter wrapper', () => {
  it('returns the WP-24 CompletionResult shape', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['users', 'user_sessions'],
    });
    const c = psqlCompleter({ settings: makeSettings(conn) });
    const r = await c('SELECT * FROM us', 16);
    expect(r.candidates).toEqual(['user_sessions', 'users']);
    // Common prefix is 'user' (after sort: 'user_sessions' and 'users').
    expect(r.commonPrefix.toLowerCase()).toBe('user');
    expect(r.replaceLength).toBe(2);
  });

  it('returns commonPrefix=candidate when only one match', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['orders'],
    });
    const c = psqlCompleter({ settings: makeSettings(conn) });
    const r = await c('SELECT * FROM o', 15);
    expect(r.candidates).toEqual(['orders']);
    expect(r.commonPrefix).toBe('orders');
  });

  it('empty candidate list returns empty result, replaceLength=0 at empty buffer', async () => {
    const c = psqlCompleter({ settings: makeSettings() });
    const r = await c('', 0);
    // Top-level keyword list is non-empty; but for `\x` with no canned data we
    // get empty.
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.replaceLength).toBe(0);
  });

  it('re-reads ctx.settings.db on each call (no snapshotting)', async () => {
    const settings = makeSettings(null);
    const c = psqlCompleter({ settings });
    const r1 = await c('SELECT * FROM u', 15);
    expect(r1.candidates).toEqual([]);

    // Connect the DB after the completer was created.
    settings.db = makeMockConn({ 'pg_catalog.pg_class': ['users'] });
    const r2 = await c('SELECT * FROM u', 15);
    expect(r2.candidates).toEqual(['users']);
  });

  it('de-duplicates candidates', async () => {
    // Force a scenario where duplicate candidates could arise (TRUNCATE rule
    // mixes a keyword list with table names).
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['TABLE'],
    });
    const c = psqlCompleter({ settings: makeSettings(conn) });
    const r = await c('TRUNCATE TAB', 12);
    const tabCount = r.candidates.filter(
      (x) => x.toUpperCase() === 'TABLE',
    ).length;
    expect(tabCount).toBeLessThanOrEqual(2);
  });
});
