/**
 * Unit tests for `PipelineSession` (WP-21).
 *
 * We mock the {@link PipelineHost} surface so the tests don't need a socket.
 * The mock records every wire frame the session writes and lets the test
 * resolve / reject the enqueue promises in arbitrary order — this exercises
 * the session's ordering invariants without dragging in PgConnection's state
 * machine.
 */

import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';

import { PipelineSession } from './pipeline.js';
import type { PipelineHost } from './pipeline.js';

type Pending<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
};

const defer = <T>(): Pending<T> => {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

type Recorded = {
  /** Wire frames the session sent (typed by leading byte). */
  frames: string[];
  /** Queues of unresolved promises by op kind. */
  parses: Pending<undefined>[];
  binds: Pending<undefined>[];
  executes: Pending<ResultSet>[];
  describes: Pending<FieldDescription[]>[];
  closes: Pending<undefined>[];
  syncs: Pending<undefined>[];
};

const makeHost = (): { host: PipelineHost; rec: Recorded } => {
  const rec: Recorded = {
    frames: [],
    parses: [],
    binds: [],
    executes: [],
    describes: [],
    closes: [],
    syncs: [],
  };
  const host: PipelineHost = {
    writeRaw: (buf: Buffer) => {
      rec.frames.push(String.fromCharCode(buf[0]));
    },
    startExtendedBatch: () => undefined,
    enqueueParse: () => {
      const d = defer<undefined>();
      rec.parses.push(d);
      return d.promise.then(() => undefined);
    },
    enqueueBind: () => {
      const d = defer<undefined>();
      rec.binds.push(d);
      return d.promise.then(() => undefined);
    },
    enqueueDescribePortal: () => {
      const d = defer<FieldDescription[]>();
      rec.describes.push(d);
      return d.promise;
    },
    enqueueDescribeStatement: () => {
      const d = defer<{ paramOids: number[]; fields: FieldDescription[] }>();
      // Re-wrap as the simpler shape used here; tests only need describePortal.
      return d.promise.then((r) => ({
        paramOids: r.paramOids,
        fields: r.fields,
      }));
    },
    enqueueExecute: () => {
      const d = defer<ResultSet>();
      rec.executes.push(d);
      return d.promise;
    },
    enqueueClose: () => {
      const d = defer<undefined>();
      rec.closes.push(d);
      return d.promise.then(() => undefined);
    },
    enqueueSync: () => {
      const d = defer<undefined>();
      rec.syncs.push(d);
      return d.promise.then(() => undefined);
    },
    _extPipelineActive: false,
  };
  return { host, rec };
};

const fakeResult = (rows: unknown[][] = []): ResultSet => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: null,
  fields: [],
  rows,
  notices: [],
});

describe('PipelineSession', () => {
  test('parse() writes a P frame and resolves on enqueue success', async () => {
    const { host, rec } = makeHost();
    const pipe = new PipelineSession(host);
    const p = pipe.parse('s1', 'SELECT 1', []);
    expect(rec.frames).toEqual(['P']);
    rec.parses[0].resolve(undefined);
    await p;
  });

  test('bind() writes a B frame and resolves on BindComplete', async () => {
    const { host, rec } = makeHost();
    const pipe = new PipelineSession(host);
    const p = pipe.bind('s1', ['x', 42]);
    expect(rec.frames).toEqual(['B']);
    rec.binds[0].resolve(undefined);
    await p;
  });

  test('execute() writes an E frame and surfaces the result via end()', async () => {
    const { host, rec } = makeHost();
    const pipe = new PipelineSession(host);
    const exec1 = pipe.execute('', 0);
    expect(rec.frames).toEqual(['E']);
    rec.executes[0].resolve(fakeResult([['a']]));
    await exec1;

    const exec2 = pipe.execute('', 0);
    rec.executes[1].resolve(fakeResult([['b']]));
    await exec2;

    const endP = pipe.end();
    // end() writes the terminating Sync.
    expect(rec.frames[rec.frames.length - 1]).toBe('S');
    rec.syncs[rec.syncs.length - 1].resolve(undefined);
    const results = await endP;
    expect(results.map((r) => r.rows)).toEqual([[['a']], [['b']]]);
    expect(host._extPipelineActive).toBe(false);
  });

  test('flush() emits an H frame without enqueueing a barrier op', async () => {
    const { host, rec } = makeHost();
    const pipe = new PipelineSession(host);
    await pipe.flush();
    expect(rec.frames).toEqual(['H']);
    expect(rec.syncs).toHaveLength(0);
  });

  test('sync() emits an S frame and resolves when the server acks', async () => {
    const { host, rec } = makeHost();
    const pipe = new PipelineSession(host);
    const sp = pipe.sync();
    expect(rec.frames).toEqual(['S']);
    rec.syncs[0].resolve(undefined);
    await sp;
  });

  test('close() emits a C frame and resolves on CloseComplete', async () => {
    const { host, rec } = makeHost();
    const pipe = new PipelineSession(host);
    const cp = pipe.close('s1');
    expect(rec.frames).toEqual(['C']);
    rec.closes[0].resolve(undefined);
    await cp;
  });

  test('end() collects results in execute-order regardless of resolution order', async () => {
    const { host, rec } = makeHost();
    const pipe = new PipelineSession(host);
    void pipe.execute('', 0);
    void pipe.execute('', 0);
    void pipe.execute('', 0);
    // Resolve out-of-order: middle first, then last, then first.
    rec.executes[1].resolve(fakeResult([['b']]));
    rec.executes[2].resolve(fakeResult([['c']]));
    rec.executes[0].resolve(fakeResult([['a']]));
    const endP = pipe.end();
    rec.syncs[rec.syncs.length - 1].resolve(undefined);
    const results = await endP;
    expect(results.map((r) => r.rows)).toEqual([[['a']], [['b']], [['c']]]);
  });
});
