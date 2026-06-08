/**
 * `\sf`, `\sf+`, `\sv`, `\sv+`, `\ef`, `\ev` show-source command tests.
 *
 * Drives each `BackslashCmdSpec.run` directly with a mock {@link Connection}
 * that returns canned `pg_get_functiondef` / `pg_get_viewdef` shapes, and
 * captures the writes the command makes against `process.stdout` /
 * `process.stderr`. Coverage:
 *
 *   - Function lookup with bare name vs `name(int)` (regproc vs regprocedure).
 *   - View lookup via regclass; "not a view" relkind path emits the
 *     upstream-style error.
 *   - `+` modifier renders the upstream `%-7d %s\n` line-number format for
 *     body lines and `        %s\n` for function header lines.
 *   - Missing-name and no-connection paths return errors with the right
 *     `\<cmd>: …` stderr line.
 *   - `\ef` / `\ev` behave as show-with-hint (no editor invocation).
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { BackslashContext } from '../types/backslash.js';
import type { Connection, ResultSet } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  cmdEditFunction,
  cmdEditFunctionPlus,
  cmdEditView,
  cmdEditViewPlus,
  cmdShowFunction,
  cmdShowFunctionPlus,
  cmdShowView,
  cmdShowViewPlus,
  registerShowCommands,
} from './cmd_show.js';
import { createBackslashRegistry } from './dispatch.js';

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

const mkResultSet = (rows: unknown[][]): ResultSet => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: null,
  fields: rows[0]
    ? rows[0].map((_, i) => ({
        name: `c${i}`,
        tableID: 0,
        columnID: i + 1,
        dataTypeID: 25,
        dataTypeSize: -1,
        dataTypeModifier: -1,
        format: 0 as const,
      }))
    : [],
  rows,
  notices: [],
});

type Responder = {
  match: (sql: string) => boolean;
  result?: ResultSet;
  err?: Error;
};

const mkConn = (
  responders: Responder[],
  spy: { queries: string[] },
  serverVersion = 170000,
): Connection => ({
  serverVersion,
  parameterStatus: () => undefined,
  query: ((sql: string) => {
    spy.queries.push(sql);
    const found = responders.find((r) => r.match(sql));
    if (!found) {
      return Promise.reject(
        new Error(`mock: unexpected query: ${sql.slice(0, 120)}`),
      );
    }
    if (found.err) return Promise.reject(found.err);
    return Promise.resolve(found.result ?? mkResultSet([]));
  }) as Connection['query'],
  execSimple: () => Promise.reject(new Error('unused')),
  prepare: () => Promise.reject(new Error('unused')),
  startCopyIn: () => Promise.reject(new Error('unused')),
  startCopyOut: () => Promise.reject(new Error('unused')),
  pipeline: () => {
    throw new Error('unused');
  },
  cancel: () => Promise.resolve(),
  escapeIdentifier: (s) => `"${s.replace(/"/g, '""')}"`,
  escapeLiteral: (s) => `'${s.replace(/'/g, "''")}'`,
  onNotice: () => () => undefined,
  onNotification: () => () => undefined,
  close: () => Promise.resolve(),
  isClosed: () => false,
});

const mkSettings = (db: Connection | null): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  s.db = db;
  return s;
};

/**
 * Whole-line argument lexer: `restOfLine()` returns everything verbatim
 * after one pass of leading-whitespace trim, `nextArg()` returns the same
 * (the show commands use whole-line semantics so the two are aliases).
 */
const mkCtx = (
  cmdName: string,
  rawArgs: string,
  settings: PsqlSettings,
): BackslashContext => {
  let consumed = false;
  return {
    settings,
    cmdName,
    queryBuf: '',
    rawArgs,
    nextArg: (): string | null => {
      if (consumed) return null;
      consumed = true;
      return rawArgs.trimStart() || null;
    },
    restOfLine: (): string => {
      if (consumed) return '';
      consumed = true;
      return rawArgs.replace(/^\s+/, '');
    },
  };
};

let stdoutChunks: string[];
let stderrChunks: string[];
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    stdoutChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    stderrChunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
});

// ---------------------------------------------------------------------------
// \sf
// ---------------------------------------------------------------------------

describe('cmdShowFunction (\\sf)', () => {
  test('no connection → error', async () => {
    const ctx = mkCtx('sf', 'foo', mkSettings(null));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\sf: no connection to the server/);
  });

  test('missing name → "function name is required"', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn([], spy);
    const ctx = mkCtx('sf', '', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\sf: function name is required/);
    expect(spy.queries).toEqual([]);
  });

  test('bare name → uses regproc cast, fetches definition, prints', async () => {
    const spy = { queries: [] as string[] };
    const def = `CREATE OR REPLACE FUNCTION public.foo()\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT 1 $function$\n`;
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regproc::pg_catalog.oid'),
          result: mkResultSet([[12345]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(12345)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf', 'foo', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toBe(def);
    expect(spy.queries[0]).toContain("'foo'::pg_catalog.regproc");
  });

  test('signature name → uses regprocedure cast', async () => {
    const spy = { queries: [] as string[] };
    const def = `CREATE OR REPLACE FUNCTION public.foo(integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT 1 $function$\n`;
    const conn = mkConn(
      [
        {
          match: (sql) =>
            sql.includes('::pg_catalog.regprocedure::pg_catalog.oid'),
          result: mkResultSet([[42]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(42)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf', 'foo(int)', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.queries[0]).toContain("'foo(int)'::pg_catalog.regprocedure");
    expect(stdoutChunks.join('')).toBe(def);
  });

  test('schema-qualified name passes through to lookup', async () => {
    const spy = { queries: [] as string[] };
    const def = `CREATE OR REPLACE FUNCTION s.foo()\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT 1 $function$\n`;
    const conn = mkConn(
      [
        {
          match: (sql) =>
            sql.includes("'s.foo'") &&
            sql.includes('::pg_catalog.regproc::pg_catalog.oid'),
          result: mkResultSet([[7]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(7)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf', 's.foo', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toBe(def);
  });

  test('lookup failure surfaces as ERROR: line on stderr', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: () => true,
          err: Object.assign(new Error('function "nope" does not exist'), {
            severity: 'ERROR',
            message: 'function "nope" does not exist',
          }),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf', 'nope', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toBe(
      'ERROR:  function "nope" does not exist\n',
    );
  });

  test('escapeLiteral guards embedded quote in the name', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: () => true,
          err: new Error('shape-check-only'),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf', "foo'bar", mkSettings(conn));
    await cmdShowFunction.run(ctx);
    expect(spy.queries[0]).toContain("'foo''bar'");
  });

  test('whitespace-only arg is treated as missing', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn([], spy);
    const ctx = mkCtx('sf', '   \t  ', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\sf: function name is required/);
  });

  test('strips trailing whitespace and ; from the descriptor', async () => {
    // Upstream `exec_command_sf_sv` trims trailing whitespace + `;`
    // before passing the descriptor to `lookup_object_oid`, so users
    // who type `\sf foo(int);` (with the muscle-memory trailing
    // semicolon) get the same result as `\sf foo(int)`.
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('regprocedure'),
          result: mkResultSet([['42']]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef'),
          result: mkResultSet([['CREATE FUNCTION foo() RETURNS int AS $$$$']]),
        },
      ],
      spy,
    );
    // Trailing whitespace + ;; should be peeled off before regprocedure.
    const ctx = mkCtx('sf', '  foo(int) ;; \t', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.queries[0]).toContain(`'foo(int)'::pg_catalog.regprocedure`);
  });

  test('trailing-only ; descriptor is treated as missing', async () => {
    // Pure punctuation/whitespace after trimming should be "no name"
    // rather than reaching the server with an empty literal.
    const spy = { queries: [] as string[] };
    const conn = mkConn([], spy);
    const ctx = mkCtx('sf', '  ;; ', mkSettings(conn));
    const r = await cmdShowFunction.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\sf: function name is required/);
    expect(spy.queries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// \sf+
// ---------------------------------------------------------------------------

describe('cmdShowFunctionPlus (\\sf+)', () => {
  test('renders header with 8-space padding and body with %-7d format', async () => {
    const spy = { queries: [] as string[] };
    const def =
      `CREATE OR REPLACE FUNCTION public.foo(x integer)\n` +
      ` RETURNS integer\n` +
      ` LANGUAGE sql\n` +
      `AS $function$ SELECT $1 + 1; $function$\n`;
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regproc'),
          result: mkResultSet([[1]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(1)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf+', 'foo', mkSettings(conn));
    const r = await cmdShowFunctionPlus.run(ctx);
    expect(r.status).toBe('ok');
    const out = stdoutChunks.join('');
    expect(out).toBe(
      `        CREATE OR REPLACE FUNCTION public.foo(x integer)\n` +
        `         RETURNS integer\n` +
        `         LANGUAGE sql\n` +
        `1       AS $function$ SELECT $1 + 1; $function$\n`,
    );
  });

  test('BEGIN marker also triggers body', async () => {
    const spy = { queries: [] as string[] };
    const def =
      `CREATE OR REPLACE FUNCTION public.bar()\n` +
      ` RETURNS integer\n` +
      ` LANGUAGE plpgsql\n` +
      `BEGIN RETURN 1; END;\n`;
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regproc'),
          result: mkResultSet([[2]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(2)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf+', 'bar', mkSettings(conn));
    await cmdShowFunctionPlus.run(ctx);
    const out = stdoutChunks.join('');
    expect(out).toContain('1       BEGIN RETURN 1; END;');
  });

  test('RETURN marker also triggers body (SQL-style functions)', async () => {
    const spy = { queries: [] as string[] };
    const def =
      `CREATE OR REPLACE FUNCTION public.baz()\n` +
      ` RETURNS integer\n` +
      ` LANGUAGE sql\n` +
      `RETURN 1;\n`;
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regproc'),
          result: mkResultSet([[3]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(3)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sf+', 'baz', mkSettings(conn));
    await cmdShowFunctionPlus.run(ctx);
    expect(stdoutChunks.join('')).toContain('1       RETURN 1;');
  });
});

// ---------------------------------------------------------------------------
// \sv
// ---------------------------------------------------------------------------

describe('cmdShowView (\\sv)', () => {
  test('no connection → error', async () => {
    const ctx = mkCtx('sv', 'v', mkSettings(null));
    const r = await cmdShowView.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\sv: no connection to the server/);
  });

  test('missing name → "view name is required"', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn([], spy);
    const ctx = mkCtx('sv', '', mkSettings(conn));
    const r = await cmdShowView.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(/\\sv: view name is required/);
  });

  test('renders CREATE OR REPLACE VIEW with schema-qualified name and body', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[100]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          // nspname, relname, relkind, viewdef, reloptions, checkoption
          result: mkResultSet([
            ['public', 'myv', 'v', ' SELECT 1 AS x;', null, null],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sv', 'myv', mkSettings(conn));
    const r = await cmdShowView.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toBe(
      `CREATE OR REPLACE VIEW public.myv AS\n SELECT 1 AS x\n`,
    );
  });

  test('quotes mixed-case identifiers in the head', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[200]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          result: mkResultSet([
            ['MySchema', 'MyView', 'v', ' SELECT 1 AS x;', null, null],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sv', 'MySchema.MyView', mkSettings(conn));
    await cmdShowView.run(ctx);
    expect(stdoutChunks.join('')).toBe(
      `CREATE OR REPLACE VIEW "MySchema"."MyView" AS\n SELECT 1 AS x\n`,
    );
  });

  test('renders reloptions when present', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[300]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          result: mkResultSet([
            [
              'public',
              'v',
              'v',
              ' SELECT 1 AS x;',
              '{security_barrier=true}',
              null,
            ],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sv', 'v', mkSettings(conn));
    await cmdShowView.run(ctx);
    expect(stdoutChunks.join('')).toBe(
      `CREATE OR REPLACE VIEW public.v\n WITH (security_barrier=true) AS\n SELECT 1 AS x\n`,
    );
  });

  test('renders WITH CHECK OPTION when checkoption is set', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[301]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          result: mkResultSet([
            ['public', 'v', 'v', ' SELECT 1 AS x;', null, 'LOCAL'],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sv', 'v', mkSettings(conn));
    await cmdShowView.run(ctx);
    expect(stdoutChunks.join('')).toBe(
      `CREATE OR REPLACE VIEW public.v AS\n SELECT 1 AS x\n WITH LOCAL CHECK OPTION\n`,
    );
  });

  test('non-view relkind surfaces "is not a view" error', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[500]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          // relkind=r → ordinary table
          result: mkResultSet([
            ['public', 'sometbl', 'r', ' SELECT 1;', null, null],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sv', 'sometbl', mkSettings(conn));
    const r = await cmdShowView.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toBe(
      'ERROR:  "public.sometbl" is not a view\n',
    );
  });

  test('legacy-server (pre-9.4) path emits the simpler query', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[600]]),
        },
        {
          match: (sql) =>
            sql.includes('c.reloptions AS reloptions') &&
            sql.includes('NULL AS checkoption'),
          result: mkResultSet([
            ['public', 'v', 'v', ' SELECT 1 AS x;', null, null],
          ]),
        },
      ],
      spy,
      90300, // pre-9.4
    );
    const ctx = mkCtx('sv', 'v', mkSettings(conn));
    await cmdShowView.run(ctx);
    expect(stdoutChunks.join('')).toBe(
      `CREATE OR REPLACE VIEW public.v AS\n SELECT 1 AS x\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// \sv+
// ---------------------------------------------------------------------------

describe('cmdShowViewPlus (\\sv+)', () => {
  test('every line numbered from 1 (no header phase)', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[1]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          result: mkResultSet([
            ['public', 'testv', 'v', ' SELECT 1 AS x;', null, null],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('sv+', 'testv', mkSettings(conn));
    const r = await cmdShowViewPlus.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toBe(
      `1       CREATE OR REPLACE VIEW public.testv AS\n` +
        `2        SELECT 1 AS x\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// \ef / \ev
// ---------------------------------------------------------------------------

describe('cmdEditFunction (\\ef)', () => {
  test('missing name → editing-not-supported hint', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn([], spy);
    const ctx = mkCtx('ef', '', mkSettings(conn));
    const r = await cmdEditFunction.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(
      /\\ef: editing not supported in embedded psql/,
    );
    expect(spy.queries).toEqual([]);
  });

  test('with name → routes through show path (equivalent to \\sf)', async () => {
    const spy = { queries: [] as string[] };
    const def = `CREATE OR REPLACE FUNCTION public.foo()\n LANGUAGE sql\nAS $function$ SELECT 1 $function$\n`;
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regproc'),
          result: mkResultSet([[10]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(10)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('ef', 'foo', mkSettings(conn));
    const r = await cmdEditFunction.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toBe(def);
  });

  test('trailing LINE number is stripped before lookup', async () => {
    const spy = { queries: [] as string[] };
    const def = `CREATE OR REPLACE FUNCTION public.foo()\n LANGUAGE sql\nAS $function$ SELECT 1 $function$\n`;
    const conn = mkConn(
      [
        {
          match: (sql) =>
            sql.includes("'foo'::pg_catalog.regproc::pg_catalog.oid"),
          result: mkResultSet([[10]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(10)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('ef', 'foo 12', mkSettings(conn));
    const r = await cmdEditFunction.run(ctx);
    expect(r.status).toBe('ok');
    expect(spy.queries[0]).toContain("'foo'");
    expect(spy.queries[0]).not.toContain("'foo 12'");
  });

  test('\\ef+ honours plus modifier (line numbers)', async () => {
    const spy = { queries: [] as string[] };
    const def =
      `CREATE OR REPLACE FUNCTION public.foo()\n` +
      ` LANGUAGE sql\n` +
      `AS $function$ SELECT 1 $function$\n`;
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regproc'),
          result: mkResultSet([[10]]),
        },
        {
          match: (sql) => sql.includes('pg_get_functiondef(10)'),
          result: mkResultSet([[def]]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('ef+', 'foo', mkSettings(conn));
    const r = await cmdEditFunctionPlus.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toContain('1       AS $function$ SELECT 1');
  });
});

describe('cmdEditView (\\ev)', () => {
  test('missing name → editing-not-supported hint', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn([], spy);
    const ctx = mkCtx('ev', '', mkSettings(conn));
    const r = await cmdEditView.run(ctx);
    expect(r.status).toBe('error');
    expect(stderrChunks.join('')).toMatch(
      /\\ev: editing not supported in embedded psql/,
    );
  });

  test('with name → routes through show path (equivalent to \\sv)', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[20]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          result: mkResultSet([
            ['public', 'myv', 'v', ' SELECT 1 AS x;', null, null],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('ev', 'myv', mkSettings(conn));
    const r = await cmdEditView.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toBe(
      `CREATE OR REPLACE VIEW public.myv AS\n SELECT 1 AS x\n`,
    );
  });

  test('\\ev+ honours plus modifier (line numbers)', async () => {
    const spy = { queries: [] as string[] };
    const conn = mkConn(
      [
        {
          match: (sql) => sql.includes('::pg_catalog.regclass'),
          result: mkResultSet([[21]]),
        },
        {
          match: (sql) => sql.includes('FROM pg_catalog.pg_class c'),
          result: mkResultSet([
            ['public', 'myv', 'v', ' SELECT 1 AS x;', null, null],
          ]),
        },
      ],
      spy,
    );
    const ctx = mkCtx('ev+', 'myv', mkSettings(conn));
    const r = await cmdEditViewPlus.run(ctx);
    expect(r.status).toBe('ok');
    expect(stdoutChunks.join('')).toContain(
      '1       CREATE OR REPLACE VIEW public.myv AS',
    );
  });
});

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('registerShowCommands', () => {
  test('registers all eight names on the supplied registry', () => {
    const r = createBackslashRegistry();
    registerShowCommands(r);
    for (const name of ['sf', 'sf+', 'sv', 'sv+', 'ef', 'ef+', 'ev', 'ev+']) {
      expect(r.lookup(name), `missing: ${name}`).toBeDefined();
    }
  });
});
