/**
 * PipelineSession — high-level wrapper around the extended-protocol pipeline
 * driver in {@link PgConnection} (WP-21).
 *
 * In pipeline mode (libpq's `PQpipelineSync`), the client streams multiple
 * extended-protocol commands (Parse/Bind/Describe/Execute/Close) without
 * waiting for results. The server processes each in order and queues replies.
 * `sync()` inserts a Sync into the stream — that's the error boundary: any
 * failure before the next Sync causes the server to skip subsequent commands
 * until that Sync. `end()` finalizes the session.
 *
 * Design:
 *
 *   - Each method writes the wire frame *and* enqueues a matching op record
 *     on `PgConnection.extDriver.queue`. The connection's dispatch loop
 *     resolves ops in order as replies arrive.
 *   - `execute()` records its own ResultSet promise; callers can `await` each
 *     individually or use the implicit ordering via the resolution sequence.
 *   - `flush()` sends `Flush`, which forces the server to send any queued
 *     replies without committing a Sync barrier. `sync()` sends `Sync` (and
 *     resolves on the corresponding ReadyForQuery).
 *   - `end()` sends a final Sync, waits for ReadyForQuery, and returns the
 *     concatenated ResultSets in execute-order. After end() the connection
 *     drops back to `idle`.
 */

import { Buffer } from 'node:buffer';

import type {
  FieldDescription,
  Pipeline,
  ResultSet,
} from '../types/connection.js';

import {
  Bind,
  Close,
  Describe,
  Execute,
  Flush,
  Parse,
  Sync,
} from './protocol.js';

/**
 * Minimal contract the session needs from PgConnection. Keeping it explicit
 * lets us mock the connection in unit tests.
 */
export type PipelineHost = {
  writeRaw(buf: Buffer): void;
  startExtendedBatch(): void;
  enqueueParse(): Promise<void>;
  enqueueBind(): Promise<void>;
  enqueueDescribePortal(): Promise<FieldDescription[]>;
  enqueueDescribePortalIntoNextExecute(): Promise<void>;
  enqueueDescribeStatement(): Promise<{
    paramOids: number[];
    fields: FieldDescription[];
  }>;
  enqueueExecute(): Promise<ResultSet>;
  enqueueClose(): Promise<void>;
  enqueueSync(): Promise<void>;
  /** Pipeline-mode flag; we toggle it so RfQ doesn't drop back to idle. */
  _extPipelineActive: boolean;
};

export class PipelineSession implements Pipeline {
  private readonly results: Promise<ResultSet>[] = [];
  // Promises for ops whose server-side completion we still need to
  // observe (Parse, Bind, Describe, Close). In pipeline mode the
  // server doesn't reply until the next Sync, so awaiting them in
  // these methods would deadlock — we keep them and let `sync()` /
  // `end()` drain them.
  private readonly pending: Promise<unknown>[] = [];

  public constructor(private readonly conn: PipelineHost) {
    this.conn._extPipelineActive = true;
    this.conn.startExtendedBatch();
  }

  /**
   * Attach a no-op rejection handler so an unhandled rejection on `p`
   * doesn't bubble up. The original promise is also retained in
   * `this.results` / `this.pending` so callers (end(), getresults) can
   * still observe the outcome — we only swallow the unhandled-rejection
   * warning Node would otherwise emit at process scope.
   */
  private static silenceUnhandled<T>(p: Promise<T>): Promise<T> {
    p.catch((): void => undefined);
    return p;
  }

  public parse(
    name: string,
    sql: string,
    paramTypes?: number[],
  ): Promise<void> {
    this.conn.startExtendedBatch();
    const p = this.conn.enqueueParse();
    this.conn.writeRaw(Parse(name, sql, paramTypes ?? []));
    // Don't await: server response is held until Sync. Capture into
    // pending so sync()/end() can observe completion. Attach a no-op
    // catch so a server-side reject (ParseError) doesn't fire an
    // UnhandledPromiseRejection at process scope before end()/sync()
    // get a chance to allSettle the list.
    this.pending.push(PipelineSession.silenceUnhandled(p));
    return Promise.resolve();
  }

  public bind(name: string, values: unknown[]): Promise<void> {
    this.conn.startExtendedBatch();
    const p = this.conn.enqueueBind();
    const encoded = values.map(toBindValue);
    this.conn.writeRaw(Bind('', name, [], encoded, [0]));
    this.pending.push(PipelineSession.silenceUnhandled(p));
    return Promise.resolve();
  }

  public execute(name: string, maxRows?: number): Promise<void> {
    this.conn.startExtendedBatch();
    // Mirror libpq's PQsendQueryGuts: Describe('P', '') goes between Bind
    // and Execute so RowDescription arrives and the resulting ResultSet
    // carries field metadata (otherwise the printer renders rows with no
    // columns). The Describe op pipes its resolved fields directly onto
    // the upcoming Execute op (see enqueueDescribePortalIntoNextExecute).
    const dp = this.conn.enqueueDescribePortalIntoNextExecute();
    this.pending.push(PipelineSession.silenceUnhandled(dp));
    this.conn.writeRaw(Describe('P', name));
    const ep = this.conn.enqueueExecute();
    this.results.push(PipelineSession.silenceUnhandled(ep));
    this.conn.writeRaw(Execute(name, maxRows ?? 0));
    // Don't await: the ResultSet promise resolves after Sync. It's
    // already in `results` so end() / sync() will surface it.
    return Promise.resolve();
  }

  public describe(name: string): Promise<void> {
    this.conn.startExtendedBatch();
    // psql's `\describe` in pipeline context is portal-targeted.
    const p = this.conn.enqueueDescribePortal();
    this.conn.writeRaw(Describe('P', name));
    this.pending.push(PipelineSession.silenceUnhandled(p));
    return Promise.resolve();
  }

  public close(name: string): Promise<void> {
    this.conn.startExtendedBatch();
    const p = this.conn.enqueueClose();
    this.conn.writeRaw(Close('S', name));
    this.pending.push(PipelineSession.silenceUnhandled(p));
    return Promise.resolve();
  }

  public async flush(): Promise<void> {
    this.conn.writeRaw(Flush());
    // Flush has no reply; resolve immediately. The server will start sending
    // any queued replies it had buffered, which our drive loop consumes.
    await Promise.resolve();
  }

  public async sync(): Promise<void> {
    this.conn.startExtendedBatch();
    const p = this.conn.enqueueSync();
    this.conn.writeRaw(Sync());
    await p;
    // Settle any per-op promises that arrived before this Sync — Parse,
    // Bind, Describe, Close, and Execute. We don't surface their results
    // here (callers consume `results` via end()), but we do need to drain
    // any rejections so Node doesn't see them as unhandled.
    await Promise.allSettled(this.pending.splice(0));
  }

  public async end(): Promise<ResultSet[]> {
    // Send a terminating Sync so the connection settles back to idle.
    this.conn.startExtendedBatch();
    const finalSync = this.conn.enqueueSync();
    this.conn.writeRaw(Sync());
    // Wait for the final Sync's RfQ, but tolerate a sticky pipeline
    // error: enqueueSync rejects when the pipeline ended in error
    // state. `\endpipeline` still needs to harvest the queued
    // ResultSets, so don't propagate this rejection.
    await finalSync.catch((): void => undefined);
    this.conn._extPipelineActive = false;
    // Drain pending ops too — Parse/Bind/Describe/Close that rejected
    // (e.g. bind-param-count mismatch) would otherwise surface as
    // process-level UnhandledPromiseRejection. We only need the
    // settlement; the results aren't surfaced here.
    await Promise.allSettled(this.pending.splice(0));
    const settled = await Promise.allSettled(this.results);
    const out: ResultSet[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') out.push(r.value);
    }
    return out;
  }
}

function toBindValue(v: unknown): Buffer | string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  // Objects, arrays, etc: JSON-stringify deterministically. Falls back to ''
  // if the value is not representable.
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}
