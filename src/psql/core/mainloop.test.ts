import { Readable, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';

import type {
  Connection,
  ResultSet,
  FieldDescription,
} from '../types/connection.js';
import type {
  BackslashCmdSpec,
  BackslashRegistry,
} from '../types/backslash.js';
import type { REPLContext } from '../types/repl.js';
import type { PsqlSettings } from '../types/settings.js';

import { createVarStore } from './variables.js';
import { defaultSettings } from './settings.js';
import { runMainLoop, EXIT_SUCCESS, EXIT_USER } from './mainloop.js';
import { createCondStack } from '../command/cmd_cond.js';

// ---------------------------------------------------------------------------
// Mock Connection — canned responses keyed off SQL text. Anything not in the
// map throws an error to simulate a server-side failure.
// ---------------------------------------------------------------------------

type Canned = ResultSet | (() => ResultSet) | Error;

const buildResultSet = (
  cmd: string,
  fields: { name: string }[],
  rows: unknown[][],
): ResultSet => ({
  command: cmd,
  rowCount: rows.length,
  oid: null,
  fields: fields.map(
    (f): FieldDescription => ({
      name: f.name,
      tableID: 0,
      columnID: 0,
      dataTypeID: 25,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: 0,
    }),
  ),
  rows,
  notices: [],
});

type QueryCall = { sql: string; params: unknown[] };

const makeMockConnection = (
  canned: Map<string, Canned> = new Map(),
): Connection & {
  calls: string[];
  queryCalls: QueryCall[];
  cancelCalls: number;
} => {
  const calls: string[] = [];
  const queryCalls: QueryCall[] = [];
  let cancelCalls = 0;
  const noop = (): (() => void) => () => undefined;
  const conn = {
    serverVersion: 170000,
    parameterStatus: (): string | undefined => undefined,
    query(sql: string, params?: unknown[]): Promise<ResultSet> {
      const trimmed = sql.trim();
      queryCalls.push({ sql: trimmed, params: params ?? [] });
      const lookup = canned.get(trimmed);
      if (lookup === undefined) {
        return Promise.resolve(
          buildResultSet('SELECT', [{ name: '?column?' }], [[1]]),
        );
      }
      if (lookup instanceof Error) return Promise.reject(lookup);
      const rs = typeof lookup === 'function' ? lookup() : lookup;
      return Promise.resolve(rs);
    },
    execSimple(sql: string): Promise<ResultSet[]> {
      const trimmed = sql.trim();
      calls.push(trimmed);
      const lookup = canned.get(trimmed);
      if (lookup === undefined) {
        return Promise.resolve([
          buildResultSet('SELECT', [{ name: '?column?' }], [[1]]),
        ]);
      }
      if (lookup instanceof Error) return Promise.reject(lookup);
      const rs = typeof lookup === 'function' ? lookup() : lookup;
      return Promise.resolve([rs]);
    },
    prepare: () => Promise.reject(new Error('not implemented')),
    startCopyIn: () => Promise.reject(new Error('not implemented')),
    startCopyOut: () => Promise.reject(new Error('not implemented')),
    pipeline: () => {
      throw new Error('not implemented');
    },
    cancel: (): Promise<void> => {
      cancelCalls += 1;
      return Promise.resolve();
    },
    escapeIdentifier: (v: string) => `"${v}"`,
    escapeLiteral: (v: string) => `'${v}'`,
    onNotice: noop,
    onNotification: noop,
    close: () => Promise.resolve(),
    isClosed: () => false,
    get calls() {
      return calls;
    },
    get queryCalls() {
      return queryCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
  // The accessor properties above won't survive a structural cast cleanly;
  // expose plain properties for tests to inspect.
  return conn as unknown as Connection & {
    calls: string[];
    queryCalls: QueryCall[];
    cancelCalls: number;
  };
};

// ---------------------------------------------------------------------------
// In-memory writable stream — captures everything written for assertions.
// ---------------------------------------------------------------------------

const makeBuffer = (): NodeJS.WritableStream & { text(): string } => {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    },
  });
  (w as unknown as { text: () => string }).text = (): string =>
    Buffer.concat(chunks).toString('utf8');
  return w as unknown as NodeJS.WritableStream & { text(): string };
};

// ---------------------------------------------------------------------------
// Registry — a tiny in-memory implementation. We attach a one-shot \echo for
// tests that need a non-cond backslash command.
// ---------------------------------------------------------------------------

const makeRegistry = (specs: BackslashCmdSpec[] = []): BackslashRegistry => {
  const map = new Map<string, BackslashCmdSpec>();
  const register = (spec: BackslashCmdSpec): void => {
    map.set(spec.name, spec);
    for (const a of spec.aliases ?? []) map.set(a, spec);
  };
  for (const s of specs) register(s);
  return {
    register,
    lookup: (name) => map.get(name),
    all: () => map.values(),
  };
};

const echoSpec: BackslashCmdSpec = {
  name: 'echo',
  argMode: 'lex',
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(ctx) {
    const args: string[] = [];
    let next = ctx.nextArg('normal');
    while (next !== null) {
      args.push(next);
      next = ctx.nextArg('normal');
    }
    // Echo cmd doesn't actually write — the run hook can't reach stdout here.
    // For testability, stash a marker on settings.
    ctx.settings.vars.set('__ECHO_LAST', args.join(' '));
    return { status: 'ok' };
  },
};

// ---------------------------------------------------------------------------
// Builder for REPLContext given input lines and optional canned SQL.
// ---------------------------------------------------------------------------

type BuildCtxOpts = {
  lines: string[];
  canned?: Map<string, Canned>;
  notty?: boolean;
  registrySpecs?: BackslashCmdSpec[];
  settingsOverride?: (s: PsqlSettings) => void;
  noConnection?: boolean;
};

const buildCtx = (
  opts: BuildCtxOpts,
): {
  ctx: REPLContext;
  stdout: ReturnType<typeof makeBuffer>;
  stderr: ReturnType<typeof makeBuffer>;
  db: ReturnType<typeof makeMockConnection> | null;
} => {
  const vars = createVarStore();
  const settings = defaultSettings(vars);
  settings.notty = opts.notty ?? true;
  const db = opts.noConnection ? null : makeMockConnection(opts.canned);
  settings.db = db;
  opts.settingsOverride?.(settings);
  const stdin = Readable.from(opts.lines.map((l) => l + '\n'));
  const stdout = makeBuffer();
  const stderr = makeBuffer();
  const registry = makeRegistry([echoSpec, ...(opts.registrySpecs ?? [])]);
  const ctx: REPLContext = {
    settings,
    registry,
    cond: createCondStack(),
    stdin,
    stdout,
    stderr,
  };
  return { ctx, stdout, stderr, db };
};

// ---------------------------------------------------------------------------
// SQL execution end-to-end
// ---------------------------------------------------------------------------

describe('runMainLoop — SQL', () => {
  test('single-line statement is dispatched and aligned output written', async () => {
    const { ctx, stdout, db } = buildCtx({ lines: ['SELECT 1;'] });
    const code = await runMainLoop(ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(db?.calls).toEqual(['SELECT 1;']);
    const text = stdout.text();
    // Aligned output should include the column header and the value.
    expect(text).toContain('?column?');
    expect(text).toContain('1');
  });

  test('multi-line statement is assembled before dispatch', async () => {
    const { ctx, db } = buildCtx({ lines: ['SELECT', '1;'] });
    const code = await runMainLoop(ctx);
    expect(code).toBe(EXIT_SUCCESS);
    // One execSimple call with the full multi-line SQL.
    expect(db?.calls.length).toBe(1);
    expect(db?.calls[0]).toMatch(/^SELECT/);
    expect(db?.calls[0]).toContain('1;');
  });

  test('two semicolons in same input run two queries', async () => {
    const { ctx, db } = buildCtx({ lines: ['SELECT 1; SELECT 2;'] });
    await runMainLoop(ctx);
    expect(db?.calls.length).toBe(2);
    expect(db?.calls[0]).toBe('SELECT 1;');
    expect(db?.calls[1]).toBe('SELECT 2;');
  });

  test('EOF closes cleanly', async () => {
    const { ctx } = buildCtx({ lines: [] });
    const code = await runMainLoop(ctx);
    expect(code).toBe(EXIT_SUCCESS);
  });
});

// ---------------------------------------------------------------------------
// Backslash commands
// ---------------------------------------------------------------------------

describe('runMainLoop — backslash commands', () => {
  test('\\echo is dispatched through the registry', async () => {
    const { ctx } = buildCtx({ lines: ['\\echo hello'] });
    await runMainLoop(ctx);
    expect(ctx.settings.vars.get('__ECHO_LAST')).toBe('hello');
  });

  test('unknown backslash command writes an error', async () => {
    const { ctx, stderr } = buildCtx({ lines: ['\\nosuch'] });
    const code = await runMainLoop(ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(stderr.text()).toMatch(/invalid command \\nosuch/);
  });
});

// ---------------------------------------------------------------------------
// Conditional flow
// ---------------------------------------------------------------------------

describe('runMainLoop — conditional dispatch', () => {
  test('\\if true keeps SELECT executable', async () => {
    const { ctx, db } = buildCtx({
      lines: ['\\if true', 'SELECT 1;', '\\endif'],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(['SELECT 1;']);
    expect(ctx.cond.depth()).toBe(0);
  });

  test('\\if false suppresses the SELECT', async () => {
    const { ctx, db } = buildCtx({
      lines: ['\\if false', 'SELECT 1;', '\\endif'],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual([]);
    expect(ctx.cond.depth()).toBe(0);
  });

  test('nested: outer false suppresses inner true', async () => {
    const { ctx, db } = buildCtx({
      lines: ['\\if false', '\\if true', 'SELECT 1;', '\\endif', '\\endif'],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual([]);
    expect(ctx.cond.depth()).toBe(0);
  });

  test('\\elif matrix: first-true wins', async () => {
    const { ctx, db } = buildCtx({
      lines: [
        '\\if false',
        'SELECT 1;',
        '\\elif true',
        'SELECT 2;',
        '\\elif true',
        'SELECT 3;',
        '\\endif',
      ],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(['SELECT 2;']);
  });

  test('\\else fires when no prior branch matched', async () => {
    const { ctx, db } = buildCtx({
      lines: ['\\if false', 'SELECT 1;', '\\else', 'SELECT 2;', '\\endif'],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(['SELECT 2;']);
  });

  test('\\else is skipped when an earlier branch matched', async () => {
    const { ctx, db } = buildCtx({
      lines: ['\\if true', 'SELECT 1;', '\\else', 'SELECT 2;', '\\endif'],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(['SELECT 1;']);
  });

  test('\\endif without \\if writes an error', async () => {
    const { ctx, stderr } = buildCtx({ lines: ['\\endif'] });
    await runMainLoop(ctx);
    expect(stderr.text()).toMatch(/\\endif: no matching \\if/);
  });

  test('unbalanced \\if at EOF logs a warning', async () => {
    const { ctx, stderr } = buildCtx({ lines: ['\\if true'] });
    await runMainLoop(ctx);
    expect(stderr.text()).toMatch(/reached EOF without finding closing/);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('runMainLoop — error handling', () => {
  test('error keeps loop running by default', async () => {
    const canned = new Map<string, Canned>([
      ['SELECT bad;', new Error('syntax error')],
    ]);
    const { ctx, stderr, db } = buildCtx({
      lines: ['SELECT bad;', 'SELECT 1;'],
      canned,
    });
    const code = await runMainLoop(ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(stderr.text()).toMatch(/syntax error/);
    expect(db?.calls).toEqual(['SELECT bad;', 'SELECT 1;']);
  });

  test('onErrorStop returns exit 3 and halts further execution', async () => {
    const canned = new Map<string, Canned>([
      ['SELECT bad;', new Error('boom')],
    ]);
    const { ctx, db } = buildCtx({
      lines: ['SELECT bad;', 'SELECT 1;'],
      canned,
      settingsOverride: (s) => {
        s.onErrorStop = true;
      },
    });
    const code = await runMainLoop(ctx);
    expect(code).toBe(EXIT_USER);
    expect(db?.calls).toEqual(['SELECT bad;']);
  });

  test('lastErrorResult is populated after a failure', async () => {
    const canned = new Map<string, Canned>([
      ['SELECT bad;', new Error('the error')],
    ]);
    const { ctx } = buildCtx({ lines: ['SELECT bad;'], canned });
    await runMainLoop(ctx);
    expect(ctx.settings.lastErrorResult?.message).toBe('the error');
  });

  test('no connection: SQL writes a no-connection error', async () => {
    const { ctx, stderr } = buildCtx({
      lines: ['SELECT 1;'],
      noConnection: true,
    });
    await runMainLoop(ctx);
    expect(stderr.text()).toMatch(/no connection to the server/);
  });
});

// ---------------------------------------------------------------------------
// \timing
// ---------------------------------------------------------------------------

describe('runMainLoop — \\timing', () => {
  test('emits Time: line when settings.timing is on', async () => {
    const { ctx, stdout } = buildCtx({
      lines: ['SELECT 1;'],
      settingsOverride: (s) => {
        s.timing = true;
      },
    });
    await runMainLoop(ctx);
    expect(stdout.text()).toMatch(/^Time: \d+\.\d{3} ms$/m);
  });

  test('no Time: line when timing is off', async () => {
    const { ctx, stdout } = buildCtx({ lines: ['SELECT 1;'] });
    await runMainLoop(ctx);
    expect(stdout.text()).not.toMatch(/^Time: /m);
  });
});

// ---------------------------------------------------------------------------
// `\bind` — extended-protocol path with parameter substitution.
//
// `cmd_pipeline.ts` stashes parameters on a Symbol-keyed slot of
// `PsqlSettings`; the mainloop consumes them on the next `;` boundary and
// routes the SQL through `Connection.query(sql, params)` instead of
// `execSimple`. The result must render through the same printer pipeline as
// the simple-query path (not a stderr placeholder).
// ---------------------------------------------------------------------------

const BIND_STATE_KEY = Symbol.for('neonctl.psql.bindState');

describe('runMainLoop — \\bind', () => {
  test('bound query is dispatched via query() and rendered on stdout', async () => {
    const { ctx, stdout, stderr, db } = buildCtx({ lines: ['SELECT $1;'] });
    // Pre-stash bind params via the same Symbol the `\bind` command writes
    // to. The mainloop's `dispatchSendQuery` should pick this up, call
    // `db.query(sql, values)`, and print the result through the printer.
    (ctx.settings as unknown as Record<symbol, unknown>)[BIND_STATE_KEY] = {
      name: '',
      values: ['hello'],
    };

    const code = await runMainLoop(ctx);
    expect(code).toBe(EXIT_SUCCESS);

    // query() — not execSimple() — was called with the stashed params.
    expect(db?.queryCalls).toHaveLength(1);
    expect(db?.queryCalls[0]).toMatchObject({
      sql: 'SELECT $1;',
      params: ['hello'],
    });
    expect(db?.calls).toEqual([]);

    // The printer output landed on stdout, not on the old stderr placeholder.
    const stdoutText = stdout.text();
    expect(stdoutText).toContain('?column?');
    expect(stdoutText).toContain('1');
    expect(stderr.text()).not.toContain('-- bound query:');
  });

  test('bind stash is cleared after dispatch (next query takes simple path)', async () => {
    const { ctx, db } = buildCtx({ lines: ['SELECT $1;', 'SELECT 2;'] });
    (ctx.settings as unknown as Record<symbol, unknown>)[BIND_STATE_KEY] = {
      name: '',
      values: ['once'],
    };

    await runMainLoop(ctx);

    // First query went through the extended path; second through execSimple.
    expect(db?.queryCalls).toHaveLength(1);
    expect(db?.queryCalls[0]).toMatchObject({
      sql: 'SELECT $1;',
      params: ['once'],
    });
    expect(db?.calls).toEqual(['SELECT 2;']);
  });
});
