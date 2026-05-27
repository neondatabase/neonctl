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
import { runMainLoop, EXIT_SUCCESS, EXIT_USER, __testing } from './mainloop.js';
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

type NotificationListener = (
  channel: string,
  payload: string,
  pid: number,
) => void;

type MockConn = Connection & {
  calls: string[];
  queryCalls: QueryCall[];
  cancelCalls: number;
  /** Set/override a ParameterStatus value (e.g. `client_encoding`). */
  setParam(name: string, value: string): void;
  /** Emit a NotificationResponse to every subscriber installed via onNotification. */
  emitNotification(channel: string, payload: string, pid: number): void;
};

const makeMockConnection = (
  canned: Map<string, Canned> = new Map(),
): MockConn => {
  const calls: string[] = [];
  const queryCalls: QueryCall[] = [];
  let cancelCalls = 0;
  const noop = (): (() => void) => () => undefined;
  const params = new Map<string, string>();
  const notificationListeners = new Set<NotificationListener>();
  const conn = {
    serverVersion: 170000,
    parameterStatus: (name: string): string | undefined => params.get(name),
    setParam(name: string, value: string): void {
      params.set(name, value);
    },
    emitNotification(channel: string, payload: string, pid: number): void {
      for (const l of notificationListeners) l(channel, payload, pid);
    },
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
    onNotification(listener: NotificationListener): () => void {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
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
  return conn as unknown as MockConn;
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

  test('unknown backslash command writes an error and exits non-zero', async () => {
    const { ctx, stderr } = buildCtx({ lines: ['\\nosuch'] });
    const code = await runMainLoop(ctx);
    // Mirrors upstream MainLoop's `success` propagation: when the last
    // submitted statement fails in scripted (notty) mode, the process exits
    // EXIT_USER even without ON_ERROR_STOP.
    expect(code).toBe(EXIT_USER);
    expect(stderr.text()).toMatch(/invalid command \\nosuch/);
  });

  // -------------------------------------------------------------------------
  // Same-line backslash after buffered SQL.
  //
  // Upstream `psqlscan.l` recognises the backslash boundary regardless of
  // buffer state, and `MainLoop()` forwards the accumulated buffer into the
  // dispatched command's `query_buf`. Buffer-consuming commands (`\g`,
  // `\gx`, `\gset`, `\gexec`, `\gdesc`, `\crosstabview`, `\watch`, `\bind`)
  // read this through `ctx.queryBuf` and execute; commands that don't care
  // (`\set`, `\echo`, `\!`, `\cd`, …) leave the buffer intact. These tests
  // exercise the mainloop wiring that hands the pre-backslash SQL into
  // BackslashContext.queryBuf.
  // -------------------------------------------------------------------------

  test('\\echo on same line as SQL: command runs, buffer survives for next ;', async () => {
    const { ctx, db } = buildCtx({ lines: ['SELECT 1 \\echo hi', ';'] });
    await runMainLoop(ctx);
    // Echo command saw the rest-of-line args.
    expect(ctx.settings.vars.get('__ECHO_LAST')).toBe('hi');
    // Buffer was NOT consumed by \echo, so the `;` on the next line dispatches
    // the buffered `SELECT 1`.
    expect(db?.calls.length).toBe(1);
    expect(db?.calls[0]).toMatch(/SELECT 1/);
  });

  test('buffer-consuming spec on same line: queryBuf reaches BackslashContext', async () => {
    // Plug a small spec that records ctx.queryBuf so we can prove the
    // pre-backslash SQL flowed through. Returning `reset-buf` matches the
    // upstream contract for buffer-consuming commands.
    const captured: string[] = [];
    const captureSpec: BackslashCmdSpec = {
      name: 'capture',
      // eslint-disable-next-line @typescript-eslint/require-await
      async run(ctx) {
        captured.push(ctx.queryBuf);
        return { status: 'reset-buf', newBuf: '' };
      },
    };
    const { ctx, db } = buildCtx({
      lines: ['SELECT 1 \\capture'],
      registrySpecs: [captureSpec],
    });
    await runMainLoop(ctx);
    expect(captured).toEqual(['SELECT 1 ']);
    // The buffer was consumed (reset-buf), so no SQL was dispatched through
    // the connection.
    expect(db?.calls).toEqual([]);
  });

  test('buffer survives non-consuming command, then dispatches on next ;', async () => {
    // \echo leaves the buffer intact. The trailing `;` on a later line then
    // dispatches `SELECT 1 ` to the connection.
    const { ctx, db } = buildCtx({
      lines: ['SELECT 1', '\\echo middle', '+ 2;'],
    });
    await runMainLoop(ctx);
    // \echo fired with its args.
    expect(ctx.settings.vars.get('__ECHO_LAST')).toBe('middle');
    // The SELECT was assembled across the lines and dispatched as one query.
    expect(db?.calls.length).toBe(1);
    expect(db?.calls[0]).toMatch(/SELECT 1/);
    expect(db?.calls[0]).toMatch(/\+ 2;/);
  });

  test('two successive reset-buf commands do not leak a leading \\n into queryBuf', async () => {
    // Regression guard for the `\parse stmt1\nSELECT $1, $2 \parse stmt3`
    // shape from regress/psql. With the original scanner (which stops the
    // backslash boundary BEFORE the trailing `\n`), the residual `\n` would
    // get folded back into queryBuf via the `eof` accumulation path on the
    // very next scanSql call — and the next `reset-buf`-returning command
    // would see queryBuf = `\nSELECT ...`. Commands that store the buffer
    // verbatim (notably `\parse`) then emit a stray leading 0x0a byte.
    //
    // The mainloop's `reset-buf` branch now strips that residual line
    // terminator from `working` so the next pass starts cleanly. Verify
    // by recording what each invocation of a buffer-consuming command
    // saw in `ctx.queryBuf`.
    const captured: string[] = [];
    const captureSpec: BackslashCmdSpec = {
      name: 'capture',
      // eslint-disable-next-line @typescript-eslint/require-await
      async run(ctx) {
        captured.push(ctx.queryBuf);
        return { status: 'reset-buf', newBuf: '' };
      },
    };
    const { ctx } = buildCtx({
      lines: ['SELECT 2 \\capture', 'SELECT $1, $2 \\capture'],
      registrySpecs: [captureSpec],
    });
    await runMainLoop(ctx);
    // Both buffers are exactly what the user typed before the slash — no
    // leading `\n` on the second.
    expect(captured).toEqual(['SELECT 2 ', 'SELECT $1, $2 ']);
  });

  test('errored slash command also strips the residual line terminator', async () => {
    // Mirror of the `reset-buf` regression test but for the `error` branch:
    // an errored slash command also drops the buffer, and we don't want the
    // line-terminator residue to seep into the next statement's queryBuf
    // either.
    const captured: string[] = [];
    const errSpec: BackslashCmdSpec = {
      name: 'failsafe',
      // eslint-disable-next-line @typescript-eslint/require-await
      async run() {
        return { status: 'error', errorWritten: true };
      },
    };
    const captureSpec: BackslashCmdSpec = {
      name: 'capture',
      // eslint-disable-next-line @typescript-eslint/require-await
      async run(ctx) {
        captured.push(ctx.queryBuf);
        return { status: 'reset-buf', newBuf: '' };
      },
    };
    const { ctx } = buildCtx({
      lines: ['SELECT 1 \\failsafe', 'SELECT 2 \\capture'],
      registrySpecs: [errSpec, captureSpec],
    });
    await runMainLoop(ctx);
    // The `\failsafe` errored (queryBuf dropped, line terminator stripped);
    // `\capture` then sees a clean `SELECT 2 ` with no `\n` prefix.
    expect(captured).toEqual(['SELECT 2 ']);
  });
});

// ---------------------------------------------------------------------------
// :NAME variable substitution end-to-end through the mainloop. Confirms that
// the wiring from scanSql → dispatched SQL and slash-arg → echo body both
// honour the active VarStore. The defaultSettings hook seeds
// WATCH_INTERVAL=2, so we use that for one of the cases without needing
// any explicit `\set` step.
// ---------------------------------------------------------------------------

describe('runMainLoop — :NAME substitution', () => {
  test('SQL body: :NAME expands before the query reaches the connection', async () => {
    const { ctx, db } = buildCtx({
      lines: ['SELECT :x;'],
      settingsOverride: (s) => {
        s.vars.set('x', '42');
      },
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(['SELECT 42;']);
  });

  test("SQL body: :'NAME' produces a quoted SQL literal", async () => {
    const { ctx, db } = buildCtx({
      lines: ["SELECT :'v';"],
      settingsOverride: (s) => {
        s.vars.set('v', "it's");
      },
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(["SELECT 'it''s';"]);
  });

  test('slash command body: \\echo :NAME substitutes through the registry', async () => {
    const { ctx } = buildCtx({
      lines: ['\\echo :greeting'],
      settingsOverride: (s) => {
        s.vars.set('greeting', 'hi');
      },
    });
    await runMainLoop(ctx);
    expect(ctx.settings.vars.get('__ECHO_LAST')).toBe('hi');
  });

  test('built-in WATCH_INTERVAL (seeded to 2) is visible to \\echo', async () => {
    const { ctx } = buildCtx({
      lines: ['\\echo :WATCH_INTERVAL'],
    });
    await runMainLoop(ctx);
    expect(ctx.settings.vars.get('__ECHO_LAST')).toBe('2');
  });

  test(':: cast operator survives intact (no false substitution)', async () => {
    const { ctx, db } = buildCtx({
      lines: ["SELECT '1'::int;"],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(["SELECT '1'::int;"]);
  });

  test('unknown :NAME falls back to literal — no silent empty string', async () => {
    const { ctx, db } = buildCtx({
      lines: ['SELECT :MISSING;'],
    });
    await runMainLoop(ctx);
    expect(db?.calls).toEqual(['SELECT :MISSING;']);
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

  test('\\endif without \\if writes a bare error to process.stderr', async () => {
    // Cond commands emit their diagnostics BARE (no `psql: ERROR:` prefix)
    // via `writeErr` → process.stderr — matching upstream and the regress
    // expected output. ctx.stderr only sees the mainloop's `psql: ERROR:`
    // fallback, which is suppressed via `errorWritten: true`. We spy on
    // process.stderr to assert the diagnostic shape.
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { ctx, stderr } = buildCtx({ lines: ['\\endif'] });
      const code = await runMainLoop(ctx);
      const captured = chunks.join('');
      expect(captured).toMatch(/^\\endif: no matching \\if\n/);
      expect(captured).not.toMatch(/psql: ERROR/);
      // Cond errors must NOT escalate to EXIT_USER under default settings
      // (vanilla psql exits 0 from a script whose only failure was a cond
      // diagnostic). Only ON_ERROR_STOP can escalate.
      expect(code).toBe(EXIT_SUCCESS);
      // ctx.stderr stays empty for the cond diagnostic itself.
      expect(stderr.text()).not.toMatch(/\\endif/);
    } finally {
      process.stderr.write = orig;
    }
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

// ---------------------------------------------------------------------------
// ENCODING — seeded from server's client_encoding at startup; refreshed
// after each successful query (mirrors upstream's tail-of-SendQuery refresh
// in common.c).
// ---------------------------------------------------------------------------

describe('runMainLoop — ENCODING', () => {
  test('seeded from server client_encoding on startup', async () => {
    const { ctx, db } = buildCtx({ lines: [] });
    db?.setParam('client_encoding', 'LATIN1');
    await runMainLoop(ctx);
    expect(ctx.settings.vars.get('ENCODING')).toBe('LATIN1');
  });

  test('falls back to default UTF8 when no parameterStatus is set', async () => {
    const { ctx } = buildCtx({ lines: [] });
    await runMainLoop(ctx);
    // defaultSettings seeds ENCODING=UTF8 and no client_encoding was set
    // on the mock, so refresh keeps the default.
    expect(ctx.settings.vars.get('ENCODING')).toBe('UTF8');
  });

  test('refreshes after a SET client_encoding statement', async () => {
    const { ctx, db } = buildCtx({ lines: ['SELECT 1;'] });
    db?.setParam('client_encoding', 'UTF8');
    // Drive the connection's perceived encoding to flip after the query.
    const orig = db?.execSimple.bind(db);
    if (db && orig) {
      db.execSimple = (sql: string): Promise<ResultSet[]> => {
        // Mock the server returning a ParameterStatus mid-flight by
        // mutating the mock's params map before resolving.
        db.setParam('client_encoding', 'LATIN1');
        return orig(sql);
      };
    }
    await runMainLoop(ctx);
    expect(ctx.settings.vars.get('ENCODING')).toBe('LATIN1');
  });
});

// ---------------------------------------------------------------------------
// Asynchronous NotificationResponse (LISTEN/NOTIFY)
// ---------------------------------------------------------------------------

describe('runMainLoop — NotificationResponse', () => {
  test('renders the upstream "Asynchronous notification" line (no payload)', async () => {
    const { ctx, stdout, db } = buildCtx({ lines: ['SELECT 1;'] });
    // Drive the mock to emit a NotificationResponse during the query.
    const orig = db?.execSimple.bind(db);
    if (db && orig) {
      db.execSimple = (sql: string): Promise<ResultSet[]> => {
        db.emitNotification('foo', '', 4242);
        return orig(sql);
      };
    }
    await runMainLoop(ctx);
    expect(stdout.text()).toMatch(
      /Asynchronous notification "foo" received from server process with PID 4242\./,
    );
  });

  test('includes payload clause when payload is non-empty', async () => {
    const { ctx, stdout, db } = buildCtx({ lines: ['SELECT 1;'] });
    const orig = db?.execSimple.bind(db);
    if (db && orig) {
      db.execSimple = (sql: string): Promise<ResultSet[]> => {
        db.emitNotification('foo', 'bar', 7);
        return orig(sql);
      };
    }
    await runMainLoop(ctx);
    expect(stdout.text()).toMatch(
      /Asynchronous notification "foo" with payload "bar" received from server process with PID 7\./,
    );
  });
});

// ---------------------------------------------------------------------------
// VI_MODE — the psql variable that controls the LineEditor editing mode.
// We exercise the small parsing helpers directly here; the editor-side
// integration (setMode applied at next prompt) is covered by the LineEditor
// unit tests.
// ---------------------------------------------------------------------------

describe('mainloop — VI_MODE helpers', () => {
  test('parseBoolVar accepts the upstream on/off spellings', () => {
    expect(__testing.parseBoolVar('on')).toBe(true);
    expect(__testing.parseBoolVar('ON')).toBe(true);
    expect(__testing.parseBoolVar('true')).toBe(true);
    expect(__testing.parseBoolVar('yes')).toBe(true);
    expect(__testing.parseBoolVar('1')).toBe(true);
    expect(__testing.parseBoolVar('')).toBe(true);
    expect(__testing.parseBoolVar('off')).toBe(false);
    expect(__testing.parseBoolVar('false')).toBe(false);
    expect(__testing.parseBoolVar('no')).toBe(false);
    expect(__testing.parseBoolVar('0')).toBe(false);
  });

  test('parseBoolVar returns null for unrecognised input', () => {
    expect(__testing.parseBoolVar('banana')).toBeNull();
    expect(__testing.parseBoolVar('2')).toBeNull();
    expect(__testing.parseBoolVar('vi')).toBeNull();
  });

  test('viModeOption defaults to emacs when unset', () => {
    expect(__testing.viModeOption(undefined)).toBe('emacs');
  });

  test('viModeOption translates truthy values to vi', () => {
    expect(__testing.viModeOption('on')).toBe('vi');
    expect(__testing.viModeOption('1')).toBe('vi');
    expect(__testing.viModeOption('yes')).toBe('vi');
  });

  test('viModeOption translates falsy values to emacs', () => {
    expect(__testing.viModeOption('off')).toBe('emacs');
    expect(__testing.viModeOption('0')).toBe('emacs');
    // Unrecognised input falls back to emacs — same as upstream's `set
    // editing-mode unknown` (silently ignored). The hook itself emits the
    // diagnostic before reaching this translator.
    expect(__testing.viModeOption('banana')).toBe('emacs');
  });
});
