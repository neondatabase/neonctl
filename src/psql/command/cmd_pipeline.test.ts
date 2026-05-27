/**
 * Tests for the pipeline / extended-query backslash commands (WP-21).
 *
 * The connection is mocked. We assert that:
 *   - \bind / \bind_named stash params on the settings (Symbol-keyed slot).
 *   - \parse routes through Connection.prepare.
 *   - \close_prepared invokes the prepared statement's close().
 *   - \startpipeline / \endpipeline flip settings.sendMode and instantiate
 *     a Pipeline.
 *   - \gdesc renders a Column / Type listing via the prepared statement's
 *     describe().
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BackslashCmdSpec, BackslashContext } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import type {
  Connection,
  FieldDescription,
  Pipeline,
  PreparedStatement,
  ResultSet,
} from '../types/connection.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  cmdBind,
  cmdBindNamed,
  cmdClosePrepared,
  cmdEndPipeline,
  cmdGdesc,
  cmdParse,
  cmdStartPipeline,
  consumeBindState,
  getPipelineState,
} from './cmd_pipeline.js';

// ---------------------------------------------------------------------------
// Tiny mock BackslashContext factory — whitespace-split args, '…' quoting.
// ---------------------------------------------------------------------------

const makeMockCtx = (
  cmdName: string,
  rawArgs: string,
  settings: PsqlSettings,
  queryBuf = '',
): BackslashContext => {
  let cursor = 0;
  return {
    settings,
    cmdName,
    queryBuf,
    rawArgs,
    nextArg: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      if (cursor >= rawArgs.length) return null;
      if (rawArgs[cursor] === "'") {
        cursor++;
        let out = '';
        while (cursor < rawArgs.length && rawArgs[cursor] !== "'") {
          out += rawArgs[cursor++];
        }
        if (cursor < rawArgs.length) cursor++;
        return out;
      }
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

// ---------------------------------------------------------------------------
// stdout / stderr capture.
// ---------------------------------------------------------------------------

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

const stdout = (): string => stdoutChunks.join('');
const stderr = (): string => stderrChunks.join('');
const run = (spec: BackslashCmdSpec, ctx: BackslashContext) => spec.run(ctx);

// ---------------------------------------------------------------------------
// Mock Connection that returns canned PreparedStatements.
// ---------------------------------------------------------------------------

type MockConn = Connection & {
  prepared: string[];
  preparedClose: string[];
  /** Names passed to the dedicated `Close('S', NAME)` entry point. */
  closePreparedNames: string[];
};

const mkPrepared = (
  name: string,
  fields: FieldDescription[] = [],
  onClose: () => void = () => undefined,
): PreparedStatement => ({
  name,
  paramTypes: [],
  bind: () => Promise.resolve(),
  describe: () => Promise.resolve(fields),
  execute: (): Promise<ResultSet> =>
    Promise.resolve({
      command: 'SELECT',
      rowCount: 0,
      oid: null,
      fields,
      rows: [],
      notices: [],
    }),
  bindAndExecute: (): Promise<ResultSet> =>
    Promise.resolve({
      command: 'SELECT',
      rowCount: 0,
      oid: null,
      fields,
      rows: [],
      notices: [],
    }),
  close: () => {
    onClose();
    return Promise.resolve();
  },
});

const makeMockConn = (): MockConn => {
  const prepared: string[] = [];
  const preparedClose: string[] = [];
  const closePreparedNames: string[] = [];
  const conn: MockConn = {
    serverVersion: 170000,
    prepared,
    preparedClose,
    closePreparedNames,
    parameterStatus: () => undefined,
    query: () => Promise.reject(new Error('not implemented')),
    execSimple: () => Promise.resolve([]),
    prepare: (name: string, sql: string) => {
      prepared.push(`${name}::${sql}`);
      return Promise.resolve(
        mkPrepared(
          name,
          [
            {
              name: 'col',
              tableID: 0,
              columnID: 0,
              dataTypeID: 23,
              dataTypeSize: 4,
              dataTypeModifier: -1,
              format: 0,
            },
          ],
          () => preparedClose.push(name),
        ),
      );
    },
    closePreparedStatement: (name: string) => {
      closePreparedNames.push(name);
      return Promise.resolve();
    },
    startCopyIn: () => Promise.reject(new Error('nope')),
    startCopyOut: () => Promise.reject(new Error('nope')),
    pipeline: (): Pipeline => ({
      parse: vi.fn(() => Promise.resolve()) as Pipeline['parse'],
      bind: vi.fn(() => Promise.resolve()) as Pipeline['bind'],
      describe: vi.fn(() => Promise.resolve()) as Pipeline['describe'],
      execute: vi.fn(() => Promise.resolve()) as Pipeline['execute'],
      close: vi.fn(() => Promise.resolve()) as Pipeline['close'],
      flush: vi.fn(() => Promise.resolve()) as Pipeline['flush'],
      sync: vi.fn(() => Promise.resolve()) as Pipeline['sync'],
      end: vi.fn(() => Promise.resolve([])) as Pipeline['end'],
    }),
    cancel: () => Promise.resolve(),
    escapeIdentifier: (v: string) => `"${v}"`,
    escapeLiteral: (v: string) => `'${v}'`,
    onNotice: () => () => undefined,
    onNotification: () => () => undefined,
    close: () => Promise.resolve(),
    isClosed: () => false,
  };
  return conn;
};

const makeSettings = (conn?: Connection): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  if (conn) s.db = conn;
  return s;
};

// ---------------------------------------------------------------------------
// \bind / \bind_named
// ---------------------------------------------------------------------------

describe('\\bind', () => {
  test("\\bind 1 'two' stashes params on the BackslashContext settings", async () => {
    const s = makeSettings();
    const ctx = makeMockCtx('bind', "1 'two'", s);
    const r = await run(cmdBind, ctx);
    expect(r.status).toBe('ok');
    const stash = consumeBindState(s);
    expect(stash).toEqual({ name: '', values: ['1', 'two'], byName: false });
    // Second consume returns null.
    expect(consumeBindState(s)).toBeNull();
  });

  test('\\bind_named NAME [V] stashes name + params', async () => {
    const s = makeSettings();
    const ctx = makeMockCtx('bind_named', 'st1 a b', s);
    const r = await run(cmdBindNamed, ctx);
    expect(r.status).toBe('ok');
    expect(consumeBindState(s)).toEqual({
      name: 'st1',
      values: ['a', 'b'],
      byName: true,
    });
  });

  test('\\bind_named without name fails', async () => {
    const s = makeSettings();
    const ctx = makeMockCtx('bind_named', '', s);
    const r = await run(cmdBindNamed, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/missing required argument/);
  });
});

// ---------------------------------------------------------------------------
// \parse / \close_prepared
// ---------------------------------------------------------------------------

describe('\\parse / \\close_prepared', () => {
  test('\\parse NAME prepares the current buffer', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('parse', 'stm', s, 'SELECT 1');
    const r = await run(cmdParse, ctx);
    expect(r.status).toBe('reset-buf');
    expect(conn.prepared).toContain('stm::SELECT 1');
  });

  test('\\parse without a query buffer fails', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('parse', 'stm', s, '');
    const r = await run(cmdParse, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/no query buffer/);
  });

  test('\\parse sets settings.lastQuery so a later \\g can re-run the SQL', async () => {
    // After a successful \parse, upstream populates pset.last_query
    // with the prepared SQL. This lets a subsequent \g (e.g. after a
    // failed \bind_named NAME that wipes bind state) re-execute the
    // parsed text via the simple-query path and surface server errors
    // like "there is no parameter $1".
    const conn = makeMockConn();
    const s = makeSettings(conn);
    expect(s.lastQuery).toBe('');
    const ctx = makeMockCtx('parse', 'stmt3', s, 'SELECT $1, $2');
    const r = await run(cmdParse, ctx);
    expect(r.status).toBe('reset-buf');
    expect(s.lastQuery).toBe('SELECT $1, $2');
  });

  test('\\close_prepared NAME closes the statement', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('close_prepared', 'stm', s);
    const r = await run(cmdClosePrepared, ctx);
    expect(r.status).toBe('ok');
    // Upstream issues `Close('S', NAME) + Sync` directly — no fake Parse
    // round-trip. We assert that the dedicated entry point was called
    // and that no PreparedStatement.close() ran (`preparedClose` is
    // populated by the PreparedStatement mock's close callback).
    expect(conn.closePreparedNames).toEqual(['stm']);
    expect(conn.preparedClose).not.toContain('stm');
    expect(conn.prepared).not.toContain('stm::SELECT 1');
  });

  test('\\close_prepared NAME falls back to prepare+close when conn lacks the dedicated API', async () => {
    // Older Connection mocks may not implement closePreparedStatement;
    // cmdClosePrepared should still work by going through the same
    // prepare(name, 'SELECT 1') -> close() round-trip we used to use.
    const conn = makeMockConn();
    // Strip the dedicated method to exercise the fallback branch.
    (
      conn as unknown as { closePreparedStatement?: unknown }
    ).closePreparedStatement = undefined;
    const s = makeSettings(conn);
    const ctx = makeMockCtx('close_prepared', 'fallback', s);
    const r = await run(cmdClosePrepared, ctx);
    expect(r.status).toBe('ok');
    expect(conn.prepared).toContain('fallback::SELECT 1');
    expect(conn.preparedClose).toContain('fallback');
  });
});

// ---------------------------------------------------------------------------
// \startpipeline / \endpipeline
// ---------------------------------------------------------------------------

describe('\\startpipeline / \\endpipeline', () => {
  test('\\startpipeline flips sendMode + creates a pipeline session', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const r = await run(cmdStartPipeline, makeMockCtx('startpipeline', '', s));
    expect(r.status).toBe('ok');
    expect(s.sendMode).toBe('extended-pipeline');
    expect(getPipelineState(s)).not.toBeNull();
  });

  test('\\endpipeline restores sendMode and clears state', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    await run(cmdStartPipeline, makeMockCtx('startpipeline', '', s));
    const r = await run(cmdEndPipeline, makeMockCtx('endpipeline', '', s));
    expect(r.status).toBe('ok');
    expect(s.sendMode).toBe('extended-query');
    expect(getPipelineState(s)).toBeNull();
  });

  test('\\endpipeline without an active session fails', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const r = await run(cmdEndPipeline, makeMockCtx('endpipeline', '', s));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/no pipeline active/);
  });
});

// ---------------------------------------------------------------------------
// \gdesc
//
// The active implementation lives in `./cmd_io.ts`; we re-export the spec
// from cmd_pipeline.ts so this test (and any other call sites that
// imported `cmdGdesc` from this module) keep working. The cmd_io test
// covers printer-routing and tuples-only behaviour; here we sanity-check
// the re-export path and the no-buffer error.
// ---------------------------------------------------------------------------

describe('\\gdesc', () => {
  test('renders a Column / Type listing through the printer', async () => {
    const conn = makeMockConn();
    // The cmd_io implementation issues a follow-up format_type query.
    // The default mock returns `[]` from execSimple, so we fall through to
    // the OID-fallback and print the raw dataTypeID. That still gives us
    // a Column / Type row to assert on.
    const s = makeSettings(conn);
    const ctx = makeMockCtx(
      'gdesc',
      '',
      s,
      "SELECT 1::int AS i, 'hi' AS greeting",
    );
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('reset-buf');
    const out = stdout();
    expect(out).toMatch(/Column/);
    expect(out).toMatch(/Type/);
    expect(out).toMatch(/col/);
    // The new impl uses the standard printer footer: `(N rows)`.
    expect(out).toMatch(/\(0 rows\)|\(1 row\)/);
  });

  test('\\gdesc without a query buffer fails', async () => {
    const conn = makeMockConn();
    const s = makeSettings(conn);
    const ctx = makeMockCtx('gdesc', '', s, '');
    const r = await run(cmdGdesc, ctx);
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/no query buffer/);
  });
});
