export type FieldDescription = {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: 0 | 1;
};

export type ResultSet = {
  command: string;
  rowCount: number | null;
  oid: number | null;
  fields: FieldDescription[];
  rows: unknown[][];
  notices: Notice[];
  /**
   * COPY ... TO STDOUT payload bytes when this result represents a COPY
   * out segment of a `\;`-chained simple-query batch. The wire layer
   * accumulates each CopyData payload here in arrival order so the
   * renderer can emit them at the result's position in the chain (vs
   * streaming them straight to stdout at receive time, which would
   * hoist the COPY bytes above any tuples-producing results that haven't
   * been rendered yet).
   *
   * Unset for non-COPY results.
   */
  copyOutBytes?: Buffer[];
};

export type Notice = {
  severity: string;
  code?: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;
};

export type ConnectError = Notice & {
  cause?: unknown;
  /**
   * `true` when this error is the synthetic
   * `Pipeline aborted, command did not run` marker the wire layer
   * generates for queued pipeline ops that the server skipped after
   * a preceding ErrorResponse. Mirrors libpq's
   * `PGRES_PIPELINE_ABORTED` result. The cmd layer renders these
   * with the bare "Pipeline aborted, command did not run" line
   * (no `ERROR:` prefix) so the `psql_pipeline.out` baseline matches.
   */
  pipelineAborted?: boolean;
};

export type CopyInStream = {
  write(chunk: Buffer | string): Promise<void>;
  end(): Promise<void>;
  fail(reason: string): Promise<void>;
};

export type CopyOutStream = AsyncIterable<Buffer>;

export type PreparedStatement = {
  name: string;
  paramTypes: number[];
  bind(values: unknown[], paramFormats?: (0 | 1)[]): Promise<void>;
  describe(): Promise<FieldDescription[]>;
  execute(maxRows?: number): Promise<ResultSet>;
  /**
   * Atomic Bind + Execute + Sync in one extended-protocol batch. The
   * server's anonymous portal lives only until the next Sync, so
   * calling `bind()` and `execute()` separately doesn't work — the
   * portal goes away with bind's Sync before execute can use it. Use
   * this when you need to execute a previously-prepared statement
   * (`\bind_named NAME \g`).
   */
  bindAndExecute(
    values: unknown[],
    maxRows?: number,
    paramFormats?: (0 | 1)[],
  ): Promise<ResultSet>;
  close(): Promise<void>;
};

export type Pipeline = {
  parse(name: string, sql: string, paramTypes?: number[]): Promise<void>;
  bind(name: string, values: unknown[]): Promise<void>;
  execute(name: string, maxRows?: number): Promise<void>;
  describe(name: string): Promise<void>;
  close(name: string): Promise<void>;
  flush(): Promise<void>;
  sync(): Promise<void>;
  end(): Promise<ResultSet[]>;
};

export type Connection = {
  serverVersion: number;
  parameterStatus(name: string): string | undefined;
  query(sql: string, params?: unknown[]): Promise<ResultSet>;
  execSimple(sql: string): Promise<ResultSet[]>;
  prepare(
    name: string,
    sql: string,
    paramTypes?: number[],
  ): Promise<PreparedStatement>;
  /**
   * Close a server-side prepared statement by name without a preceding
   * `prepare()` round-trip. Mirrors libpq's `Close('S', name) + Sync`
   * sequence used by upstream psql's `\close_prepared NAME`.
   *
   * Closing an unknown name is *not* a server error — Postgres treats
   * Close('S', missing) as a no-op (CloseComplete with no diagnostic),
   * matching the empty-output behaviour of upstream `\close_prepared
   * unknown_name`.
   *
   * Optional on the interface so existing mocks (which fully implement
   * the surface as object literals) don't all need to grow a stub at
   * the same time as the production code. `PgConnection` always supplies
   * the real method; the only caller (`\close_prepared`) checks for
   * presence and reports a clear diagnostic otherwise.
   */
  closePreparedStatement?(name: string): Promise<void>;
  startCopyIn(sql: string): Promise<CopyInStream>;
  startCopyOut(sql: string): Promise<CopyOutStream>;
  pipeline(): Pipeline;
  cancel(): Promise<void>;
  escapeIdentifier(value: string): string;
  escapeLiteral(value: string): string;
  onNotice(handler: (notice: Notice) => void): () => void;
  onNotification(
    handler: (channel: string, payload: string, pid: number) => void,
  ): () => void;
  close(): Promise<void>;
  isClosed(): boolean;
};

export type ConnectOptions = {
  /**
   * Host to connect to. Either a TCP hostname / IP, or — if the value
   * starts with `/` — the directory holding a Postgres Unix-domain socket
   * (the wire layer appends `/.s.PGSQL.<port>` to form the actual socket
   * path, matching libpq's `pqUnixSocketPath()`).
   */
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  applicationName?: string;
  ssl: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  channelBinding?: 'disable' | 'prefer' | 'require';
  connectTimeoutMs?: number;
  clientEncoding?: string;
  options?: string;
  /** Path to client cert (PEM). Mapped to tls.connect's `cert` option. */
  sslcert?: string;
  /** Path to client key (PEM). Mapped to tls.connect's `key` option. */
  sslkey?: string;
  /**
   * Passphrase for an encrypted PEM key supplied via {@link sslkey}.
   * Mapped to tls.connect's `passphrase` option; OpenSSL uses it to
   * decrypt PKCS#8 / legacy PEM-encrypted private keys at handshake time.
   * Matches libpq's `sslpassword` connection parameter.
   */
  sslpassword?: string;
  /** Path to CA cert(s) (PEM, may contain bundle). Mapped to `ca`. */
  sslrootcert?: string;
  /** Path to CRL (PEM). Mapped to `crl`. */
  sslcrl?: string;
  /**
   * Open the connection in replication mode (walsender). Values:
   *   - 'true': physical replication (libpq accepts 'true' / 'on' / 'yes' /
   *     '1' and we normalise them to 'true' at the parsing layer).
   *   - 'database': logical replication; the connection is associated with
   *     the specified database and can run logical-decoding commands.
   *
   * In replication mode the server only accepts walsender commands
   * (IDENTIFY_SYSTEM, START_REPLICATION, CREATE_REPLICATION_SLOT, etc.) —
   * regular SQL is not accepted. We surface server responses as ResultSets
   * (for commands that return rows) or as a thrown ConnectError (for
   * invalid input). Full CopyBoth streaming after a successful
   * START_REPLICATION is NOT implemented; this client supports the
   * handshake + Query / ErrorResponse path only.
   */
  replication?: 'true' | 'database';
  /**
   * Multi-host list. When set, PgConnection.connect iterates the list
   * trying each in order; on connect/auth failure or target_session_attrs
   * mismatch, the next is tried. The single-host `host` / `port` fields
   * are still accepted (and are equivalent to `hosts: [{host, port}]`).
   */
  hosts?: readonly { host: string; port: number }[];
  /**
   * Filter accepting hosts by session role. After a successful handshake,
   * we query pg_is_in_recovery() to determine primary vs standby and
   * keep / abandon the connection accordingly.
   *
   *   - 'any' (default) — accept any host
   *   - 'read-write' / 'primary' — only when NOT in recovery
   *   - 'read-only' / 'standby' — only when IN recovery
   *   - 'prefer-standby' — try standby first, fall back to primary
   */
  targetSessionAttrs?:
    | 'any'
    | 'read-write'
    | 'read-only'
    | 'primary'
    | 'standby'
    | 'prefer-standby';
  /**
   * Shuffle the hosts list before iteration. `'random'` to shuffle,
   * `'disable'` (default) for order-preserved.
   */
  loadBalanceHosts?: 'disable' | 'random';
};
