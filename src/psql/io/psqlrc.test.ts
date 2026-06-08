import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  defaultPsqlrcPath,
  executeInputString,
  loadPsqlrc,
  psqlrcCandidates,
} from './psqlrc.js';
import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';
import { createCondStack } from '../command/cmd_cond.js';
import type {
  Connection,
  FieldDescription,
  ResultSet,
} from '../types/connection.js';
import type {
  BackslashCmdSpec,
  BackslashRegistry,
} from '../types/backslash.js';
import type { REPLContext } from '../types/repl.js';

// ---------------------------------------------------------------------------
// Helpers — minimal mock connection + sinks.
// ---------------------------------------------------------------------------

const buildResultSet = (): ResultSet => ({
  command: 'SELECT',
  rowCount: 1,
  oid: null,
  fields: [
    {
      name: 'x',
      tableID: 0,
      columnID: 0,
      dataTypeID: 23,
      dataTypeSize: 4,
      dataTypeModifier: -1,
      format: 0,
    } satisfies FieldDescription,
  ],
  rows: [[1]],
  notices: [],
});

type MockConn = Connection & {
  calls: string[];
};

const makeMockConnection = (failFor?: string): MockConn => {
  const calls: string[] = [];
  const noop = (): (() => void) => () => undefined;
  const conn: MockConn = {
    serverVersion: 170002,
    parameterStatus: (): string | undefined => undefined,
    query: () => Promise.reject(new Error('not implemented')),
    execSimple: (sql: string): Promise<ResultSet[]> => {
      calls.push(sql);
      if (failFor !== undefined && sql.includes(failFor)) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve([buildResultSet()]);
    },
    prepare: () => Promise.reject(new Error('not implemented')),
    startCopyIn: () => Promise.reject(new Error('not implemented')),
    startCopyOut: () => Promise.reject(new Error('not implemented')),
    pipeline: () => {
      throw new Error('not implemented');
    },
    cancel: () => Promise.resolve(),
    escapeIdentifier: (v: string) => `"${v}"`,
    escapeLiteral: (v: string) => `'${v}'`,
    onNotice: noop,
    onNotification: noop,
    close: () => Promise.resolve(),
    isClosed: () => false,
    calls,
  };
  return conn;
};

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

const makeRegistry = (): BackslashRegistry => {
  const map = new Map<string, BackslashCmdSpec>();
  const setVarSpec: BackslashCmdSpec = {
    name: 'set',
    // eslint-disable-next-line @typescript-eslint/require-await
    async run(ctx) {
      const name = ctx.nextArg('normal');
      const value = ctx.nextArg('normal');
      if (name) ctx.settings.vars.set(name, value ?? 'on');
      return { status: 'ok' };
    },
  };
  map.set('set', setVarSpec);
  return {
    register: (spec) => map.set(spec.name, spec),
    lookup: (name) => map.get(name),
    all: () => map.values(),
  };
};

const buildCtx = (
  conn: MockConn | null = makeMockConnection(),
): {
  ctx: REPLContext;
  stdout: ReturnType<typeof makeBuffer>;
  stderr: ReturnType<typeof makeBuffer>;
  conn: MockConn | null;
} => {
  const vars = createVarStore();
  const settings = defaultSettings(vars);
  settings.db = conn;
  const stdout = makeBuffer();
  const stderr = makeBuffer();
  const stdin = new Writable() as unknown as NodeJS.ReadableStream;
  const ctx: REPLContext = {
    settings,
    registry: makeRegistry(),
    cond: createCondStack(),
    stdin,
    stdout,
    stderr,
  };
  return { ctx, stdout, stderr, conn };
};

// ---------------------------------------------------------------------------
// defaultPsqlrcPath
// ---------------------------------------------------------------------------

describe('defaultPsqlrcPath', () => {
  test('returns $HOME/.psqlrc on POSIX', () => {
    // On non-Windows test runners, the function follows the POSIX path.
    if (process.platform === 'win32') return;
    const p = defaultPsqlrcPath({ HOME: '/home/me' } as NodeJS.ProcessEnv);
    expect(p).toBe('/home/me/.psqlrc');
  });

  test('handles missing HOME gracefully', () => {
    if (process.platform === 'win32') return;
    const p = defaultPsqlrcPath({} as NodeJS.ProcessEnv);
    expect(p).toBe('.psqlrc');
  });
});

// ---------------------------------------------------------------------------
// psqlrcCandidates
// ---------------------------------------------------------------------------

describe('psqlrcCandidates', () => {
  test('PSQLRC env override suppresses HOME discovery', () => {
    const cs = psqlrcCandidates(
      { HOME: '/home/me', PSQLRC: '/etc/rc' } as NodeJS.ProcessEnv,
      170002,
    );
    expect(cs.map((c) => c.path)).toEqual(['/etc/rc']);
  });

  test('PSQLRC tilde expands using HOME', () => {
    const cs = psqlrcCandidates(
      { HOME: '/home/me', PSQLRC: '~/rc' } as NodeJS.ProcessEnv,
      undefined,
    );
    if (process.platform === 'win32') return;
    expect(cs.map((c) => c.path)).toEqual(['/home/me/rc']);
  });

  test('without PSQLRC: versioned + base HOME candidates', () => {
    if (process.platform === 'win32') return;
    const cs = psqlrcCandidates(
      { HOME: '/home/me' } as NodeJS.ProcessEnv,
      170002,
    );
    const paths = cs.map((c) => c.path);
    expect(paths).toContain('/home/me/.psqlrc-17');
    expect(paths).toContain('/home/me/.psqlrc');
  });

  test('PGSYSCONFDIR prepends system candidates', () => {
    if (process.platform === 'win32') return;
    const cs = psqlrcCandidates(
      {
        HOME: '/home/me',
        PGSYSCONFDIR: '/etc/postgresql',
      } as NodeJS.ProcessEnv,
      170002,
    );
    const paths = cs.map((c) => c.path);
    expect(paths[0]).toBe('/etc/postgresql/psqlrc-17');
    expect(paths[1]).toBe('/etc/postgresql/psqlrc');
  });
});

// ---------------------------------------------------------------------------
// loadPsqlrc — files on disk
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psqlrc-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('loadPsqlrc', () => {
  test('skip: true short-circuits — no file reads, no execSimple', async () => {
    const { ctx, conn } = buildCtx();
    const file = path.join(tmpDir, 'rc');
    await fs.writeFile(file, 'SELECT 1;\n', 'utf8');
    await loadPsqlrc(ctx, { path: file, skip: true });
    expect(conn?.calls).toEqual([]);
  });

  test('missing file is silently skipped', async () => {
    const { ctx, conn } = buildCtx();
    const missing = path.join(tmpDir, 'does-not-exist');
    await loadPsqlrc(ctx, { path: missing });
    expect(conn?.calls).toEqual([]);
  });

  test('reads file and dispatches a single SELECT statement', async () => {
    const { ctx, conn } = buildCtx();
    const file = path.join(tmpDir, 'rc');
    await fs.writeFile(file, 'SELECT 1;\n', 'utf8');
    await loadPsqlrc(ctx, { path: file });
    expect(conn?.calls.length).toBe(1);
    expect(conn?.calls[0]).toMatch(/SELECT 1/);
  });

  test('runs multiple statements in order', async () => {
    const { ctx, conn } = buildCtx();
    const file = path.join(tmpDir, 'rc');
    await fs.writeFile(file, 'SELECT 1;\nSELECT 2;\n', 'utf8');
    await loadPsqlrc(ctx, { path: file });
    expect(conn?.calls.length).toBe(2);
    expect(conn?.calls[0]).toMatch(/SELECT 1/);
    expect(conn?.calls[1]).toMatch(/SELECT 2/);
  });

  test('tail dispatch when file has no trailing semicolon', async () => {
    const { ctx, conn } = buildCtx();
    const file = path.join(tmpDir, 'rc');
    await fs.writeFile(file, 'SELECT 42', 'utf8');
    await loadPsqlrc(ctx, { path: file });
    expect(conn?.calls.length).toBe(1);
    expect(conn?.calls[0]).toMatch(/SELECT 42/);
  });

  test('backslash command dispatch routes through registry', async () => {
    const { ctx } = buildCtx();
    const file = path.join(tmpDir, 'rc');
    await fs.writeFile(file, '\\set FOO bar\n', 'utf8');
    await loadPsqlrc(ctx, { path: file });
    expect(ctx.settings.vars.get('FOO')).toBe('bar');
  });

  test('curCmdSource is restored after run', async () => {
    const { ctx } = buildCtx();
    const file = path.join(tmpDir, 'rc');
    await fs.writeFile(file, 'SELECT 1;\n', 'utf8');
    ctx.settings.curCmdSource = 'stdin';
    await loadPsqlrc(ctx, { path: file });
    expect(ctx.settings.curCmdSource).toBe('stdin');
  });

  test('with env discovery: HOME/.psqlrc is read', async () => {
    const { ctx, conn } = buildCtx();
    const file = path.join(tmpDir, '.psqlrc');
    await fs.writeFile(file, 'SELECT 99;\n', 'utf8');
    await loadPsqlrc(ctx, { env: { HOME: tmpDir } as NodeJS.ProcessEnv });
    if (process.platform === 'win32') return; // skip detail check on Win
    expect(conn?.calls.length).toBe(1);
    expect(conn?.calls[0]).toMatch(/SELECT 99/);
  });
});

// ---------------------------------------------------------------------------
// executeInputString — direct exercises
// ---------------------------------------------------------------------------

describe('executeInputString', () => {
  test('executes plain SELECT through db.execSimple', async () => {
    const { ctx, conn } = buildCtx();
    await executeInputString('SELECT 1;', ctx);
    expect(conn?.calls.length).toBe(1);
  });

  test('handles SQL errors without throwing; writes to stderr', async () => {
    const failingConn = makeMockConnection('SELECT');
    const { ctx, stderr } = buildCtx(failingConn);
    await executeInputString('SELECT bad;', ctx);
    expect(stderr.text()).toMatch(/boom/);
  });

  test('respects onErrorStop and bails after first error', async () => {
    const failingConn = makeMockConnection('SELECT');
    const { ctx, conn } = buildCtx(failingConn);
    ctx.settings.onErrorStop = true;
    await executeInputString('SELECT a; SELECT b;', ctx);
    // Only the first statement should have been dispatched.
    expect(conn?.calls.length).toBe(1);
  });

  test('whitespace-only input is a no-op', async () => {
    const { ctx, conn } = buildCtx();
    await executeInputString('   \n\n', ctx);
    expect(conn?.calls).toEqual([]);
  });

  test('queryBuf uses scanner-substituted text, not raw chunk (drops `\\;`)', async () => {
    // Regression: the scanner translates `\;` (forced-semicolon) into a
    // literal `;` in its `sql` field. The old buffer-build path used
    // `working.slice(0, r.consumed)` (which preserves `\;` verbatim) and
    // then trimmed the cmd portion off the end — so the literal `\` ended
    // up in the executed SQL. The fix folds `r.sql` directly into queryBuf.
    const { ctx } = buildCtx();
    let observedBuf: string | null = null;
    const probe: BackslashCmdSpec = {
      name: 'parsebuf',
      // eslint-disable-next-line @typescript-eslint/require-await
      async run(bctx) {
        observedBuf = bctx.queryBuf;
        return { status: 'reset-buf', newBuf: '' };
      },
    };
    ctx.registry.register(probe);
    await executeInputString('SELECT 1\\; SELECT 2 \\parsebuf\n', ctx);
    // The leading `\` of `\;` MUST NOT appear in the buffer the slash
    // command sees — only the bare `;`. Mirrors upstream `\;` semantics.
    expect(observedBuf).toBe('SELECT 1; SELECT 2 ');
  });

  test('a successful trailing statement does not clear an earlier error', async () => {
    // The exit-code latch must hold across the tail-dispatch path: when an
    // earlier statement failed, a final statement with no trailing `;` that
    // succeeds must not reset `hadError`. Otherwise `psql -c "bad; ok"` would
    // wrongly report success even though the first statement errored.
    const failingConn = makeMockConnection('bad');
    const { ctx, conn } = buildCtx(failingConn);
    const outcome = await executeInputString('SELECT bad;\nSELECT ok', ctx, {
      print: true,
    });
    // Both ran (the error doesn't halt without ON_ERROR_STOP) ...
    expect(conn?.calls).toEqual(['SELECT bad;', 'SELECT ok']);
    // ... and the trailing success left the error latched.
    expect(outcome.hadError).toBe(true);
  });

  test('buffer is reset after a backslash-command error (no tail re-run)', async () => {
    // Regression: the mainloop resets queryBuf when a slash command errors
    // so the residue doesn't re-execute at EOF via the tail-dispatch path.
    // psqlrc's executeInputString must do the same; otherwise a failing
    // `\bind \g` on chained SQL would emit the server error AND then run
    // the SQL via simple-Query as the file ends.
    const { ctx, conn } = buildCtx();
    const failer: BackslashCmdSpec = {
      name: 'boom',
      // eslint-disable-next-line @typescript-eslint/require-await
      async run() {
        return { status: 'error', errorWritten: true };
      },
    };
    ctx.registry.register(failer);
    // No trailing `;` — without the error-reset, the tail dispatch would
    // execute "SELECT trailing" via execSimple after `\boom` failed.
    await executeInputString('SELECT trailing \\boom\n', ctx);
    expect(conn?.calls).toEqual([]);
  });
});
