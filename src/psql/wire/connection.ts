/**
 * PgConnection — the wire-layer Connection implementation (WP-02 + WP-16).
 *
 * Implements `Connection` (frozen WP-00 interface in
 * `src/psql/types/connection.ts`) on top of a single TCP / TLS socket. The
 * class is essentially a state machine:
 *
 *   auth        → drive Authentication* messages
 *   await-ready → collect ParameterStatus + BackendKeyData
 *   idle        → ready for a Query / extended-protocol cycle
 *   in-query    → simple Query in flight, accumulating ResultSets
 *   in-copy-in  → COPY FROM STDIN data transfer in progress (WP-16)
 *   in-copy-out → COPY TO STDOUT data transfer in progress (WP-16)
 *   closed      → socket gone
 *
 * What this module owns:
 *   - Socket lifecycle (open, optional TLS, Terminate, close).
 *   - Auth: Cleartext, MD5, SASL/SCRAM (delegating to ./sasl.ts).
 *   - Tracking server `serverVersion` from ParameterStatus.
 *   - Simple-query path (`execSimple`) — collect RowDescription/DataRow/
 *     CommandComplete tuples into ResultSet[].
 *   - Async messages (Notice, Notification) routed through ./notify.ts.
 *   - ErrorResponse → rejected promise mapped to ConnectError shape.
 *   - Async cancel via a side connection (CancelRequest).
 *   - COPY streaming (WP-16): `startCopyIn` returns a `CopyInStream` that
 *     wires CopyData / CopyDone / CopyFail; `startCopyOut` returns an
 *     `AsyncIterable<Buffer>` that drains CopyData messages from the wire.
 *     The state machine threads through `in-copy-in` / `in-copy-out`.
 *
 * What is stubbed / deferred:
 *   - Extended-query protocol (Parse/Bind/Execute/Sync). The framing is in
 *     protocol.ts but the high-level path (parameterised `query()`, prepared
 *     statements, pipeline) is WP-21. We throw clearly when called.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import type {
  ConnectError,
  ConnectOptions,
  Connection,
  CopyInStream,
  CopyOutStream,
  FieldDescription,
  Notice,
  Pipeline,
  PreparedStatement,
  ResultSet,
} from '../types/connection.js';

import {
  Bind,
  CancelRequest,
  Close,
  CopyData,
  CopyDone,
  CopyFail,
  Describe,
  Execute,
  fieldsToNotice,
  MessageParser,
  Parse,
  PasswordMessage,
  Query,
  SASLInitialResponse,
  SASLResponse,
  StartupMessage,
  Sync,
  Terminate,
} from './protocol.js';
import type { BackendMessage } from './protocol.js';

import { PipelineSession } from './pipeline.js';

import { createScramClient } from './sasl.js';
import type { ScramClient } from './sasl.js';

import { negotiateTls } from './tls.js';
import { NoticeMultiplexer } from './notify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AnySocket = net.Socket | tls.TLSSocket;

type PendingQuery = {
  resolve: (rs: ResultSet[]) => void;
  reject: (err: unknown) => void;
  current: ResultSet | null;
  finished: ResultSet[];
  notices: Notice[];
  /** First error during the query — surfaced once ReadyForQuery arrives. */
  error: ConnectError | null;
};

/**
 * Map a Notice-flavoured fields map into a `ConnectError` that includes a
 * recognizable `message` plus a `cause` slot for the raw record.
 */
function fieldsToConnectError(fields: Map<string, string>): ConnectError {
  return { ...fieldsToNotice(fields), cause: fields };
}

/** Parse "PostgreSQL 16.2 …" into a numeric `major * 10000 + minor * 100`. */
function parseServerVersion(value: string): number {
  // libpq's PQserverVersion returns NNNNNN (e.g. 160002 for 16.2). For
  // pre-10 versions the layout was NNMMSS (e.g. 90608 for 9.6.8). Our
  // consumers only need monotonic comparability and a major-version
  // accessor; the libpq formula is the simplest match.
  const m = /^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/.exec(value);
  if (!m) return 0;
  const major = parseInt(m[1], 10);
  const minor = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  if (major >= 10) {
    return major * 10000 + minor;
  }
  const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  return major * 10000 + minor * 100 + patch;
}

/**
 * MD5 auth: `'md5' + md5( md5(password + user) || salt )`. Inner hash uses
 * the username; outer is salted. PG uses lowercase hex everywhere.
 */
function md5AuthPayload(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5')
    .update(password + user, 'utf8')
    .digest('hex');
  const outer = createHash('md5')
    .update(inner, 'utf8')
    .update(salt)
    .digest('hex');
  return 'md5' + outer;
}

/**
 * Fisher-Yates in-place shuffle of the candidate hosts list. Used by
 * `load_balance_hosts=random`. Hook the random source so tests can inject a
 * deterministic permutation.
 */
function shuffleInPlace(
  arr: { host: string; port: number }[],
  rng: () => number = Math.random,
): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * After a successful handshake, decide whether this connection matches the
 * caller's `target_session_attrs` constraint by running
 * `SELECT pg_is_in_recovery()`. Returns `true` if the connection is
 * acceptable, `false` if it should be torn down and the next host tried.
 *
 *   - 'any' (or undefined) — always accepts.
 *   - 'read-write' / 'primary' — accepts when NOT in recovery.
 *   - 'read-only' / 'standby' — accepts when IN recovery.
 *
 * If the probe query itself fails we treat the connection as unacceptable
 * (returns false) so the orchestrator falls through to the next candidate
 * rather than handing the caller a half-broken connection.
 */
async function checkSessionAttrs(
  conn: PgConnection,
  tsa: ConnectOptions['targetSessionAttrs'],
): Promise<boolean> {
  if (tsa === undefined || tsa === 'any') return true;
  let inRecovery: boolean;
  try {
    const sets = await conn.execSimple('SELECT pg_is_in_recovery()');
    if (sets.length === 0 || sets[0].rows.length === 0) {
      return false;
    }
    const raw = sets[0].rows[0][0];
    // pg_is_in_recovery returns boolean; text-format rows surface as
    // 't' / 'f'. Be liberal: also handle 'true' / 'false'.
    if (raw === true) {
      inRecovery = true;
    } else if (raw === false) {
      inRecovery = false;
    } else if (typeof raw === 'string') {
      inRecovery = raw === 't' || raw.toLowerCase() === 'true';
    } else {
      return false;
    }
  } catch {
    return false;
  }
  switch (tsa) {
    case 'read-write':
    case 'primary':
      return !inRecovery;
    case 'read-only':
    case 'standby':
      return inRecovery;
    // 'prefer-standby' is unwrapped by the orchestrator into two passes
    // ('standby' then 'any'), so we never see it here. Fall through to
    // accept-any for safety.
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// PgConnection
// ---------------------------------------------------------------------------

type ConnectionState =
  | 'auth'
  | 'await-ready'
  | 'idle'
  | 'in-query'
  | 'in-extended'
  | 'in-copy-in'
  | 'in-copy-out'
  | 'closed';

/**
 * One operation queued in the extended-protocol pipeline (WP-21). The
 * pipeline is driven by enqueueing a sequence of operations (Parse, Bind,
 * Describe, Execute, Close, Sync) and processing the backend's reply stream
 * against the head of the queue.
 *
 *   Parse        → ParseComplete
 *   Bind         → BindComplete
 *   Describe(S)  → ParameterDescription + RowDescription | NoData
 *   Describe(P)  → RowDescription | NoData
 *   Execute      → CommandComplete | EmptyQueryResponse | PortalSuspended
 *   Close        → CloseComplete
 *   Sync         → ReadyForQuery (also acts as an error barrier)
 *
 * If the server sends an ErrorResponse, we record the sticky error on the
 * driver, reject the head non-Sync op, and reject any subsequent non-Sync
 * ops as PG skips them until the next Sync. The Sync op then resolves on
 * ReadyForQuery, clearing the error state so a fresh batch can run.
 */
type ExtOp =
  | {
      kind: 'parse';
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: 'bind';
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: 'describeS';
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      paramOids: number[] | null;
    }
  | {
      kind: 'describeP';
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: 'execute';
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      current: ResultSet | null;
      notices: Notice[];
      fields: FieldDescription[] | null;
    }
  | {
      kind: 'close';
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: 'sync';
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    };

type ExtDriver = {
  queue: ExtOp[];
  /** Sticky error since the last Sync; cleared when Sync's RfQ arrives. */
  error: ConnectError | null;
};

/**
 * COPY-IN driver state shared between {@link PgConnection.startCopyIn} and the
 * `in-copy-in` branch of {@link PgConnection.dispatch}. The frontend has
 * committed to a COPY FROM STDIN exchange; we accept `write(chunk)` calls
 * which wire CopyData, and `end()` / `fail(reason)` which wire CopyDone /
 * CopyFail respectively. The promise returned by `end()` / `fail()` resolves
 * once the trailing CommandComplete + ReadyForQuery arrive.
 */
type CopyInDriver = {
  resolveDone: (() => void) | null;
  rejectDone: ((err: unknown) => void) | null;
  /** First ErrorResponse during the COPY — surfaced when ReadyForQuery hits. */
  error: ConnectError | null;
  /** Last CommandComplete tag (e.g. "COPY 17"). */
  commandTag: string | null;
  /** Whether we've already wired CopyDone/CopyFail. */
  closed: boolean;
};

/**
 * COPY-OUT driver state shared between {@link PgConnection.startCopyOut} and
 * the `in-copy-out` branch of {@link PgConnection.dispatch}. Drains CopyData
 * messages into a bounded queue that the AsyncIterable consumer pulls from.
 */
type CopyOutDriver = {
  /** Buffered CopyData payloads waiting for consumer. */
  queue: Buffer[];
  /** Pending consumer waker; set when the queue is empty. */
  waker: (() => void) | null;
  /** Set once CopyDone + CommandComplete + ReadyForQuery have arrived. */
  done: boolean;
  /** First ErrorResponse during the COPY — surfaced when ReadyForQuery hits. */
  error: ConnectError | null;
  /** Last CommandComplete tag (e.g. "COPY 17"). */
  commandTag: string | null;
};

export class PgConnection implements Connection {
  // -- Socket + framing
  private readonly socket: AnySocket;
  private readonly parser: MessageParser = new MessageParser();
  private readonly opts: ConnectOptions;

  // -- Backend state
  public serverVersion = 0;
  private readonly params = new Map<string, string>();
  private processId = 0;
  private secretKey = 0;
  private txStatus: 'I' | 'T' | 'E' = 'I';

  // -- Connection state machine
  private state: ConnectionState = 'auth';
  private pendingQuery: PendingQuery | null = null;
  private extDriver: ExtDriver | null = null;
  /** True when `pipeline()` has handed out a PipelineSession (WP-21). */
  public _extPipelineActive = false;
  private copyIn: CopyInDriver | null = null;
  private copyOut: CopyOutDriver | null = null;
  /**
   * Resolver for `startCopyIn` / `startCopyOut`. Captured when the caller has
   * already wired the `Query(COPY …)` and is now waiting for the server's
   * CopyInResponse / CopyOutResponse to confirm that the protocol switched.
   */
  private copyStartResolve: (() => void) | null = null;
  private copyStartReject: ((err: unknown) => void) | null = null;

  /**
   * Last-COPY command tag (e.g. `"COPY 17"`), or `null` if no COPY has run
   * since connection startup. Used by the `\copy` command runner to print the
   * upstream-style "COPY N" footer.
   */
  public lastCopyTag: string | null = null;

  /**
   * Password captured at connect time, retained in memory so that `\c` can
   * reconnect without re-supplying credentials (matching libpq's behaviour,
   * which keeps the password on the live `PGconn`). `null` when no password
   * was provided. Read via the {@link password} getter.
   */
  private readonly _password: string | null;

  // -- Async messages
  private readonly notify: NoticeMultiplexer = new NoticeMultiplexer();

  // -- Auth state (only used during state=auth)
  private scram: ScramClient | null = null;
  private readonly channelBindingData: Buffer | null;

  // -- Error-after-close guard
  private socketError: Error | null = null;

  private constructor(
    socket: AnySocket,
    opts: ConnectOptions,
    channelBindingData: Buffer | null,
  ) {
    this.socket = socket;
    this.opts = opts;
    this.channelBindingData = channelBindingData;
    this._password = opts.password ?? null;

    socket.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on('error', (err) => {
      this.socketError = err;
      this.failPending(err);
    });
    socket.on('close', () => {
      if (this.state !== 'closed') {
        this.state = 'closed';
        this.failPending(this.socketError ?? new Error('Socket closed'));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Public factory
  // -------------------------------------------------------------------------

  /**
   * Pluggable random source for `load_balance_hosts=random`. Public so tests
   * can inject a deterministic permutation; production code leaves it `null`
   * and falls back to `Math.random`. NOT part of the connection's external
   * contract — internal-only escape hatch.
   */
  public static _loadBalanceRng: (() => number) | null = null;

  /**
   * Open a Postgres connection. Supports multi-host (`opts.hosts`) with
   * sequential or random iteration, a `target_session_attrs` filter, and the
   * libpq-style `prefer-standby` two-pass fallback.
   *
   * Iteration semantics:
   *   1. Build the candidate list from `opts.hosts` (preferred) or
   *      `[{host: opts.host, port: opts.port}]`.
   *   2. If `loadBalanceHosts === 'random'`, Fisher-Yates shuffle in place.
   *   3. For each candidate (in order), attempt: openSocket → TLS → auth →
   *      startup. On failure, record the error and try the next.
   *   4. On successful handshake, if `target_session_attrs` is restrictive,
   *      run `SELECT pg_is_in_recovery()`. If the role doesn't match, close
   *      this connection and try the next.
   *   5. `prefer-standby` runs TWO passes: first accepting only standbys,
   *      second falling back to any host.
   *   6. If no candidate succeeds, throw the LAST encountered error
   *      (preserves the most-recent failure mode for diagnostics).
   */
  public static async connect(opts: ConnectOptions): Promise<PgConnection> {
    const candidates =
      opts.hosts !== undefined && opts.hosts.length > 0
        ? [...opts.hosts]
        : [{ host: opts.host, port: opts.port }];

    if (opts.loadBalanceHosts === 'random') {
      shuffleInPlace(candidates, PgConnection._loadBalanceRng ?? Math.random);
    }

    const tsa = opts.targetSessionAttrs ?? 'any';
    // `prefer-standby` runs two passes: first 'standby', then 'any'. Every
    // other mode runs a single pass with the literal target.
    const passes: ConnectOptions['targetSessionAttrs'][] =
      tsa === 'prefer-standby' ? ['standby', 'any'] : [tsa];

    let lastErr: unknown = null;
    for (const passTsa of passes) {
      for (const candidate of candidates) {
        const candidateOpts: ConnectOptions = {
          ...opts,
          host: candidate.host,
          port: candidate.port,
        };
        let conn: PgConnection;
        try {
          conn = await PgConnection.connectSingle(candidateOpts);
        } catch (err) {
          lastErr = err;
          continue;
        }
        // Apply target_session_attrs filter via pg_is_in_recovery().
        const accepted = await checkSessionAttrs(conn, passTsa);
        if (accepted) {
          return conn;
        }
        // Mismatch: close this connection and move on.
        try {
          await conn.close();
        } catch {
          // ignore
        }
        lastErr = new Error(
          `target_session_attrs=${String(passTsa)} did not match host ${candidate.host}:${String(candidate.port)}`,
        );
      }
    }
    if (lastErr !== null) {
      // `throw lastErr` would trip the `only-throw-error` lint rule because
      // `lastErr` is typed `unknown`. Normalise to an Error for the throw
      // while preserving the original via `cause` so callers can introspect.
      if (lastErr instanceof Error) throw lastErr;
      let message: string;
      if (
        typeof lastErr === 'object' &&
        lastErr !== null &&
        'message' in lastErr &&
        typeof (lastErr as { message: unknown }).message === 'string'
      ) {
        message = (lastErr as { message: string }).message;
      } else if (
        typeof lastErr === 'string' ||
        typeof lastErr === 'number' ||
        typeof lastErr === 'boolean'
      ) {
        message = String(lastErr);
      } else {
        message = 'PgConnection.connect: unknown error';
      }
      const wrapped = new Error(message);
      (wrapped as Error & { cause?: unknown }).cause = lastErr;
      throw wrapped;
    }
    throw new Error('PgConnection.connect: no candidate hosts configured');
  }

  /**
   * Per-host connect attempt: open the socket, negotiate TLS, run the auth
   * dance, complete startup. Same shape as the pre-multihost `connect()`;
   * the multi-host orchestrator above wraps this for each candidate.
   */
  private static async connectSingle(
    opts: ConnectOptions,
  ): Promise<PgConnection> {
    // TLS over Unix-domain sockets is meaningless (the kernel guarantees
    // the channel) and libpq refuses `sslmode=require|verify-*` for socket
    // connections. We mirror the early rejection so a misconfigured caller
    // gets a clear diagnostic instead of a confused TLS handshake.
    if (
      isUnixSocketHost(opts.host) &&
      (opts.ssl === 'require' ||
        opts.ssl === 'verify-ca' ||
        opts.ssl === 'verify-full')
    ) {
      throw new Error(
        `sslmode=${opts.ssl} is not supported over Unix-domain sockets (host=${opts.host})`,
      );
    }

    const rawSocket = await openSocket(opts);
    let socket: AnySocket = rawSocket;
    let channelBindingData: Buffer | null = null;
    try {
      const tlsResult = await negotiateTls(
        rawSocket,
        // libpq refuses TLS on a socket connection even for sslmode=allow /
        // prefer — instead of negotiating it just stays plain. We short-
        // circuit by passing 'disable' to negotiateTls; the caller's
        // requested sslmode is preserved on opts for error reporting.
        isUnixSocketHost(opts.host) ? 'disable' : opts.ssl,
        {
          servername: opts.host,
          // verify-ca skips hostname check; verify-full = default Node behavior.
          // require/prefer/allow accept any cert chain (libpq default).
          rejectUnauthorized:
            opts.ssl === 'verify-ca' || opts.ssl === 'verify-full',
          checkServerIdentity:
            opts.ssl === 'verify-full' ? undefined : () => undefined,
          // PG 17+ advertises ALPN for the 'postgresql' protocol; libpq sets
          // this so a future-proof TLS proxy can route on ALPN instead of
          // probing the wire. Always offer it — older servers ignore.
          ALPNProtocols: ['postgresql'],
          // Cipher preference is left to Node/OpenSSL defaults. Vanilla psql
          // may negotiate AES_256_GCM where we land on AES_128_GCM under TLS
          // 1.3; both are secure (TLS 1.3 only ships these three suites) and
          // Node's `ciphers` option only accepts TLS-1.2 spec syntax, not the
          // TLS_AES_* TLS-1.3 names.
        },
        {
          sslcert: opts.sslcert,
          sslkey: opts.sslkey,
          sslrootcert: opts.sslrootcert,
          sslcrl: opts.sslcrl,
        },
      );
      if (tlsResult.kind === 'tls') {
        socket = tlsResult.socket;
        channelBindingData = tlsResult.channelBindingData;
      } else {
        socket = tlsResult.socket;
      }
    } catch (err) {
      try {
        rawSocket.destroy();
      } catch {
        // ignore
      }
      throw err;
    }

    const conn = new PgConnection(socket, opts, channelBindingData);
    await conn.startup();
    return conn;
  }

  // -------------------------------------------------------------------------
  // Connection interface — public methods
  // -------------------------------------------------------------------------

  public parameterStatus(name: string): string | undefined {
    return this.params.get(name);
  }

  /**
   * Expose the connection target as `meta.database` / `meta.user` / `meta.host`
   * / `meta.port` / `meta.pid` so the prompt renderer (which duck-types these
   * via `MaybeWithMeta`) can render `%/`, `%n`, `%m`, `%>`, `%p` without
   * additional plumbing. Postgres doesn't emit a `database` ParameterStatus,
   * so these come from the connect opts / BackendKeyData.
   */
  public get database(): string {
    return this.opts.database;
  }
  public get user(): string {
    return this.opts.user;
  }
  public get host(): string {
    return this.opts.host;
  }
  public get port(): number {
    return this.opts.port;
  }
  public get pid(): number {
    return this.processId;
  }
  /**
   * The password supplied at connect time (or `null`). Mirrors libpq's
   * retention of the password on the live `PGconn` so `\c <newdb>` can
   * reconnect transparently. Read-only by design — the field is set once in
   * the constructor and never mutated.
   */
  public get password(): string | null {
    return this._password;
  }

  /**
   * If the connection was upgraded to TLS during negotiation, return the
   * cipher info for the active session. Returns `null` for plain-text
   * connections. Used by the startup banner to render an `SSL connection
   * (protocol: …, cipher: …)` line that mirrors upstream psql.
   */
  public getTlsInfo(): {
    protocol: string;
    cipher: string;
    standardName?: string;
    /** "off" for TLS≥1.3 (compression disabled by spec) or no support. */
    compression: string;
    /** ALPN protocol negotiated, or null if none. */
    alpn: string | null;
  } | null {
    const s = this.socket as tls.TLSSocket;
    if (typeof s.getCipher !== 'function') return null;
    try {
      const cipher = s.getCipher();
      const protocol = s.getProtocol?.() ?? cipher.version ?? 'unknown';
      if (!cipher.name) return null;
      // TLS compression has been disabled by every modern stack since CRIME
      // (2012); Node's TLS doesn't expose a compression accessor, so we
      // always report "off". libpq does the same.
      const compression = 'off';
      // Node exposes the negotiated ALPN protocol on TLSSocket.alpnProtocol
      // (string when negotiated, false when not). Postgres 17+ uses
      // 'postgresql' here.
      const alpnRaw = (s as unknown as { alpnProtocol?: string | false })
        .alpnProtocol;
      const alpn =
        typeof alpnRaw === 'string' && alpnRaw.length > 0 ? alpnRaw : null;
      return {
        protocol: String(protocol),
        cipher: cipher.standardName ?? cipher.name,
        standardName: cipher.standardName,
        compression,
        alpn,
      };
    } catch {
      return null;
    }
  }

  public async query(sql: string, params?: unknown[]): Promise<ResultSet> {
    if (!params || params.length === 0) {
      const sets = await this.execSimple(sql);
      if (sets.length === 0) {
        throw new Error('PgConnection.query: server returned no result sets');
      }
      return sets[sets.length - 1];
    }
    // Extended-protocol single-shot: Parse('', sql, []) → Bind('', '', [],
    // text-encoded params, [text]) → Describe('P', '') → Execute('', 0) →
    // Sync. Every param goes out in text format and the server coerces.
    this.ensureIdle();
    const encoded = encodeParams(params);
    this.startExtendedBatch();
    const parseP = this.enqueueParse();
    const bindP = this.enqueueBind();
    const descP = this.enqueueDescribePortalIntoNextExecute();
    const execP = this.enqueueExecute();
    const syncP = this.enqueueSync();
    this.socket.write(Parse('', sql, []));
    this.socket.write(Bind('', '', [], encoded, [0]));
    this.socket.write(Describe('P', ''));
    this.socket.write(Execute('', 0));
    this.socket.write(Sync());
    let firstErr: unknown = null;
    const cap = (e: unknown): void => {
      if (firstErr === null) firstErr = e;
    };
    parseP.catch(cap);
    bindP.catch(cap);
    descP.catch(cap);
    let result: ResultSet | null = null;
    execP.then((rs) => {
      result = rs;
    }, cap);
    await syncP.catch(cap);
    if (firstErr !== null) throw asThrowable(firstErr);
    if (result === null) {
      throw new Error('PgConnection.query: server returned no result');
    }
    return result;
  }

  public async execSimple(sql: string): Promise<ResultSet[]> {
    this.ensureIdle();
    return new Promise<ResultSet[]>((resolve, reject) => {
      this.pendingQuery = {
        resolve,
        reject,
        current: null,
        finished: [],
        notices: [],
        error: null,
      };
      this.state = 'in-query';
      this.socket.write(Query(sql));
    });
  }

  public async prepare(
    name: string,
    sql: string,
    paramTypes?: number[],
  ): Promise<PreparedStatement> {
    this.ensureIdle();
    const oids = paramTypes ?? [];
    this.startExtendedBatch();
    const parseP = this.enqueueParse();
    const descP = this.enqueueDescribeStatement();
    const syncP = this.enqueueSync();
    this.socket.write(Parse(name, sql, oids));
    this.socket.write(Describe('S', name));
    this.socket.write(Sync());
    let firstErr: unknown = null;
    const cap = (e: unknown): void => {
      if (firstErr === null) firstErr = e;
    };
    parseP.catch(cap);
    let descResult: { paramOids: number[]; fields: FieldDescription[] } | null =
      null;
    descP.then((r) => {
      descResult = r;
    }, cap);
    await syncP.catch(cap);
    if (firstErr !== null) throw asThrowable(firstErr);
    if (descResult === null) {
      throw new Error(
        'PgConnection.prepare: server returned no parameter description',
      );
    }
    const { paramOids, fields } = descResult;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const conn = this;
    return {
      name,
      paramTypes: paramOids,
      async bind(values: unknown[], paramFormats?: (0 | 1)[]): Promise<void> {
        conn.ensureIdle();
        const encoded = encodeParams(values);
        conn.startExtendedBatch();
        const bP = conn.enqueueBind();
        const sP = conn.enqueueSync();
        conn.socket.write(Bind('', name, paramFormats ?? [], encoded, [0]));
        conn.socket.write(Sync());
        let err: unknown = null;
        bP.catch((e: unknown) => {
          if (err === null) err = e;
        });
        await sP.catch((e: unknown) => {
          if (err === null) err = e;
        });
        if (err !== null) throw asThrowable(err);
      },
      describe(): Promise<FieldDescription[]> {
        return Promise.resolve(fields);
      },
      async execute(maxRows?: number): Promise<ResultSet> {
        conn.ensureIdle();
        conn.startExtendedBatch();
        const eP = conn.enqueueExecuteWithFields(fields);
        const sP = conn.enqueueSync();
        conn.socket.write(Execute('', maxRows ?? 0));
        conn.socket.write(Sync());
        let err: unknown = null;
        let rs: ResultSet | null = null;
        eP.then(
          (r) => {
            rs = r;
          },
          (e: unknown) => {
            if (err === null) err = e;
          },
        );
        await sP.catch((e: unknown) => {
          if (err === null) err = e;
        });
        if (err !== null) throw asThrowable(err);
        if (rs === null) {
          throw new Error(
            'PgConnection.prepare.execute: server returned no result',
          );
        }
        return rs;
      },
      async close(): Promise<void> {
        conn.ensureIdle();
        conn.startExtendedBatch();
        const cP = conn.enqueueClose();
        const sP = conn.enqueueSync();
        conn.socket.write(Close('S', name));
        conn.socket.write(Sync());
        let err: unknown = null;
        cP.catch((e: unknown) => {
          if (err === null) err = e;
        });
        await sP.catch((e: unknown) => {
          if (err === null) err = e;
        });
        if (err !== null) throw asThrowable(err);
      },
    };
  }

  public startCopyIn(sql: string): Promise<CopyInStream> {
    this.ensureIdle();
    // COPY mid-pipeline is rejected by libpq with a fixed diagnostic; we
    // mirror that synchronously so callers don't need a round-trip to learn
    // their command is invalid. The wire-level dispatch also guards this
    // (see handleCopyStartMessage) for any path that bypasses this check.
    if (this._extPipelineActive) {
      this.abortForCopyInPipeline();
      return Promise.reject(
        Object.assign(
          new Error('COPY in a pipeline is not supported, aborting connection'),
          { severity: 'FATAL' as const },
        ),
      );
    }
    // The driver waits in `in-query` state until CopyInResponse arrives — at
    // which point the protocol switches and we move to `in-copy-in`. The
    // server can also reply with an ErrorResponse (e.g. "no such table"),
    // which we surface as a rejected promise.
    return new Promise<CopyInStream>((resolve, reject) => {
      this.copyIn = {
        resolveDone: null,
        rejectDone: null,
        error: null,
        commandTag: null,
        closed: false,
      };
      this.copyStartResolve = (): void => {
        // The protocol-switch landed; hand the caller a usable stream.
        resolve(this.makeCopyInStream());
      };
      this.copyStartReject = reject;
      this.state = 'in-query';
      this.socket.write(Query(sql));
    });
  }

  public startCopyOut(sql: string): Promise<CopyOutStream> {
    this.ensureIdle();
    if (this._extPipelineActive) {
      this.abortForCopyInPipeline();
      return Promise.reject(
        Object.assign(
          new Error('COPY in a pipeline is not supported, aborting connection'),
          { severity: 'FATAL' as const },
        ),
      );
    }
    return new Promise<CopyOutStream>((resolve, reject) => {
      this.copyOut = {
        queue: [],
        waker: null,
        done: false,
        error: null,
        commandTag: null,
      };
      this.copyStartResolve = (): void => {
        resolve(this.makeCopyOutStream());
      };
      this.copyStartReject = reject;
      this.state = 'in-query';
      this.socket.write(Query(sql));
    });
  }

  public pipeline(): Pipeline {
    this.ensureIdle();
    return new PipelineSession(this);
  }

  /**
   * Cancel whatever the connection is currently doing.
   *
   * The routing is state-aware so the mainloop SIGINT handler can call this
   * blindly without knowing the protocol phase:
   *
   * - `in-copy-in`: we hold the writing end of the data stream, so the
   *   correct action is a client-initiated CopyFail on the *same* socket.
   *   Sending a side CancelRequest would race with our own pending writes;
   *   CopyFail is the spec-blessed abort path. The server replies with
   *   ErrorResponse + ReadyForQuery and we transition back to idle.
   * - `in-copy-out`: the server is pushing data at us. CopyFail is not a
   *   valid client message here, so we fall back to the side CancelRequest
   *   path that normal queries use. PG will surface an ErrorResponse and
   *   tear the COPY down.
   * - everything else: side CancelRequest, the historical behaviour.
   *
   * Best-effort. We don't reject if BackendKeyData hasn't arrived yet
   * during the auth dance — there's nothing to cancel; we just return.
   */
  public async cancel(): Promise<void> {
    // In-copy-in: send CopyFail on the live socket so the server returns
    // to ReadyForQuery cleanly. This is the same abort path the upstream
    // SIGINT handler in `copy.c::handleCopyIn` triggers via longjmp.
    if (this.state === 'in-copy-in' && this.copyIn && !this.copyIn.closed) {
      this.copyIn.closed = true;
      try {
        this.socket.write(CopyFail('canceled by user'));
      } catch {
        // Socket may have died — failPending() will surface that.
      }
      return;
    }
    if (this.processId === 0) {
      // Nothing to cancel — startup hasn't reached BackendKeyData. Be
      // forgiving: the mainloop SIGINT handler shouldn't crash on cancel
      // during a half-open connection.
      return;
    }
    // Per the PG protocol, CancelRequest is sent on a *fresh* connection,
    // not the one running the query. We TLS-negotiate against the same
    // sslmode but we don't auth — we just write the request and close.
    const cancelSocket = await openSocket(this.opts);
    let writeSocket: AnySocket = cancelSocket;
    try {
      const t = await negotiateTls(
        cancelSocket,
        // Unix-domain socket: no TLS, regardless of caller's sslmode.
        isUnixSocketHost(this.opts.host) ? 'disable' : this.opts.ssl,
        {
          servername: this.opts.host,
          rejectUnauthorized:
            this.opts.ssl === 'verify-ca' || this.opts.ssl === 'verify-full',
          checkServerIdentity:
            this.opts.ssl === 'verify-full' ? undefined : () => undefined,
          ALPNProtocols: ['postgresql'],
        },
        {
          sslcert: this.opts.sslcert,
          sslkey: this.opts.sslkey,
          sslrootcert: this.opts.sslrootcert,
          sslcrl: this.opts.sslcrl,
        },
      );
      writeSocket = t.kind === 'tls' ? t.socket : t.socket;
      await new Promise<void>((resolve, reject) => {
        writeSocket.write(
          CancelRequest(this.processId, this.secretKey),
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });
    } finally {
      try {
        writeSocket.end();
      } catch {
        // ignore
      }
      try {
        cancelSocket.destroy();
      } catch {
        // ignore
      }
    }
  }

  public escapeIdentifier(value: string): string {
    return '"' + value.replace(/"/g, '""') + '"';
  }

  public escapeLiteral(value: string): string {
    // Per PG docs: doubled single-quotes always; if the string contains a
    // backslash, use the E'...' escape-string syntax so backslashes don't
    // depend on `standard_conforming_strings`.
    const doubled = value.replace(/'/g, "''");
    if (value.includes('\\')) {
      return "E'" + doubled.replace(/\\/g, '\\\\') + "'";
    }
    return "'" + doubled + "'";
  }

  public onNotice(handler: (notice: Notice) => void): () => void {
    return this.notify.onNotice(handler);
  }

  public onNotification(
    handler: (channel: string, payload: string, pid: number) => void,
  ): () => void {
    return this.notify.onNotification(handler);
  }

  public async close(): Promise<void> {
    if (this.state === 'closed') return;
    try {
      this.socket.write(Terminate());
    } catch {
      // socket may already be dead; we still want to mark closed
    }
    this.state = 'closed';
    this.notify.clear();
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => {
        resolve();
      });
      try {
        this.socket.end();
      } catch {
        resolve();
      }
    });
  }

  public isClosed(): boolean {
    return this.state === 'closed';
  }

  // -------------------------------------------------------------------------
  // Startup / auth state machine
  // -------------------------------------------------------------------------

  private startup(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const params: Record<string, string> = {
        user: this.opts.user,
        database: this.opts.database,
        // psql sends client_encoding=UTF8 by default; we follow.
        client_encoding: this.opts.clientEncoding ?? 'UTF8',
      };
      if (this.opts.applicationName !== undefined) {
        params.application_name = this.opts.applicationName;
      }
      if (this.opts.options !== undefined) {
        params.options = this.opts.options;
      }
      // Walsender (replication) mode: the server enters a restricted
      // command set (IDENTIFY_SYSTEM, START_REPLICATION, etc.) keyed off
      // this startup parameter. Values mirror libpq's normalisation:
      // 'true' for physical, 'database' for logical. We do not stream the
      // CopyBoth phase — the Query path still surfaces ErrorResponse and
      // any pre-streaming ResultSet, which is enough for the negative
      // conformance test (`psql -c 'START_REPLICATION 0/1'` must exit
      // non-zero with a syntax error from the server).
      if (this.opts.replication !== undefined) {
        params.replication = this.opts.replication;
      }
      this.startupResolve = resolve;
      this.startupReject = reject;
      this.socket.write(StartupMessage(params));
    });
  }

  private startupResolve: (() => void) | null = null;
  private startupReject: ((err: unknown) => void) | null = null;

  private handleAuthMessage(msg: BackendMessage): void {
    switch (msg.type) {
      case 'AuthenticationOk':
        this.state = 'await-ready';
        return;
      case 'AuthenticationCleartextPassword': {
        if (this.opts.password === undefined) {
          this.failStartup(
            new Error(
              'Server requested cleartext password but no password was provided',
            ),
          );
          return;
        }
        this.socket.write(PasswordMessage(this.opts.password));
        return;
      }
      case 'AuthenticationMD5Password': {
        if (this.opts.password === undefined) {
          this.failStartup(
            new Error(
              'Server requested MD5 password but no password was provided',
            ),
          );
          return;
        }
        const payload = md5AuthPayload(
          this.opts.user,
          this.opts.password,
          msg.salt,
        );
        this.socket.write(PasswordMessage(payload));
        return;
      }
      case 'AuthenticationSASL': {
        if (this.opts.password === undefined) {
          this.failStartup(
            new Error(
              'Server requested SASL auth but no password was provided',
            ),
          );
          return;
        }
        if (
          this.opts.channelBinding === 'require' &&
          this.channelBindingData === null
        ) {
          this.failStartup(
            new Error(
              'channel_binding=require but no TLS channel-binding data is available',
            ),
          );
          return;
        }
        try {
          this.scram = createScramClient({
            user: this.opts.user,
            password: this.opts.password,
            mechanisms: msg.mechanisms,
            channelBinding:
              this.channelBindingData !== null &&
              this.opts.channelBinding !== 'disable'
                ? {
                    type: 'tls-server-end-point',
                    data: this.channelBindingData,
                  }
                : undefined,
          });
          const { mechanism, clientFirstMessage } = this.scram.start();
          this.socket.write(SASLInitialResponse(mechanism, clientFirstMessage));
        } catch (err) {
          this.failStartup(err);
        }
        return;
      }
      case 'AuthenticationSASLContinue': {
        if (!this.scram) {
          this.failStartup(
            new Error(
              'Received AuthenticationSASLContinue without an active SCRAM client',
            ),
          );
          return;
        }
        try {
          const reply = this.scram.continue(msg.data);
          this.socket.write(SASLResponse(reply));
        } catch (err) {
          this.failStartup(err);
        }
        return;
      }
      case 'AuthenticationSASLFinal': {
        if (!this.scram) {
          this.failStartup(
            new Error(
              'Received AuthenticationSASLFinal without an active SCRAM client',
            ),
          );
          return;
        }
        try {
          this.scram.finish(msg.data);
        } catch (err) {
          this.failStartup(err);
        }
        return;
      }
      case 'ErrorResponse':
        this.failStartup(fieldsToConnectError(msg.fields));
        return;
      case 'NoticeResponse':
        this.notify.emit(fieldsToNotice(msg.fields));
        return;
      default:
        // ParameterStatus / BackendKeyData / ReadyForQuery may arrive in
        // `await-ready`; auth state shouldn't see them, but we tolerate by
        // forwarding to the post-auth handler if so.
        this.handleAwaitReady(msg);
        return;
    }
  }

  private handleAwaitReady(msg: BackendMessage): void {
    switch (msg.type) {
      case 'ParameterStatus':
        this.params.set(msg.name, msg.value);
        if (msg.name === 'server_version') {
          this.serverVersion = parseServerVersion(msg.value);
        }
        return;
      case 'BackendKeyData':
        this.processId = msg.processId;
        this.secretKey = msg.secretKey;
        return;
      case 'ReadyForQuery':
        this.txStatus = msg.status;
        this.state = 'idle';
        if (this.startupResolve) {
          const r = this.startupResolve;
          this.startupResolve = null;
          this.startupReject = null;
          r();
        }
        return;
      case 'ErrorResponse':
        this.failStartup(fieldsToConnectError(msg.fields));
        return;
      case 'NoticeResponse':
        this.notify.emit(fieldsToNotice(msg.fields));
        return;
      default:
        this.failStartup(
          new Error(`Unexpected message ${msg.type} during connection startup`),
        );
        return;
    }
  }

  private failStartup(err: unknown): void {
    if (this.startupReject) {
      const r = this.startupReject;
      this.startupResolve = null;
      this.startupReject = null;
      r(err);
    }
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
    this.state = 'closed';
  }

  // -------------------------------------------------------------------------
  // COPY state machine (WP-16).
  //
  // The frontend transitions through:
  //   idle → in-query (after writing Query("COPY …"))
  //   in-query → in-copy-in  on CopyInResponse
  //   in-query → in-copy-out on CopyOutResponse
  //   in-copy-in  → idle on ReadyForQuery (after our CopyDone/CopyFail +
  //                                        server CommandComplete)
  //   in-copy-out → idle on ReadyForQuery (after server CopyDone +
  //                                        CommandComplete)
  //
  // ErrorResponse may arrive at any point; we drain until ReadyForQuery and
  // then surface as a rejected promise.
  // -------------------------------------------------------------------------

  private makeCopyInStream(): CopyInStream {
    const driver = this.copyIn;
    if (!driver) {
      throw new Error('PgConnection: makeCopyInStream called without driver');
    }
    return {
      write: (chunk: Buffer | string): Promise<void> => {
        if (this.state === 'closed') {
          return Promise.reject(new Error('Connection closed'));
        }
        if (driver.closed) {
          return Promise.reject(new Error('CopyInStream already closed'));
        }
        const data =
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        return new Promise<void>((resolve, reject) => {
          this.socket.write(CopyData(data), (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      end: (): Promise<void> => {
        if (driver.closed) {
          return Promise.reject(new Error('CopyInStream already closed'));
        }
        driver.closed = true;
        return new Promise<void>((resolve, reject) => {
          driver.resolveDone = resolve;
          driver.rejectDone = reject;
          this.socket.write(CopyDone());
        });
      },
      fail: (reason: string): Promise<void> => {
        if (driver.closed) {
          return Promise.reject(new Error('CopyInStream already closed'));
        }
        driver.closed = true;
        return new Promise<void>((resolve, reject) => {
          // The server is expected to reject with an ErrorResponse echoing
          // our reason; we still resolve so callers can move on. We wire the
          // resolver after the socket flush so a fast-close error surfaces.
          driver.resolveDone = (): void => {
            resolve();
          };
          driver.rejectDone = reject;
          this.socket.write(CopyFail(reason));
        });
      },
    };
  }

  private makeCopyOutStream(): CopyOutStream {
    const driver = this.copyOut;
    if (!driver) {
      throw new Error('PgConnection: makeCopyOutStream called without driver');
    }
    // Capture the state-getter as a closure so the iterator can observe
    // connection close without holding a `this` alias (no-this-alias rule).
    const isClosed = (): boolean => this.state === 'closed';
    return {
      [Symbol.asyncIterator](): AsyncIterator<Buffer> {
        return {
          async next(): Promise<IteratorResult<Buffer>> {
            for (;;) {
              if (driver.queue.length > 0) {
                const next = driver.queue.shift();
                if (next === undefined) continue;
                return { value: next, done: false };
              }
              if (driver.error) {
                // ConnectError isn't strictly an Error instance; the rule
                // wants a real Error. Wrap once before throwing.
                const ce = driver.error;
                const wrapped = new Error(ce.message);
                (wrapped as Error & { cause?: unknown }).cause = ce;
                throw wrapped;
              }
              if (driver.done) {
                return { value: undefined, done: true };
              }
              if (isClosed()) {
                throw new Error('Connection closed mid-COPY-OUT');
              }
              await new Promise<void>((resolve) => {
                driver.waker = resolve;
              });
            }
          },
          return(): Promise<IteratorResult<Buffer>> {
            // Consumer broke early — drain on our side will continue in the
            // background until ReadyForQuery. We just stop yielding.
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  /**
   * Handle messages arriving in `in-query` state when there is no
   * `pendingQuery` — i.e. the caller invoked `startCopyIn` / `startCopyOut`
   * and is waiting for the server to switch into copy mode.
   */
  private handleCopyStartMessage(msg: BackendMessage): void {
    switch (msg.type) {
      case 'CopyInResponse':
        // COPY-in-pipeline: libpq aborts the connection with this exact
        // diagnostic (matching upstream psql's behaviour). The `\copy`
        // command layer detects pipeline-active and fails fast before
        // reaching the wire, but if anything else slips through we abort
        // here as a defence-in-depth.
        if (this._extPipelineActive) {
          this.abortForCopyInPipeline();
          return;
        }
        if (this.copyIn) {
          this.state = 'in-copy-in';
          const r = this.copyStartResolve;
          this.copyStartResolve = null;
          this.copyStartReject = null;
          if (r) r();
        }
        return;
      case 'CopyOutResponse':
        if (this._extPipelineActive) {
          this.abortForCopyInPipeline();
          return;
        }
        if (this.copyOut) {
          this.state = 'in-copy-out';
          const r = this.copyStartResolve;
          this.copyStartResolve = null;
          this.copyStartReject = null;
          if (r) r();
        }
        return;
      case 'ErrorResponse': {
        const err = fieldsToConnectError(msg.fields);
        if (this.copyIn) {
          if (this.copyStartReject) this.copyStartReject(err);
          this.copyStartResolve = null;
          this.copyStartReject = null;
          this.copyIn = null;
        }
        if (this.copyOut) {
          if (this.copyStartReject) this.copyStartReject(err);
          this.copyStartResolve = null;
          this.copyStartReject = null;
          this.copyOut = null;
        }
        // Stay in `in-query` until ReadyForQuery, then return to idle below.
        return;
      }
      case 'ReadyForQuery':
        // ReadyForQuery without a prior CopyXxxResponse means the server
        // immediately rejected the COPY (we surfaced the ErrorResponse just
        // above) — return to idle so the next command can fire.
        this.txStatus = msg.status;
        this.state = 'idle';
        return;
      case 'NoticeResponse':
        this.notify.emit(fieldsToNotice(msg.fields));
        return;
      case 'ParameterStatus':
        this.params.set(msg.name, msg.value);
        return;
      default:
        if (this.copyStartReject) {
          this.copyStartReject(
            new Error(
              `Unexpected backend message before COPY response: ${msg.type}`,
            ),
          );
        }
        this.copyStartResolve = null;
        this.copyStartReject = null;
        return;
    }
  }

  private handleCopyInMessage(msg: BackendMessage): void {
    const driver = this.copyIn;
    if (!driver) return;
    switch (msg.type) {
      case 'CommandComplete':
        driver.commandTag = msg.tag;
        this.lastCopyTag = msg.tag;
        return;
      case 'ErrorResponse':
        driver.error = fieldsToConnectError(msg.fields);
        return;
      case 'NoticeResponse':
        this.notify.emit(fieldsToNotice(msg.fields));
        return;
      case 'ParameterStatus':
        this.params.set(msg.name, msg.value);
        return;
      case 'ReadyForQuery':
        this.txStatus = msg.status;
        this.state = 'idle';
        this.copyIn = null;
        if (driver.error) {
          if (driver.rejectDone) driver.rejectDone(driver.error);
        } else if (driver.resolveDone) {
          driver.resolveDone();
        }
        return;
      default:
        // Unknown messages mid-COPY-IN are protocol errors; record and let
        // the trailing ReadyForQuery flush the state.
        driver.error = {
          severity: 'ERROR',
          message: `Unexpected backend message during COPY IN: ${msg.type}`,
        };
        return;
    }
  }

  private handleCopyOutMessage(msg: BackendMessage): void {
    const driver = this.copyOut;
    if (!driver) return;
    switch (msg.type) {
      case 'CopyData': {
        driver.queue.push(msg.data);
        if (driver.waker) {
          const w = driver.waker;
          driver.waker = null;
          w();
        }
        return;
      }
      case 'CopyDone':
        // Server signals it's done sending — we now expect CommandComplete +
        // ReadyForQuery. Stay in in-copy-out until ReadyForQuery; the queue
        // may still drain via the consumer.
        return;
      case 'CommandComplete':
        driver.commandTag = msg.tag;
        this.lastCopyTag = msg.tag;
        return;
      case 'ErrorResponse':
        driver.error = fieldsToConnectError(msg.fields);
        return;
      case 'NoticeResponse':
        this.notify.emit(fieldsToNotice(msg.fields));
        return;
      case 'ParameterStatus':
        this.params.set(msg.name, msg.value);
        return;
      case 'ReadyForQuery':
        this.txStatus = msg.status;
        this.state = 'idle';
        driver.done = true;
        this.copyOut = null;
        if (driver.waker) {
          const w = driver.waker;
          driver.waker = null;
          w();
        }
        return;
      default:
        driver.error = {
          severity: 'ERROR',
          message: `Unexpected backend message during COPY OUT: ${msg.type}`,
        };
        if (driver.waker) {
          const w = driver.waker;
          driver.waker = null;
          w();
        }
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Query state machine
  // -------------------------------------------------------------------------

  private handleQueryMessage(msg: BackendMessage): void {
    const q = this.pendingQuery;
    if (!q) {
      // No active execSimple — we must be in the "starting a COPY" phase
      // where the caller wrote Query("COPY …") via startCopyIn/startCopyOut.
      this.handleCopyStartMessage(msg);
      return;
    }
    switch (msg.type) {
      case 'RowDescription':
        q.current = {
          command: '',
          rowCount: null,
          oid: null,
          fields: msg.fields,
          rows: [],
          notices: [],
        };
        return;
      case 'DataRow': {
        if (!q.current) {
          // Server sent rows without a prior description — extremely rare
          // (only for some legacy COPY error paths). Treat as empty desc.
          q.current = {
            command: '',
            rowCount: null,
            oid: null,
            fields: [],
            rows: [],
            notices: [],
          };
        }
        q.current.rows.push(decodeDataRow(msg.values, q.current.fields));
        return;
      }
      case 'CommandComplete': {
        const { command, rowCount, oid } = parseCommandTag(msg.tag);
        const set: ResultSet = q.current ?? {
          command,
          rowCount: rowCount,
          oid,
          fields: [],
          rows: [],
          notices: [],
        };
        set.command = command;
        set.rowCount = rowCount;
        set.oid = oid;
        set.notices = q.notices.splice(0);
        q.finished.push(set);
        q.current = null;
        return;
      }
      case 'EmptyQueryResponse': {
        const set: ResultSet = {
          command: '',
          rowCount: null,
          oid: null,
          fields: [],
          rows: [],
          notices: q.notices.splice(0),
        };
        q.finished.push(set);
        q.current = null;
        return;
      }
      case 'ParameterStatus':
        this.params.set(msg.name, msg.value);
        if (msg.name === 'server_version') {
          this.serverVersion = parseServerVersion(msg.value);
        }
        return;
      case 'NoticeResponse': {
        const notice = fieldsToNotice(msg.fields);
        q.notices.push(notice);
        this.notify.emit(notice);
        return;
      }
      case 'NotificationResponse':
        this.notify.emitNotification(msg.channel, msg.payload, msg.processId);
        return;
      case 'ErrorResponse': {
        q.error = fieldsToConnectError(msg.fields);
        // Don't reject yet — ReadyForQuery will arrive shortly and we want
        // to drain queued NoticeResponse messages first.
        return;
      }
      case 'ReadyForQuery': {
        this.txStatus = msg.status;
        this.state = 'idle';
        this.pendingQuery = null;
        if (q.error) {
          q.reject(asThrowable(q.error));
        } else {
          q.resolve(q.finished);
        }
        return;
      }
      case 'CopyInResponse':
      case 'CopyOutResponse': {
        // PG 17 added pipeline + COPY support but libpq still rejects the
        // combination ("COPY in a pipeline is not supported, aborting
        // connection"). Upstream psql surfaces that diagnostic and tears down
        // the connection. We mirror the behaviour: if the user fires a COPY
        // statement via execSimple while a pipeline is active, abort.
        if (this._extPipelineActive) {
          this.abortForCopyInPipeline();
          return;
        }
        q.error = {
          severity: 'ERROR',
          message:
            'COPY without an active CopyIn/CopyOut driver — call startCopyIn/startCopyOut instead of execSimple',
        };
        return;
      }
      default:
        // Unknown messages during a query are protocol errors but not fatal
        // for the connection — record them.
        q.error = {
          severity: 'ERROR',
          message: `Unexpected backend message during query: ${msg.type}`,
        };
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Socket → parser → state dispatch
  // -------------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    let messages: BackendMessage[];
    try {
      messages = this.parser.feed(chunk);
    } catch (err) {
      this.socketError = err instanceof Error ? err : new Error(String(err));
      this.failPending(this.socketError);
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.state = 'closed';
      return;
    }
    for (const msg of messages) {
      this.dispatch(msg);
      if (this.state === 'closed') break;
    }
  }

  private dispatch(msg: BackendMessage): void {
    // Async backend messages always allowed. NotificationResponse can arrive
    // in *any* state since LISTEN payloads come in whenever a NOTIFY fires.
    if (msg.type === 'NotificationResponse') {
      this.notify.emitNotification(msg.channel, msg.payload, msg.processId);
      return;
    }
    switch (this.state) {
      case 'auth':
        this.handleAuthMessage(msg);
        return;
      case 'await-ready':
        this.handleAwaitReady(msg);
        return;
      case 'idle':
        // ParameterStatus changes can arrive asynchronously (SET).
        if (msg.type === 'ParameterStatus') {
          this.params.set(msg.name, msg.value);
          if (msg.name === 'server_version') {
            this.serverVersion = parseServerVersion(msg.value);
          }
          return;
        }
        if (msg.type === 'NoticeResponse') {
          this.notify.emit(fieldsToNotice(msg.fields));
          return;
        }
        // (NotificationResponse is handled by the early-out above.)
        // Anything else in idle is unexpected.
        this.socketError = new Error(`Unexpected ${msg.type} in idle state`);
        try {
          this.socket.destroy();
        } catch {
          // ignore
        }
        this.state = 'closed';
        return;
      case 'in-query':
        this.handleQueryMessage(msg);
        return;
      case 'in-extended':
        this.handleExtendedMessage(msg);
        return;
      case 'in-copy-in':
        this.handleCopyInMessage(msg);
        return;
      case 'in-copy-out':
        this.handleCopyOutMessage(msg);
        return;
      case 'closed':
        return;
    }
  }

  private failPending(err: unknown): void {
    if (this.pendingQuery) {
      const q = this.pendingQuery;
      this.pendingQuery = null;
      q.reject(err);
    }
    if (this.extDriver) {
      const d = this.extDriver;
      this.extDriver = null;
      for (const op of d.queue) op.reject(err);
    }
    if (this.startupReject) {
      const r = this.startupReject;
      this.startupResolve = null;
      this.startupReject = null;
      r(err);
    }
    if (this.copyStartReject) {
      const r = this.copyStartReject;
      this.copyStartResolve = null;
      this.copyStartReject = null;
      r(err);
    }
    if (this.copyIn) {
      const d = this.copyIn;
      this.copyIn = null;
      if (d.rejectDone) d.rejectDone(err);
    }
    if (this.copyOut) {
      const d = this.copyOut;
      this.copyOut = null;
      d.error =
        err instanceof Error
          ? { severity: 'ERROR', message: err.message }
          : { severity: 'ERROR', message: String(err) };
      if (d.waker) {
        const w = d.waker;
        d.waker = null;
        w();
      }
    }
  }

  private ensureIdle(): void {
    if (this.state === 'closed') {
      throw new Error('PgConnection: connection is closed');
    }
    if (this.state !== 'idle' && this.state !== 'in-extended') {
      throw new Error(
        `PgConnection: cannot start query in state ${this.state}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Extended-protocol driver (WP-21).
  //
  // Each public enqueueX method appends one op to `extDriver.queue` and
  // returns a Promise that resolves when the op's terminator backend message
  // arrives. The caller is responsible for writing the matching wire frame
  // (Parse/Bind/Describe/Execute/Close/Sync) to the socket.
  // -------------------------------------------------------------------------

  public startExtendedBatch(): void {
    if (this.state === 'idle') {
      this.state = 'in-extended';
      this.extDriver = { queue: [], error: null };
    } else if (this.state !== 'in-extended') {
      throw new Error(
        `PgConnection: cannot start extended batch in state ${this.state}`,
      );
    } else if (!this.extDriver) {
      this.extDriver = { queue: [], error: null };
    }
  }

  public writeRaw(buf: Buffer): void {
    this.socket.write(buf);
  }

  public enqueueParse(): Promise<void> {
    return this.enqueueOp({
      kind: 'parse',
      resolve: () => undefined,
      reject: () => undefined,
    });
  }

  public enqueueBind(): Promise<void> {
    return this.enqueueOp({
      kind: 'bind',
      resolve: () => undefined,
      reject: () => undefined,
    });
  }

  public enqueueDescribeStatement(): Promise<{
    paramOids: number[];
    fields: FieldDescription[];
  }> {
    return this.enqueueOp({
      kind: 'describeS',
      resolve: () => undefined,
      reject: () => undefined,
      paramOids: null,
    });
  }

  public enqueueDescribePortal(): Promise<FieldDescription[]> {
    return this.enqueueOp({
      kind: 'describeP',
      resolve: () => undefined,
      reject: () => undefined,
    });
  }

  /**
   * Variant of {@link enqueueDescribePortal} that pipes the resolved fields
   * onto the very next `execute` op already (or yet to be) on the queue.
   */
  public enqueueDescribePortalIntoNextExecute(): Promise<void> {
    const driver = this.extDriver;
    if (!driver) {
      return Promise.reject(
        new Error(
          'enqueueDescribePortalIntoNextExecute: not in extended state',
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      driver.queue.push({
        kind: 'describeP',
        resolve: (v: unknown) => {
          const fields = v as FieldDescription[];
          for (const op of driver.queue) {
            if (op.kind === 'execute' && op.fields === null) {
              op.fields = fields;
              break;
            }
          }
          resolve();
        },
        reject,
      });
    });
  }

  public enqueueExecute(): Promise<ResultSet> {
    return this.enqueueOp({
      kind: 'execute',
      resolve: () => undefined,
      reject: () => undefined,
      current: null,
      notices: [],
      fields: null,
    });
  }

  public enqueueExecuteWithFields(
    fields: FieldDescription[],
  ): Promise<ResultSet> {
    return this.enqueueOp({
      kind: 'execute',
      resolve: () => undefined,
      reject: () => undefined,
      current: null,
      notices: [],
      fields,
    });
  }

  public enqueueClose(): Promise<void> {
    return this.enqueueOp({
      kind: 'close',
      resolve: () => undefined,
      reject: () => undefined,
    });
  }

  public enqueueSync(): Promise<void> {
    return this.enqueueOp({
      kind: 'sync',
      resolve: () => undefined,
      reject: () => undefined,
    });
  }

  private enqueueOp<T>(opSkeleton: ExtOp): Promise<T> {
    if (!this.extDriver) {
      return Promise.reject(new Error('enqueueOp: not in extended state'));
    }
    const driver = this.extDriver;
    return new Promise<T>((resolve, reject) => {
      const op = opSkeleton;
      op.resolve = resolve as (v: unknown) => void;
      op.reject = reject;
      driver.queue.push(op);
    });
  }

  private handleExtendedMessage(msg: BackendMessage): void {
    const driver = this.extDriver;
    if (!driver) return;

    if (msg.type === 'ParameterStatus') {
      this.params.set(msg.name, msg.value);
      if (msg.name === 'server_version') {
        this.serverVersion = parseServerVersion(msg.value);
      }
      return;
    }
    if (msg.type === 'NoticeResponse') {
      const notice = fieldsToNotice(msg.fields);
      this.notify.emit(notice);
      const head = driver.queue[0];
      if (head && head.kind === 'execute') head.notices.push(notice);
      return;
    }
    if (msg.type === 'NotificationResponse') {
      this.notify.emitNotification(msg.channel, msg.payload, msg.processId);
      return;
    }

    if (msg.type === 'ErrorResponse') {
      driver.error = fieldsToConnectError(msg.fields);
      const head = driver.queue[0];
      if (head && head.kind !== 'sync') {
        driver.queue.shift();
        head.reject(driver.error);
      }
      return;
    }

    while (driver.error !== null) {
      const head = driver.queue[0];
      if (!head || head.kind === 'sync') break;
      driver.queue.shift();
      head.reject(driver.error);
    }

    const head = driver.queue[0];
    if (!head) {
      this.protocolFail(
        new Error(`Unexpected backend message ${msg.type} in in-extended`),
      );
      return;
    }

    switch (msg.type) {
      case 'ParseComplete':
        if (head.kind !== 'parse') {
          this.protocolFail(
            new Error('ParseComplete arrived but head op is ' + head.kind),
          );
          return;
        }
        driver.queue.shift();
        head.resolve(undefined);
        return;
      case 'BindComplete':
        if (head.kind !== 'bind') {
          this.protocolFail(
            new Error('BindComplete arrived but head op is ' + head.kind),
          );
          return;
        }
        driver.queue.shift();
        head.resolve(undefined);
        return;
      case 'CloseComplete':
        if (head.kind !== 'close') {
          this.protocolFail(
            new Error('CloseComplete arrived but head op is ' + head.kind),
          );
          return;
        }
        driver.queue.shift();
        head.resolve(undefined);
        return;
      case 'ParameterDescription':
        if (head.kind !== 'describeS') {
          this.protocolFail(
            new Error(
              'ParameterDescription arrived but head op is ' + head.kind,
            ),
          );
          return;
        }
        head.paramOids = msg.oids;
        return;
      case 'RowDescription':
        if (head.kind === 'describeS') {
          driver.queue.shift();
          head.resolve({
            paramOids: head.paramOids ?? [],
            fields: msg.fields,
          });
          return;
        }
        if (head.kind === 'describeP') {
          driver.queue.shift();
          head.resolve(msg.fields);
          return;
        }
        if (head.kind === 'execute') {
          head.current = {
            command: '',
            rowCount: null,
            oid: null,
            fields: msg.fields,
            rows: [],
            notices: [],
          };
          head.fields = msg.fields;
          return;
        }
        this.protocolFail(
          new Error('Unexpected RowDescription at head op ' + head.kind),
        );
        return;
      case 'NoData':
        if (head.kind === 'describeS') {
          driver.queue.shift();
          head.resolve({ paramOids: head.paramOids ?? [], fields: [] });
          return;
        }
        if (head.kind === 'describeP') {
          driver.queue.shift();
          head.resolve([]);
          return;
        }
        this.protocolFail(
          new Error('Unexpected NoData at head op ' + head.kind),
        );
        return;
      case 'DataRow': {
        if (head.kind !== 'execute') {
          this.protocolFail(new Error('DataRow at head op ' + head.kind));
          return;
        }
        const fields = head.fields ?? head.current?.fields ?? [];
        if (!head.current) {
          head.current = {
            command: '',
            rowCount: null,
            oid: null,
            fields,
            rows: [],
            notices: [],
          };
        }
        head.current.rows.push(decodeDataRow(msg.values, fields));
        return;
      }
      case 'CommandComplete': {
        if (head.kind !== 'execute') {
          this.protocolFail(
            new Error('CommandComplete at head op ' + head.kind),
          );
          return;
        }
        const { command, rowCount, oid } = parseCommandTag(msg.tag);
        const set: ResultSet = head.current ?? {
          command,
          rowCount,
          oid,
          fields: head.fields ?? [],
          rows: [],
          notices: [],
        };
        set.command = command;
        set.rowCount = rowCount;
        set.oid = oid;
        set.notices = head.notices.splice(0);
        driver.queue.shift();
        head.resolve(set);
        return;
      }
      case 'EmptyQueryResponse': {
        if (head.kind !== 'execute') {
          this.protocolFail(
            new Error('EmptyQueryResponse at head op ' + head.kind),
          );
          return;
        }
        const set: ResultSet = {
          command: '',
          rowCount: null,
          oid: null,
          fields: [],
          rows: [],
          notices: head.notices.splice(0),
        };
        driver.queue.shift();
        head.resolve(set);
        return;
      }
      case 'PortalSuspended': {
        if (head.kind !== 'execute') {
          this.protocolFail(
            new Error('PortalSuspended at head op ' + head.kind),
          );
          return;
        }
        const set: ResultSet = head.current ?? {
          command: '',
          rowCount: null,
          oid: null,
          fields: head.fields ?? [],
          rows: [],
          notices: head.notices.splice(0),
        };
        set.notices = head.notices.splice(0);
        driver.queue.shift();
        head.resolve(set);
        return;
      }
      case 'ReadyForQuery': {
        this.txStatus = msg.status;
        if (head.kind !== 'sync') {
          this.protocolFail(
            new Error('ReadyForQuery but head op is ' + head.kind),
          );
          return;
        }
        driver.queue.shift();
        const stickyErr = driver.error;
        driver.error = null;
        if (stickyErr) {
          head.reject(stickyErr);
        } else {
          head.resolve(undefined);
        }
        if (driver.queue.length === 0 && !this._extPipelineActive) {
          this.state = 'idle';
          this.extDriver = null;
        }
        return;
      }
      default:
        this.protocolFail(
          new Error(`Unexpected ${msg.type} in in-extended state`),
        );
        return;
    }
  }

  private protocolFail(err: Error): void {
    this.socketError = err;
    this.failPending(err);
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
    this.state = 'closed';
  }

  /**
   * Abort the connection because the server replied with CopyInResponse /
   * CopyOutResponse while a pipeline (`_extPipelineActive`) was active.
   * Upstream libpq emits the exact diagnostic
   * `"COPY in a pipeline is not supported, aborting connection"` and tears
   * the socket down — we mirror that. Pending operations are rejected; the
   * connection is left in `closed` so subsequent commands fail cleanly
   * (matching the "aborting connection" promise).
   */
  public abortForCopyInPipeline(): void {
    const err: ConnectError = {
      severity: 'FATAL',
      message: 'COPY in a pipeline is not supported, aborting connection',
    };
    this.socketError = new Error(err.message);
    this.failPending(err);
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
    this.state = 'closed';
  }
}

// ---------------------------------------------------------------------------
// Socket open helper. Supports TCP (default) and Unix-domain sockets when
// `opts.host` starts with `/` — matching libpq's `pqUnixSocketPath()` which
// reads the directory from PGHOST and builds `<dir>/.s.PGSQL.<port>` as the
// actual filesystem socket path.
// ---------------------------------------------------------------------------

/**
 * `true` if the host value should be interpreted as a Unix-domain socket
 * directory. libpq's rule: any value starting with `/` is a path.
 */
export function isUnixSocketHost(host: string): boolean {
  return host.startsWith('/');
}

/**
 * Build the actual filesystem path Postgres listens on under a socket
 * directory: `<dir>/.s.PGSQL.<port>`. Mirrors the libpq layout so any
 * server started with `unix_socket_directories=<dir>` is reachable.
 */
export function unixSocketPath(dir: string, port: number): string {
  return `${dir}/.s.PGSQL.${String(port)}`;
}

function openSocket(opts: ConnectOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = isUnixSocketHost(opts.host)
      ? net.connect({ path: unixSocketPath(opts.host, opts.port) })
      : net.connect({ host: opts.host, port: opts.port });
    const timeout = opts.connectTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeout !== undefined && timeout > 0) {
      timer = setTimeout(() => {
        socket.destroy(
          new Error(`Connect timed out after ${String(timeout)} ms`),
        );
      }, timeout);
    }
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      socket.removeListener('error', onError);
      socket.removeListener('connect', onConnect);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

// ---------------------------------------------------------------------------
// Result decoding helpers
// ---------------------------------------------------------------------------

/**
 * Decode a wire-protocol DataRow into JS values. We follow the simple psql
 * policy: text format → utf-8 string, binary format → Buffer. Type-aware
 * decoding (timestamps, arrays, etc.) is the caller's responsibility — that
 * matches `psql` which prints raw server text.
 */
function decodeDataRow(
  values: (Buffer | null)[],
  fields: FieldDescription[],
): unknown[] {
  const out: unknown[] = new Array<unknown>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) {
      out[i] = null;
      continue;
    }
    const fmt = fields[i]?.format ?? 0;
    out[i] = fmt === 1 ? v : v.toString('utf8');
  }
  return out;
}

/**
 * Parse the CommandComplete tag — examples:
 *   "SELECT 17"
 *   "INSERT 0 1"       (oid is 0 in modern PG; second number is rowCount)
 *   "UPDATE 3"
 *   "CREATE TABLE"     (no rowCount)
 *
 * Anything that doesn't match → command = the whole tag, rowCount = null.
 */
function parseCommandTag(tag: string): {
  command: string;
  rowCount: number | null;
  oid: number | null;
} {
  const trimmed = tag.trim();
  // INSERT is the only tag with the legacy oid + rowCount layout.
  const insertMatch = /^INSERT (\d+) (\d+)$/.exec(trimmed);
  if (insertMatch) {
    return {
      command: 'INSERT',
      oid: parseInt(insertMatch[1], 10),
      rowCount: parseInt(insertMatch[2], 10),
    };
  }
  const m = /^([A-Z][A-Z ]*?)(?: (\d+))?$/.exec(trimmed);
  if (!m) return { command: trimmed, rowCount: null, oid: null };
  return {
    command: m[1],
    rowCount: m[2] !== undefined ? parseInt(m[2], 10) : null,
    oid: null,
  };
}

/**
 * Encode JS values into the (Buffer | string | null)[] format that
 * {@link Bind} accepts. Text-format only — server coerces. Matches psql's
 * default `\bind` behaviour.
 */
export function encodeParams(values: unknown[]): (Buffer | string | null)[] {
  return values.map((v): Buffer | string | null => {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) return v;
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 't' : 'f';
    if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  });
}

/**
 * Coerce arbitrary rejection values to a thrown `Error`.
 *
 * For our `ConnectError` shape (`{ severity, code, message, … }`), the
 * resulting Error preserves every enumerable field of the source object as
 * own properties — so callers can still read `.code`, `.severity`, `.hint`,
 * `.position`, etc. directly off the thrown value while also getting a proper
 * `Error` instance (so `instanceof Error` works and `.message` / `.stack` are
 * populated for generic loggers).
 */
function asThrowable(v: unknown): Error {
  if (v instanceof Error) return v;
  if (
    typeof v === 'object' &&
    v !== null &&
    'message' in v &&
    typeof (v as { message: unknown }).message === 'string'
  ) {
    const source = v as Record<string, unknown> & { message: string };
    const err = new Error(source.message);
    // Copy every own enumerable field (severity, code, detail, hint, …) onto
    // the Error so structural consumers keep working.
    for (const key of Object.keys(source)) {
      if (key === 'message') continue;
      (err as unknown as Record<string, unknown>)[key] = source[key];
    }
    (err as Error & { cause?: unknown }).cause = v;
    return err;
  }
  return new Error(String(v));
}
