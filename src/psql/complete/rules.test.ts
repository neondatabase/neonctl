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

  // COMP_KEYWORD_CASE honoured. Mirrors upstream's 010_tab_completion.pl
  // foreach loop over [lower, upper, preserve-lower, preserve-upper].
  it('COMP_KEYWORD_CASE=lower forces lowercase regardless of input case', async () => {
    const settings = makeSettings();
    settings.compCase = 'lower';
    const ctx = { settings };
    const r = await findCompletions([], 'SEL', ctx);
    expect(r.candidates).toContain('select');
    expect(r.candidates).not.toContain('SELECT');
  });

  it('COMP_KEYWORD_CASE=upper forces uppercase regardless of input case', async () => {
    const settings = makeSettings();
    settings.compCase = 'upper';
    const ctx = { settings };
    const r = await findCompletions([], 'sel', ctx);
    expect(r.candidates).toContain('SELECT');
    expect(r.candidates).not.toContain('select');
  });

  it('COMP_KEYWORD_CASE=preserve-lower keeps lowercase when user types lowercase', async () => {
    const settings = makeSettings();
    settings.compCase = 'preserve-lower';
    const ctx = { settings };
    const r = await findCompletions([], 'sel', ctx);
    expect(r.candidates).toContain('select');
  });

  it('COMP_KEYWORD_CASE=preserve-lower uppercases when user types uppercase', async () => {
    const settings = makeSettings();
    settings.compCase = 'preserve-lower';
    const ctx = { settings };
    const r = await findCompletions([], 'SEL', ctx);
    expect(r.candidates).toContain('SELECT');
  });

  it('COMP_KEYWORD_CASE=preserve-upper uppercases when user types uppercase', async () => {
    const settings = makeSettings();
    settings.compCase = 'preserve-upper';
    const ctx = { settings };
    const r = await findCompletions([], 'SEL', ctx);
    expect(r.candidates).toContain('SELECT');
  });

  it('COMP_KEYWORD_CASE=preserve-upper lowercases when user types lowercase', async () => {
    const settings = makeSettings();
    settings.compCase = 'preserve-upper';
    const ctx = { settings };
    const r = await findCompletions([], 'sel', ctx);
    expect(r.candidates).toContain('select');
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

  it('quoted prefix returns quoted relation candidates', async () => {
    // Quoted-input variant of the FROM completion. The completer rewrites
    // the query to a case-sensitive raw-relname LIKE; our mock matches by
    // substring against the FROM clause `pg_catalog.pg_class c`, so this
    // still resolves to the canned rows. Output candidates are wrapped in
    // `"..."` so the trailing space lands outside the quoted region.
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['mytab123', 'mytab246'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['SELECT', '*', 'FROM'], '"my', ctx);
    expect(r.candidates).toEqual(['"mytab123"', '"mytab246"']);
  });

  it('quoted mixed-case prefix matches preserving case', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['mixedName'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['SELECT', '*', 'FROM'], '"mi', ctx);
    expect(r.candidates).toEqual(['"mixedName"']);
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

// ---------------------------------------------------------------------------
// Deep ALTER sub-action completions.
// ---------------------------------------------------------------------------

describe('findCompletions: ALTER TABLE deep sub-actions', () => {
  it('ALTER TABLE foo → list of sub-actions', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'TABLE', 'foo'], '', ctx);
    expect(r.candidates).toContain('add');
    expect(r.candidates).toContain('drop');
    expect(r.candidates).toContain('rename');
    expect(r.candidates).toContain('set');
    expect(r.candidates).toContain('owner to');
    expect(r.candidates).toContain('replica identity');
    expect(r.candidates).toContain('validate constraint');
  });

  it('ALTER TABLE foo ADD → COLUMN, CONSTRAINT, CHECK', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'TABLE', 'foo', 'ADD'], '', ctx);
    expect(r.candidates).toContain('column');
    expect(r.candidates).toContain('constraint');
    expect(r.candidates).toContain('check');
    expect(r.candidates).toContain('foreign key');
  });

  it('ALTER TABLE foo DROP → COLUMN/CONSTRAINT/IF EXISTS', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'TABLE', 'foo', 'DROP'], '', ctx);
    expect(r.candidates).toContain('column');
    expect(r.candidates).toContain('constraint');
    expect(r.candidates).toContain('if exists');
  });

  it('ALTER TABLE foo ALTER → alter-column sub-actions', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['ALTER', 'TABLE', 'foo', 'ALTER'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('set default');
    expect(r.candidates).toContain('drop not null');
    expect(r.candidates).toContain('set data type');
  });

  it('ALTER TABLE foo RENAME → TO/COLUMN/CONSTRAINT', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['ALTER', 'TABLE', 'foo', 'RENAME'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('column');
    expect(r.candidates).toContain('to');
  });

  it('ALTER TABLE foo ENABLE → ROW LEVEL SECURITY, TRIGGER, RULE', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['ALTER', 'TABLE', 'foo', 'ENABLE'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('row level security');
    expect(r.candidates).toContain('trigger');
    expect(r.candidates).toContain('rule');
  });

  it('ALTER TABLE foo REPLICA IDENTITY → DEFAULT/FULL/NOTHING/USING INDEX', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['ALTER', 'TABLE', 'foo', 'REPLICA', 'IDENTITY'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('default');
    expect(r.candidates).toContain('full');
    expect(r.candidates).toContain('nothing');
    expect(r.candidates).toContain('using index');
  });
});

describe('findCompletions: ALTER other objects deep sub-actions', () => {
  it('ALTER VIEW foo → ALTER/RENAME/SET/OWNER TO', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'VIEW', 'foo'], '', ctx);
    expect(r.candidates).toContain('alter');
    expect(r.candidates).toContain('rename');
    expect(r.candidates).toContain('set');
    expect(r.candidates).toContain('owner to');
  });

  it('ALTER MATERIALIZED VIEW foo → CLUSTER ON/RENAME etc.', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['ALTER', 'MATERIALIZED', 'VIEW', 'foo'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('cluster on');
    expect(r.candidates).toContain('rename');
    expect(r.candidates).toContain('owner to');
  });

  it('ALTER INDEX foo → RENAME/SET/ATTACH PARTITION', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'INDEX', 'foo'], '', ctx);
    expect(r.candidates).toContain('rename');
    expect(r.candidates).toContain('set');
    expect(r.candidates).toContain('attach partition');
  });

  it('ALTER SEQUENCE foo → INCREMENT BY/RESTART/OWNED BY', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'SEQUENCE', 'foo'], '', ctx);
    expect(r.candidates).toContain('increment by');
    expect(r.candidates).toContain('restart');
    expect(r.candidates).toContain('owned by');
  });

  it('ALTER FUNCTION foo → COST/IMMUTABLE/VOLATILE/STABLE', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'FUNCTION', 'foo'], '', ctx);
    expect(r.candidates).toContain('cost');
    expect(r.candidates).toContain('immutable');
    expect(r.candidates).toContain('volatile');
    expect(r.candidates).toContain('stable');
  });

  it('ALTER TYPE foo → ADD VALUE/RENAME ATTRIBUTE', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'TYPE', 'foo'], '', ctx);
    expect(r.candidates).toContain('add value');
    expect(r.candidates).toContain('rename attribute');
    expect(r.candidates).toContain('set schema');
  });

  it('ALTER ROLE alice → PASSWORD/SUPERUSER/RENAME TO', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'ROLE', 'alice'], '', ctx);
    expect(r.candidates).toContain('password');
    expect(r.candidates).toContain('superuser');
    expect(r.candidates).toContain('rename to');
  });

  it('ALTER USER alice → equivalent to ROLE', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'USER', 'alice'], '', ctx);
    expect(r.candidates).toContain('password');
    expect(r.candidates).toContain('login');
  });

  it('ALTER DATABASE mydb → OWNER TO/RENAME TO/CONNECTION LIMIT', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'DATABASE', 'mydb'], '', ctx);
    expect(r.candidates).toContain('owner to');
    expect(r.candidates).toContain('rename to');
    expect(r.candidates).toContain('connection limit');
  });

  it('ALTER SCHEMA public → OWNER TO/RENAME TO', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'SCHEMA', 'public'], '', ctx);
    expect(r.candidates).toEqual(['owner to', 'rename to']);
  });

  it('ALTER EXTENSION pg_trgm → ADD/DROP/UPDATE/SET SCHEMA', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'EXTENSION', 'pg_trgm'], '', ctx);
    expect(r.candidates).toContain('add');
    expect(r.candidates).toContain('drop');
    expect(r.candidates).toContain('set schema');
    expect(r.candidates).toContain('update');
  });

  it('ALTER POLICY mypol → ON/RENAME TO', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'POLICY', 'mypol'], '', ctx);
    expect(r.candidates).toEqual(['on', 'rename to']);
  });

  it('ALTER PUBLICATION mypub → ADD/DROP/SET/RENAME', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['ALTER', 'PUBLICATION', 'mypub'], '', ctx);
    expect(r.candidates).toContain('add');
    expect(r.candidates).toContain('drop');
    expect(r.candidates).toContain('set');
    expect(r.candidates).toContain('rename to');
  });

  it('ALTER SUBSCRIPTION mysub → ENABLE/DISABLE/CONNECTION', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['ALTER', 'SUBSCRIPTION', 'mysub'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('enable');
    expect(r.candidates).toContain('disable');
    expect(r.candidates).toContain('connection');
  });
});

// ---------------------------------------------------------------------------
// GUC-name completion for SET / SHOW / RESET.
// ---------------------------------------------------------------------------

describe('findCompletions: GUC names via pg_settings', () => {
  it('SET <prefix> → GUC names', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_settings': ['work_mem', 'maintenance_work_mem'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['SET'], 'work', ctx);
    expect(r.candidates).toContain('work_mem');
  });

  it('SET w → mixes built-in SET sub-keywords with GUCs', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_settings': ['work_mem'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['SET'], 'w', ctx);
    expect(r.candidates).toContain('work_mem');
  });

  it('SHOW <prefix> → GUC names + ALL', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_settings': ['client_encoding', 'client_min_messages'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['SHOW'], 'client_', ctx);
    expect(r.candidates).toContain('client_encoding');
    expect(r.candidates).toContain('client_min_messages');
  });

  it('SHOW A → includes ALL', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_settings': [],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['SHOW'], 'A', ctx);
    expect(r.candidates).toContain('ALL');
  });

  it('RESET <prefix> → GUC names + ALL', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_settings': ['statement_timeout'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['RESET'], 'state', ctx);
    expect(r.candidates).toContain('statement_timeout');
  });

  it('SET work_mem → TO (upstream tab-complete.in.c emits just TO)', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['SET', 'work_mem'], '', ctx);
    expect(r.candidates).toContain('to');
    // `=` is valid SET syntax but upstream completes to `TO` only —
    // a single unique candidate so `set foo<tab><tab>` resolves to
    // `set foo TO ` rather than listing two near-synonymous separators.
    expect(r.candidates).not.toContain('=');
  });

  it('SET DateStyle TO → ISO/GERMAN/SQL/POSTGRES', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['SET', 'DateStyle', 'TO'], '', ctx);
    expect(r.candidates).toContain('iso');
    expect(r.candidates).toContain('german');
    expect(r.candidates).toContain('sql');
    expect(r.candidates).toContain('postgres');
  });
});

// ---------------------------------------------------------------------------
// CREATE INDEX deep handling.
// ---------------------------------------------------------------------------

describe('findCompletions: CREATE INDEX', () => {
  it('CREATE INDEX → CONCURRENTLY/IF NOT EXISTS/ON', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['CREATE', 'INDEX'], '', ctx);
    expect(r.candidates).toContain('concurrently');
    expect(r.candidates).toContain('if not exists');
    expect(r.candidates).toContain('on');
  });

  it('CREATE INDEX myidx → ON', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['CREATE', 'INDEX', 'myidx'], '', ctx);
    expect(r.candidates).toEqual(['on']);
  });

  it('CREATE INDEX myidx ON → tables', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['users', 'orders'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(
      ['CREATE', 'INDEX', 'myidx', 'ON'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('users');
    expect(r.candidates).toContain('orders');
  });

  it('CREATE INDEX myidx ON t USING → access methods (with conn)', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_am': ['btree', 'hash', 'gist', 'gin'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(
      ['CREATE', 'INDEX', 'myidx', 'ON', 't', 'USING'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('btree');
    expect(r.candidates).toContain('hash');
    expect(r.candidates).toContain('gist');
    expect(r.candidates).toContain('gin');
  });

  it('CREATE INDEX myidx ON t USING → fallback to built-in AMs without conn', async () => {
    const ctx = { settings: makeSettings(null) };
    const r = await findCompletions(
      ['CREATE', 'INDEX', 'myidx', 'ON', 't', 'USING'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('btree');
    expect(r.candidates).toContain('hash');
    expect(r.candidates).toContain('gist');
    expect(r.candidates).toContain('gin');
    expect(r.candidates).toContain('brin');
  });

  it('CREATE UNIQUE INDEX → CONCURRENTLY/IF NOT EXISTS/ON', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['CREATE', 'UNIQUE', 'INDEX'], '', ctx);
    expect(r.candidates).toContain('concurrently');
    expect(r.candidates).toContain('on');
  });
});

// ---------------------------------------------------------------------------
// Post-FROM tail keywords and JOIN ON/USING.
// ---------------------------------------------------------------------------

describe('findCompletions: post-FROM tail keywords', () => {
  it('SELECT * FROM t → JOIN, WHERE, GROUP BY, ORDER BY, LIMIT', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['SELECT', '*', 'FROM', 'users'], '', ctx);
    expect(r.candidates).toContain('join');
    expect(r.candidates).toContain('where');
    expect(r.candidates).toContain('group by');
    expect(r.candidates).toContain('order by');
    expect(r.candidates).toContain('limit');
  });

  it('SELECT … FROM t W → completes WHERE', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['SELECT', '*', 'FROM', 'users'], 'W', ctx);
    expect(r.candidates).toContain('WHERE');
    expect(r.candidates).toContain('WINDOW');
  });

  it('JOIN users → ON / USING', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['SELECT', '*', 'FROM', 'orders', 'JOIN', 'users'],
      '',
      ctx,
    );
    expect(r.candidates).toEqual(['on', 'using']);
  });

  it('SELECT … FROM t WHERE id → AND/OR/IS/IN/LIKE/NOT/BETWEEN', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['SELECT', '*', 'FROM', 'users', 'WHERE', 'id'],
      '',
      ctx,
    );
    expect(r.candidates).toContain('and');
    expect(r.candidates).toContain('or');
    expect(r.candidates).toContain('is');
    expect(r.candidates).toContain('in');
    expect(r.candidates).toContain('like');
    expect(r.candidates).toContain('between');
  });
});

// ---------------------------------------------------------------------------
// Window function clauses.
// ---------------------------------------------------------------------------

describe('findCompletions: window functions', () => {
  it('… OVER ( → PARTITION BY / ORDER BY / ROWS / RANGE / GROUPS', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(
      ['SELECT', 'ROW_NUMBER', '(', ')', 'OVER', '('],
      '',
      ctx,
    );
    expect(r.candidates).toContain('partition by');
    expect(r.candidates).toContain('order by');
    expect(r.candidates).toContain('rows');
    expect(r.candidates).toContain('range');
    expect(r.candidates).toContain('groups');
  });
});

// ---------------------------------------------------------------------------
// \do and \dC operator/cast completion.
// ---------------------------------------------------------------------------

describe('findCompletions: \\do / \\dC', () => {
  it('\\do <prefix> → operators', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_operator': ['||', '!='],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\do'], '', ctx);
    expect(r.candidates).toContain('||');
    expect(r.candidates).toContain('!=');
  });

  it('\\dC <prefix> → cast pairs', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_cast': ['integer AS bigint', 'text AS varchar'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['\\dC'], '', ctx);
    expect(r.candidates).toContain('integer AS bigint');
    expect(r.candidates).toContain('text AS varchar');
  });

  it('\\do without connection returns empty', async () => {
    const ctx = { settings: makeSettings(null) };
    const r = await findCompletions(['\\do'], '', ctx);
    expect(r.candidates).toEqual([]);
  });
});

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

// ---------------------------------------------------------------------------
// DROP TYPE → built-in scalar type keywords + user types
// (upstream tab-complete.in.c: Keywords_for_list_of_datatypes mixed in via
// Query_for_list_of_datatypes). Mirrors the 010_tab_completion.pl line 328
// `DROP TYPE big<TAB>` → `DROP TYPE bigint` subtest.
// ---------------------------------------------------------------------------

describe('findCompletions: DROP TYPE with built-in datatype keywords', () => {
  it('completes DROP TYPE big → bigint (built-in keyword, no catalog row needed)', async () => {
    const ctx = { settings: makeSettings(null) };
    const r = await findCompletions(['DROP', 'TYPE'], 'big', ctx);
    expect(r.candidates).toContain('bigint');
  });

  it('completes DROP TYPE int → integer (built-in keyword)', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['DROP', 'TYPE'], 'int', ctx);
    expect(r.candidates).toContain('integer');
  });

  it('merges built-in keywords with catalog rows', async () => {
    // The mock returns `bigint` from pg_type — exercising both code paths
    // (keyword + catalog). Result is allowed to contain duplicates; the
    // psqlCompleter wrapper de-dupes.
    const conn = makeMockConn({
      'pg_catalog.pg_type': ['myudt'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['DROP', 'TYPE'], '', ctx);
    expect(r.candidates).toContain('bigint');
    expect(r.candidates).toContain('myudt');
  });

  it('falls back to keyword list when no connection is available', async () => {
    const ctx = { settings: makeSettings(null) };
    const r = await findCompletions(['DROP', 'TYPE'], '', ctx);
    expect(r.candidates).toContain('bigint');
    expect(r.candidates).toContain('boolean');
  });
});

// ---------------------------------------------------------------------------
// CREATE multi-word completion: `CREATE TY<TAB>` → `CREATE TYPE` falls out
// of the existing `TailMatches(['CREATE'])` arm filtering CREATE_OBJECTS by
// the in-progress current word — confirm with a pinned assertion (mirrors
// 010_tab_completion.pl line 336).
// ---------------------------------------------------------------------------

describe('findCompletions: CREATE <prefix> picks sub-object keyword', () => {
  it('CREATE TY → TYPE (unique match)', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['CREATE'], 'TY', ctx);
    expect(r.candidates).toContain('TYPE');
    expect(r.candidates).not.toContain('TABLE');
  });

  it('CREATE T → TABLE, TYPE, TRIGGER, ... (multiple matches)', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['CREATE'], 'T', ctx);
    expect(r.candidates).toContain('TABLE');
    expect(r.candidates).toContain('TYPE');
    expect(r.candidates).toContain('TRIGGER');
  });

  it('CREATE TYP → TYPE only', async () => {
    const ctx = { settings: makeSettings() };
    const r = await findCompletions(['CREATE'], 'TYP', ctx);
    expect(r.candidates).toEqual(['TYPE']);
  });
});

// ---------------------------------------------------------------------------
// CREATE TABLE <prefix> — words_after_create hint: surface existing table
// names so the user can pick a similar one. Mirrors 010_tab_completion.pl
// line 344 `CREATE TABLE mytab<tab><tab>` → `mytab123 mytab246` listing.
// ---------------------------------------------------------------------------

describe('findCompletions: CREATE TABLE name hints via existing tables', () => {
  it('CREATE TABLE mytab → mytab123, mytab246 (existing-table hint)', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['mytab123', 'mytab246'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['CREATE', 'TABLE'], 'mytab', ctx);
    expect(r.candidates).toContain('mytab123');
    expect(r.candidates).toContain('mytab246');
  });

  it('CREATE TABLE → all existing tables (empty prefix)', async () => {
    const conn = makeMockConn({
      'pg_catalog.pg_class': ['users', 'orders'],
    });
    const ctx = { settings: makeSettings(conn) };
    const r = await findCompletions(['CREATE', 'TABLE'], '', ctx);
    expect(r.candidates).toContain('users');
    expect(r.candidates).toContain('orders');
  });

  it('CREATE TABLE returns empty list without a connection', async () => {
    const ctx = { settings: makeSettings(null) };
    const r = await findCompletions(['CREATE', 'TABLE'], 'foo', ctx);
    expect(r.candidates).toEqual([]);
  });
});
