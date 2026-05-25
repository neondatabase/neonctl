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

export type ConnectError = Notice & { cause?: unknown };

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
};
