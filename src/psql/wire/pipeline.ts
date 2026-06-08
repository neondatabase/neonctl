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
  /**
   * Per-Execute ResultSet promises, accumulated in the order
   * `execute()` was called. Public-read so `\getresults` (in
   * `cmd_pipeline.ts`) can surface each pending result the moment a
   * Flush / Sync makes the server emit replies — mirroring upstream
   * psql's `exec_command_getresults`, which calls `PQgetResult()` and
   * prints each one inline.
   *
   * Never spliced internally: `\endpipeline` / `\getresults` track
   * their own "drained count" so already-printed results are skipped.
   */
  public readonly results: Promise<ResultSet>[] = [];
  /**
   * Per-USER-COMMAND result slots, one entry per `\sendpipeline` /
   * `\parse NAME` / `\close_prepared NAME` / `\syncpipeline`. Mirrors
   * libpq's per-PQsendQueryParams / PQsendPrepare / PQsendClosePrepared
   * result queue: a single `PQgetResult` call produces one entry from
   * this list (NOT one per wire op — Parse/Bind/Execute together count
   * as ONE entry under `PQsendQueryParams`). The cmd layer drains this
   * via `\getresults` / `\endpipeline` instead of walking `results`
   * directly, so Parse-only and Close-only commands occupy a slot even
   * though they don't push onto `results`.
   *
   * For successful Parse-only / Close-only commands, the slot resolves
   * with a placeholder ResultSet (zero fields, empty `command`); for
   * Execute-bearing commands it resolves with the real ResultSet. On
   * error, the slot rejects with the same `ConnectError` /
   * `pipelineAborted` marker the wire layer cascade-rejects with.
   * SyncMarker slots are `Promise.resolve(syncMarker)` so the drain
   * loop walks past them silently.
   */
  public readonly cmdSlots: Promise<ResultSet>[] = [];

  // Promises for ops whose server-side completion we still need to
  // observe (Parse, Bind, Describe, Close). In pipeline mode the
  // server doesn't reply until the next Sync, so awaiting them in
  // these methods would deadlock — we keep them and let `sync()` /
  // `end()` drain them.
  private readonly pending: Promise<unknown>[] = [];

  /**
   * Per-USER-command "wire ops staged but not yet bound to a cmdSlot".
   * `parse()` / `bind()` push their wire op promise here; the next
   * call that closes the user-level command (`execute()` for
   * `\sendpipeline` / `;`-queries, `parseSlot()` for `\parse NAME`,
   * `closeSlot()` for `\close_prepared NAME`) consumes the staged
   * ops and combines them via `Promise.all` with the final wire op
   * — that way the slot rejects with the FIRST wire-op rejection in
   * the group (which carries the real `ConnectError` for the actual
   * server-side failure) rather than the cascaded `pipelineAborted`
   * marker on the trailing Execute / Close.
   */
  private currentGroup: Promise<unknown>[] = [];

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

  /**
   * Push a synthetic ResultSet slot onto `cmdSlots`. The slot's
   * effective rejection is taken from the FIRST wire-op rejection in
   * the current user-command group ({@link currentGroup}) followed by
   * the final ResultSet promise — mirroring libpq's per-PGresult
   * shape, where the real `ConnectError` lands on the failing wire op
   * (often a Bind / Parse on `pending`, NOT the trailing Execute on
   * `results`). Without this combining, the slot would inherit the
   * cascaded `pipelineAborted` marker from the Execute and the real
   * diagnostic would never reach the cmd layer.
   *
   * The group is reset after consumption so the next user command
   * starts fresh.
   */
  private pushCmdSlot(p: Promise<ResultSet>): void {
    const group = this.currentGroup.splice(0);
    if (group.length === 0) {
      this.cmdSlots.push(PipelineSession.silenceUnhandled(p));
      return;
    }
    // `Promise.all` rejects with the FIRST rejection (in iteration
    // order), so put the group BEFORE the final result: a bind error
    // on `bind` will surface before the cascaded execute marker.
    const combined = Promise.all([...group, p]).then(
      (arr) => arr[arr.length - 1] as ResultSet,
    );
    this.cmdSlots.push(PipelineSession.silenceUnhandled(combined));
  }

  /**
   * Map a wire-op `Promise<void>` to a `Promise<ResultSet>` that
   * resolves with a silent zero-field placeholder when the op
   * completes, or rejects with the same reason if it fails. Used by
   * `parseSlot` / `closeSlot` so a successful Parse / Close walks the
   * `\getresults` drain loop without emitting any output (matching
   * upstream `PQgetResult` for PGRES_COMMAND_OK on Parse / Close).
   */
  private static voidToPlaceholderResult(p: Promise<void>): Promise<ResultSet> {
    return p.then(
      (): ResultSet => ({
        command: '',
        rowCount: null,
        oid: null,
        fields: [],
        rows: [],
        notices: [],
      }),
    );
  }

  public parse(
    name: string,
    sql: string,
    paramTypes?: number[],
  ): Promise<void> {
    // parseRaw already retains the wire promise in `pending` (and
    // silences unhandled rejection); the void return here matches the
    // public Pipeline interface.
    void this.parseRaw(name, sql, paramTypes);
    return Promise.resolve();
  }

  /**
   * Enqueue a Parse op AND register it as a USER-level command slot
   * (one entry on `cmdSlots`). Mirrors {@link parse} — RESOLVES
   * IMMEDIATELY; the underlying wire-op promise's outcome surfaces
   * via `cmdSlots` (drained by `\getresults` / `\endpipeline`).
   * Returning a slot-bound promise would deadlock callers that await
   * it before Sync.
   *
   * Used by `\parse NAME` (standalone Parse). Do NOT use from inside
   * `\sendpipeline` — that path issues an internal `parse('')` for the
   * SQL buffer; the Execute downstream is the user-visible command.
   */
  public async parseSlot(
    name: string,
    sql: string,
    paramTypes?: number[],
  ): Promise<void> {
    const p = this.parseRaw(name, sql, paramTypes);
    const slot = PipelineSession.voidToPlaceholderResult(p);
    this.pushCmdSlot(slot);
    // Resolve immediately, like `parse()`. The slot's outcome flows
    // through `cmdSlots`.
    await Promise.resolve();
  }

  private parseRaw(
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
    const silenced = PipelineSession.silenceUnhandled(p);
    this.pending.push(silenced);
    // Stage on the current command group so a downstream cmdSlot push
    // can fold this Parse's rejection into the slot (e.g. a Parse-error
    // in `\sendpipeline`'s internal `parse('', sql)` must surface as
    // the slot's rejection, not the cascaded marker on Execute).
    this.currentGroup.push(silenced);
    return p;
  }

  public bind(name: string, values: unknown[]): Promise<void> {
    this.conn.startExtendedBatch();
    const p = this.conn.enqueueBind();
    const encoded = values.map(toBindValue);
    this.conn.writeRaw(Bind('', name, [], encoded, [0]));
    const silenced = PipelineSession.silenceUnhandled(p);
    this.pending.push(silenced);
    // Stage on the current command group so the next slot-pushing op
    // (typically `execute()` for `\sendpipeline`) combines this
    // Bind's rejection into the slot — see {@link pushCmdSlot}.
    this.currentGroup.push(silenced);
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
    const silencedDp = PipelineSession.silenceUnhandled(dp);
    this.pending.push(silencedDp);
    // Stage DescribePortal on the current group too — its rejection
    // would otherwise be invisible to the slot.
    this.currentGroup.push(silencedDp);
    this.conn.writeRaw(Describe('P', name));
    const ep = this.conn.enqueueExecute();
    this.results.push(PipelineSession.silenceUnhandled(ep));
    // Each Execute is one libpq-level user command (the Parse + Bind
    // that precede it are accounted to the same PQsendQueryParams /
    // `\sendpipeline` slot). Mirror that on `cmdSlots` so `\getresults`
    // walks one entry per user command; the slot folds in any group
    // ops staged by parse() / bind() / DescP above.
    this.pushCmdSlot(ep);
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
    void this.closeRaw(name);
    return Promise.resolve();
  }

  /**
   * Enqueue a Close op AND register it as a user-level command slot.
   * Resolves immediately (see {@link parseSlot} for rationale); the
   * slot's outcome surfaces via `cmdSlots`.
   */
  public async closeSlot(name: string): Promise<void> {
    const p = this.closeRaw(name);
    const slot = PipelineSession.voidToPlaceholderResult(p);
    this.pushCmdSlot(slot);
    await Promise.resolve();
  }

  private closeRaw(name: string): Promise<void> {
    this.conn.startExtendedBatch();
    const p = this.conn.enqueueClose();
    this.conn.writeRaw(Close('S', name));
    const silenced = PipelineSession.silenceUnhandled(p);
    this.pending.push(silenced);
    this.currentGroup.push(silenced);
    return p;
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
    // Each `\syncpipeline` registers an additional "result-queue
    // entry" the caller must drain via `\getresults` — vanilla psql
    // 18.4 surfaces this as the PGRES_PIPELINE_SYNC marker libpq
    // pushes onto its result queue. The conformance test at SQL
    // line 184 (`\syncpipeline count as one command to fetch for
    // \getresults`) expects exactly this drain accounting. We
    // simulate it by pushing an empty (zero-fields) ResultSet
    // promise into the per-Execute queue — `\getresults` skips
    // printing it (the empty-fields guard) but advances `drainedCount`
    // by one, matching upstream's libpq queue layout.
    const syncMarker: ResultSet = {
      command: '',
      rowCount: null,
      oid: null,
      fields: [],
      rows: [],
      notices: [],
    };
    this.results.push(Promise.resolve(syncMarker));
    // Mirror libpq's per-command result queue: each `\syncpipeline`
    // adds exactly one PGRES_PIPELINE_SYNC entry that `\getresults`
    // walks past silently (counted, but not printed). See {@link cmdSlots}.
    // SyncMarker is its own slot, so clear any half-built command
    // group (e.g. a stray `bind()` that wasn't followed by `execute()`)
    // before pushing — otherwise the SyncMarker slot would inherit
    // stale group rejections. Spliced promises were already silenced
    // and tracked on `pending`, so discarding the splice return is
    // safe (no unhandled-rejection escape).
    void this.currentGroup.splice(0);
    this.cmdSlots.push(Promise.resolve(syncMarker));
    // Don't propagate a non-FATAL ErrorResponse here: upstream
    // `\syncpipeline` is silent on stderr — the server-side error
    // surfaces at `\endpipeline` time (see expected/psql_pipeline.out
    // line 433 where the ParseError is printed AFTER the trailing
    // `\endpipeline` echo, not inline with `\syncpipeline`). Stash
    // it on `_lastError` instead so the cmd layer can render it
    // when the pipeline drains.
    await p.catch((err: unknown): void => {
      if (this._lastError === null) this._lastError = err;
    });
    // Settle any per-op promises that arrived before this Sync — Parse,
    // Bind, Describe, Close, and Execute. We don't surface their results
    // here (callers consume `results` via end()), but we do need to drain
    // any rejections so Node doesn't see them as unhandled. The first
    // rejection becomes the sticky `_lastError` if Sync itself was clean.
    const settled = await Promise.allSettled(this.pending.splice(0));
    for (const r of settled) {
      if (r.status === 'rejected' && this._lastError === null) {
        this._lastError = r.reason;
      }
    }
  }

  /**
   * Sticky pipeline error captured by the final Sync inside `end()`.
   * Non-FATAL ERROR-class diagnostics (e.g. "could not determine data
   * type of parameter $1", "bind message supplies N parameters")
   * arrive on the wire as `ErrorResponse` and reject the Sync op, but
   * the pipeline session must still surface the queued ResultSets so
   * `\endpipeline` can print them. The cmd layer reads this after
   * `end()` resolves and renders the ERROR line via `writeQueryError`.
   *
   * `null` until end() finishes; thereafter holds the first non-FATAL
   * error seen, or `null` if the pipeline drained cleanly.
   */
  private _lastError: unknown = null;
  public get lastError(): unknown {
    return this._lastError;
  }
  /**
   * Drop any sticky error stashed via `_lastError = err` AND latch a
   * "do not re-stash" sentinel so the next `end()` won't overwrite the
   * cleared state from its final-Sync `fatal` capture or its per-op
   * rejection scan. Used by `\getresults` when it surfaced a rejection
   * inline so the follow-on `\endpipeline` doesn't re-emit the same
   * diagnostic.
   *
   * The sentinel only applies to the IMMEDIATELY-FOLLOWING `end()`
   * call: if a fresh error arrives on the wire AFTER clearLastError
   * (e.g. a `\sendpipeline` queued after the `\getresults` that
   * itself triggers a server-side ERROR), `_lastError` is re-armed
   * normally because the per-op rejection scan only skips entries
   * the cmd layer has already inspected (see `_externalDrained`).
   */
  public clearLastError(): void {
    this._lastError = null;
    this._errorConsumedExternally = true;
  }
  private _errorConsumedExternally = false;

  /**
   * Number of entries from `results` that the cmd layer (`\getresults`)
   * has already inspected. `end()`'s post-Sync per-op scan starts at
   * this offset so a rejection that was already surfaced inline by
   * `\getresults` doesn't get re-stashed on `_lastError` and re-rendered
   * by `\endpipeline`.
   */
  private _externalDrained = 0;
  public markDrained(count: number): void {
    if (count > this._externalDrained) this._externalDrained = count;
  }

  /**
   * Peek at the FIRST real (non-`pipelineAborted`) rejection anywhere
   * in `pending` ∪ `results`, INSPECTING ONLY promises that are already
   * settled. Used by `\getresults` / `\endpipeline` to find the
   * originating diagnostic when the wire layer's cascade-reject landed
   * the real `ConnectError` on a `pending` Parse/Bind/Close (not visible
   * to `results`-only walks) and stamped `pipelineAborted` onto the
   * visible Execute slots.
   *
   * Each candidate is raced against a microtask-resolved sentinel so a
   * still-pending promise (e.g. the next Execute waiting for its
   * Sync round-trip) doesn't block the peek. Returns `null` when
   * nothing has rejected yet — or when the only rejections so far are
   * the synthetic `pipelineAborted` marker.
   */
  public async peekRealError(): Promise<unknown> {
    const allP = [...this.pending, ...this.results];
    const sentinel = Symbol('pending');
    // Race each candidate against a `setImmediate`-deferred sentinel so
    // any promise that was already settled (synchronously, e.g. by the
    // wire layer's cascade-reject inside its ErrorResponse handler) has
    // a full microtask drain to fulfil its `.then(...)` chain before
    // the sentinel resolves. A bare `Promise.resolve(sentinel)` would
    // race in the same microtask tier and the sentinel sometimes wins
    // even when the candidate has a settled value — that's the
    // ordering quirk this `setImmediate` step pins down.
    const deferred = (): Promise<typeof sentinel> =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolve(sentinel);
        }),
      );
    for (const p of allP) {
      const r = (await Promise.race([
        p.then(
          (v): { status: 'fulfilled'; value: unknown } => ({
            status: 'fulfilled',
            value: v,
          }),
          (e: unknown): { status: 'rejected'; reason: unknown } => ({
            status: 'rejected',
            reason: e,
          }),
        ),
        deferred(),
      ])) as
        | { status: 'fulfilled'; value: unknown }
        | { status: 'rejected'; reason: unknown }
        | typeof sentinel;
      if (r === sentinel) continue;
      if (r.status !== 'rejected') continue;
      const reason = r.reason;
      const isAborted =
        typeof reason === 'object' &&
        reason !== null &&
        (reason as { pipelineAborted?: boolean }).pipelineAborted === true;
      if (!isAborted) return reason;
    }
    return null;
  }

  public async end(): Promise<ResultSet[]> {
    // Send a terminating Sync so the connection settles back to idle.
    this.conn.startExtendedBatch();
    const finalSync = this.conn.enqueueSync();
    this.conn.writeRaw(Sync());
    // Wait for the final Sync's RfQ, but tolerate a sticky pipeline
    // error: enqueueSync rejects when the pipeline ended in error
    // state. `\endpipeline` still needs to harvest the queued
    // ResultSets, so we capture rather than propagate immediately.
    let fatal: unknown = null;
    await finalSync.catch((err: unknown): void => {
      fatal = err;
    });
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
    // FATAL-class pipeline aborts (e.g. "COPY in a pipeline is not
    // supported, aborting connection") must surface to the caller so
    // `\endpipeline` can render the diagnostic on stderr. Plain
    // per-op errors stay swallowed so a partial pipeline still
    // returns its successful results — but we stash them on
    // `_lastError` so the cmd layer can print them inline.
    if (fatal !== null) {
      const sev = (fatal as { severity?: string }).severity;
      if (sev === 'FATAL') {
        if (fatal instanceof Error) throw fatal;
        const msg =
          (fatal as { message?: string }).message ?? 'pipeline aborted';
        throw Object.assign(new Error(msg), fatal as object);
      }
      // Non-FATAL (typically ERROR) — keep for the cmd layer, unless
      // `\getresults` already consumed the diagnostic (see
      // `clearLastError()` / `_errorConsumedExternally`). In that case
      // the same rejection is mirrored on the final Sync — re-stashing
      // it here would cause `\endpipeline` to double-print.
      if (!this._errorConsumedExternally) {
        this._lastError = fatal;
      }
    } else if (this._lastError === null) {
      // Also scan the settled per-op promises: a ParseError /
      // BindError that arrived BEFORE the final Sync rejects its own
      // op promise but the Sync may still resolve cleanly (the
      // server marks subsequent ops as "Pipeline aborted, command
      // did not run" instead of erroring). The conformance corpus
      // expects the first ErrorResponse to surface at `\endpipeline`
      // time, so we hunt for the first rejected per-op promise — but
      // skip entries that `\getresults` already inspected and surfaced
      // inline (tracked via `markDrained`). Without this, the same
      // rejection would re-stash on `_lastError` and `\endpipeline`
      // would double-print the diagnostic.
      //
      // Don't OVERWRITE an existing `_lastError`: a prior `sync()`
      // (via `\syncpipeline`) may have already stashed the real
      // ConnectError for an earlier batch, and the second batch's
      // results carry only `pipelineAborted` markers which would
      // shadow the real diagnostic if blindly assigned here. The
      // outer `if (this._lastError === null)` guard makes this a
      // first-wins capture.
      for (let i = this._externalDrained; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'rejected') {
          this._lastError = r.reason;
          break;
        }
      }
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
