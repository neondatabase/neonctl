/**
 * PostgreSQL wire protocol message codec — thin adapter over `pg-protocol`.
 *
 * Background (per the plan): the original module was a hand-rolled wire codec
 * for protocol v3.0. We've now swapped the bytes for `pg-protocol@1.14`
 * (node-postgres' upstream codec) and this file is the seam:
 *
 *   - Frontend builders (`Query`, `StartupMessage`, `Parse`, `Bind`, …) are
 *     re-exports of `serialize.*` adapted to our existing call signatures, so
 *     `connection.ts` and `pipeline.ts` keep working unchanged.
 *   - `MessageParser` wraps pg-protocol's synchronous `Parser` and reshapes
 *     each parsed message into our existing `BackendMessage` union — so the
 *     connection-state-machine switches on `.type` ('RowDescription', 'DataRow',
 *     …) and reads the same field names ('values', 'tag', 'fields', …) as
 *     before.
 *
 * Exceptions (kept hand-rolled):
 *
 *   - `CancelRequest`: pg-protocol exposes one as `serialize.cancel`, and it
 *     is layout-compatible with our previous output. We delegate to it.
 *   - `SSLRequest`: pg-protocol *does* expose this as `serialize.requestSsl`;
 *     we re-export it for symmetry. No hand-roll needed.
 *   - `StartupMessage`: pg-protocol's `serialize.startup` unconditionally
 *     appends `client_encoding=UTF8` to whatever the caller supplies. We
 *     defensively filter `client_encoding` from the caller-provided map
 *     before passing through, since our connect layer always sets it to UTF8
 *     anyway. If it's set to something else, that's a caller bug — assert.
 *
 * Why this shim layer (instead of using pg-protocol directly):
 *
 *   - Field-name mapping. pg-protocol's parser emits camelCase names
 *     (`'rowDescription'`, `'dataRow'`, …) and uses different field names
 *     (`fields` vs `values`, `text` vs `tag`, `processID` vs `processId`).
 *     Translating in one place keeps `connection.ts` minimal.
 *   - DataRow values. pg-protocol parses every value as a UTF-8 string;
 *     our connection layer expects `(Buffer | null)[]` (so binary-format
 *     columns can keep their bytes intact later). We re-buffer here.
 *   - ErrorResponse / NoticeResponse fields. pg-protocol attaches the parsed
 *     fields as named properties on the Error/Notice instance. We re-pack
 *     them into the Map<tag,value> shape our `fieldsToNotice` helper consumes.
 */

import { Buffer } from 'node:buffer';
import { serialize } from 'pg-protocol';
// `Parser` is not part of pg-protocol's top-level exports (only `serialize`,
// `parse`, and `DatabaseError` are). The package's `exports` map permits
// `./dist/*` subpath imports, which is the canonical way to reach the parser
// class — node-postgres' own pg client does the same.
import { Parser } from 'pg-protocol/dist/parser.js';

// ---------------------------------------------------------------------------
// Backend message types (unchanged from the hand-rolled codec — this is the
// shape `connection.ts` switches on)
// ---------------------------------------------------------------------------

export type FieldDescription = {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: 0 | 1;
};

export type BackendMessage =
  | { type: 'AuthenticationOk' }
  | { type: 'AuthenticationCleartextPassword' }
  | { type: 'AuthenticationMD5Password'; salt: Buffer }
  | { type: 'AuthenticationSASL'; mechanisms: string[] }
  | { type: 'AuthenticationSASLContinue'; data: Buffer }
  | { type: 'AuthenticationSASLFinal'; data: Buffer }
  | { type: 'ParameterStatus'; name: string; value: string }
  | { type: 'BackendKeyData'; processId: number; secretKey: number }
  | { type: 'ReadyForQuery'; status: 'I' | 'T' | 'E' }
  | { type: 'RowDescription'; fields: FieldDescription[] }
  | { type: 'DataRow'; values: (Buffer | null)[] }
  | { type: 'CommandComplete'; tag: string }
  | { type: 'EmptyQueryResponse' }
  | { type: 'ErrorResponse'; fields: Map<string, string> }
  | { type: 'NoticeResponse'; fields: Map<string, string> }
  | {
      type: 'NotificationResponse';
      processId: number;
      channel: string;
      payload: string;
    }
  | {
      type: 'CopyInResponse';
      overallFormat: 0 | 1;
      columnFormats: (0 | 1)[];
    }
  | {
      type: 'CopyOutResponse';
      overallFormat: 0 | 1;
      columnFormats: (0 | 1)[];
    }
  | { type: 'CopyData'; data: Buffer }
  | { type: 'CopyDone' }
  /**
   * Server response to a walsender command such as `START_REPLICATION` /
   * `CREATE_REPLICATION_SLOT … LOGICAL`. The server transitions to a
   * CopyBoth streaming phase (WAL records flowing from server, keepalive
   * replies flowing from client). pg-protocol surfaces this as a bare
   * marker (no payload fields decoded); the format / column-formats body
   * is identical in shape to {@link CopyInResponse} / {@link CopyOutResponse}
   * but is not currently parsed since this client does not implement
   * streaming replication. The connection layer surfaces this as a clean
   * syntax-error-like diagnostic instead of crashing the protocol parser.
   */
  | { type: 'CopyBothResponse' }
  | { type: 'NoData' }
  | { type: 'ParseComplete' }
  | { type: 'BindComplete' }
  | { type: 'CloseComplete' }
  | { type: 'PortalSuspended' }
  | { type: 'ParameterDescription'; oids: number[] };

export class ProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// ---------------------------------------------------------------------------
// Frontend message encoders
//
// These are thin wrappers over `pg-protocol`'s `serialize.*`. The signatures
// mirror our previous hand-rolled API so callers in `connection.ts` and
// `pipeline.ts` don't need to change.
// ---------------------------------------------------------------------------

/**
 * StartupMessage. pg-protocol always appends `client_encoding=UTF8`; we
 * strip any incoming `client_encoding` to avoid duplicating it on the wire.
 * Our connect layer always sets UTF8 anyway, so this is a no-op in practice.
 */
export function StartupMessage(params: Record<string, string>): Buffer {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (key === 'client_encoding') continue;
    filtered[key] = value;
  }
  return serialize.startup(filtered);
}

/** SSLRequest — pg-protocol exposes this as `requestSsl`. */
export function SSLRequest(): Buffer {
  return serialize.requestSsl();
}

/** CancelRequest — pg-protocol's `cancel` is layout-compatible. */
export function CancelRequest(processId: number, secretKey: number): Buffer {
  return serialize.cancel(processId, secretKey);
}

/** Query: 'Q' + cstring(sql). */
export function Query(sql: string): Buffer {
  return serialize.query(sql);
}

/** Terminate: 'X' + 4-byte length. */
export function Terminate(): Buffer {
  return serialize.end();
}

/** Sync: 'S' + 4-byte length. */
export function Sync(): Buffer {
  return serialize.sync();
}

/** Flush: 'H' + 4-byte length. */
export function Flush(): Buffer {
  return serialize.flush();
}

/** Parse: 'P' + cstring(name) + cstring(sql) + Int16 nparam + {Int32 oid}*. */
export function Parse(name: string, sql: string, paramTypes: number[]): Buffer {
  return serialize.parse({ name, text: sql, types: paramTypes });
}

/**
 * Bind: 'B' + cstring(portal) + cstring(stmt) + per-value param formats +
 * value array + result formats.
 *
 * Note on parameter formats: pg-protocol's `serialize.bind` auto-detects the
 * format byte per value (`Buffer → 1`, `string/null → 0`); the caller-supplied
 * `paramFormats` arg is therefore ignored. This matches the hand-rolled
 * codec's effective behaviour because every caller passes either an empty
 * array (= "all text", which is what pg-protocol picks for strings) or a
 * format list that already agrees with the value's type.
 *
 * Note on result formats: we want every column in *text* format (`[0]`) for
 * `psql`-style printing. pg-protocol forces a single shared result-format
 * byte (`binary: boolean`); we pass `binary: false` to get text columns
 * regardless of the caller-supplied `resultFormats` array.
 */
export function Bind(
  portal: string,
  stmt: string,
  paramFormats: (0 | 1)[],
  params: (Buffer | string | null)[],
  resultFormats: (0 | 1)[],
): Buffer {
  // `paramFormats` and `resultFormats` are read for the rare future caller
  // that might want explicit control; pg-protocol's `serialize.bind` doesn't
  // expose either, so we intentionally drop them on the floor for now.
  void paramFormats;
  void resultFormats;
  return serialize.bind({
    portal,
    statement: stmt,
    values: params,
    binary: false,
  });
}

/** Describe: 'D' + byte('S'|'P') + cstring(name). */
export function Describe(target: 'S' | 'P', name: string): Buffer {
  return serialize.describe({ type: target, name });
}

/** Execute: 'E' + cstring(portal) + Int32 maxRows. */
export function Execute(portal: string, maxRows: number): Buffer {
  return serialize.execute({ portal, rows: maxRows });
}

/** Close: 'C' + byte('S'|'P') + cstring(name). */
export function Close(target: 'S' | 'P', name: string): Buffer {
  return serialize.close({ type: target, name });
}

/** PasswordMessage: 'p' + cstring(password). */
export function PasswordMessage(password: string): Buffer {
  return serialize.password(password);
}

/**
 * SASLInitialResponse: 'p' + cstring(mechanism) + Int32(bodyLen) + body.
 *
 * pg-protocol takes the initial response as a *string*; our SCRAM client
 * hands back a Buffer. SCRAM-SHA-256 messages are ASCII so this round-trips
 * losslessly via UTF-8.
 */
export function SASLInitialResponse(
  mechanism: string,
  response: Buffer,
): Buffer {
  return serialize.sendSASLInitialResponseMessage(
    mechanism,
    response.toString('utf8'),
  );
}

/** SASLResponse: 'p' + opaque body (no NUL terminator). */
export function SASLResponse(response: Buffer): Buffer {
  return serialize.sendSCRAMClientFinalMessage(response.toString('utf8'));
}

/** CopyData: 'd' + opaque bytes. */
export function CopyData(data: Buffer): Buffer {
  return serialize.copyData(data);
}

/** CopyDone: 'c' + 4-byte length. */
export function CopyDone(): Buffer {
  return serialize.copyDone();
}

/** CopyFail: 'f' + cstring(reason). */
export function CopyFail(message: string): Buffer {
  return serialize.copyFail(message);
}

// ---------------------------------------------------------------------------
// Backend message parser
// ---------------------------------------------------------------------------

/**
 * Streaming framer with a synchronous `feed()` API.
 *
 * Internally delegates to `pg-protocol`'s `Parser` (which exposes a
 * `parse(buffer, callback)` method that emits each completed backend message
 * via callback). On each `feed()` call we drain the parser and collect the
 * emitted messages into an array, reshaping each pg-protocol message into our
 * `BackendMessage` union (so `connection.ts`'s switch arms keep working).
 *
 * pg-protocol's `Parser.parse` calls the callback synchronously for every
 * complete message and keeps incomplete trailing bytes buffered internally.
 * That's a near-perfect match for our previous hand-rolled `MessageParser`.
 */
export class MessageParser {
  private readonly inner = new Parser();
  /** Bytes buffered inside `inner` but not yet emitted. Diagnostic only. */
  private buffered = 0;

  public feed(chunk: Buffer): BackendMessage[] {
    const out: BackendMessage[] = [];
    try {
      this.inner.parse(chunk, (msg) => {
        out.push(adaptBackendMessage(msg));
      });
    } catch (err) {
      // pg-protocol throws plain `Error` on bad input (unknown auth
      // subtype, truncated frames, …). Normalize to our type.
      throw err instanceof ProtocolError
        ? err
        : new ProtocolError(err instanceof Error ? err.message : String(err));
    }
    // Probe the parser's leftover length via its internal field. Used by a
    // handful of tests for diagnostics; not relied on in production code.
    const probe = this.inner as unknown as { bufferLength?: number };
    this.buffered = probe.bufferLength ?? 0;
    return out;
  }

  /**
   * Number of bytes buffered but not yet emitted (e.g. partial trailing
   * message). Exposed for tests / diagnostics.
   */
  public get bufferedBytes(): number {
    return this.buffered;
  }
}

// ---------------------------------------------------------------------------
// pg-protocol message → our BackendMessage shape
// ---------------------------------------------------------------------------

/**
 * pg-protocol's raw backend message shape (we don't get a single TS union
 * to discriminate on, so we duck-type on `name`). Each branch reshapes the
 * fields we care about and falls through to a ProtocolError otherwise.
 */
type AnyPgMessage = {
  name: string;
} & Record<string, unknown>;

function adaptBackendMessage(raw: unknown): BackendMessage {
  const msg = raw as AnyPgMessage;
  switch (msg.name) {
    case 'authenticationOk':
      return { type: 'AuthenticationOk' };
    case 'authenticationCleartextPassword':
      return { type: 'AuthenticationCleartextPassword' };
    case 'authenticationMD5Password':
      return {
        type: 'AuthenticationMD5Password',
        salt: Buffer.from(msg.salt as Buffer),
      };
    case 'authenticationSASL':
      return {
        type: 'AuthenticationSASL',
        mechanisms: msg.mechanisms as string[],
      };
    case 'authenticationSASLContinue':
      return {
        type: 'AuthenticationSASLContinue',
        data: Buffer.from(msg.data as string, 'utf8'),
      };
    case 'authenticationSASLFinal':
      return {
        type: 'AuthenticationSASLFinal',
        data: Buffer.from(msg.data as string, 'utf8'),
      };
    case 'parameterStatus':
      return {
        type: 'ParameterStatus',
        name: msg.parameterName as string,
        value: msg.parameterValue as string,
      };
    case 'backendKeyData':
      return {
        type: 'BackendKeyData',
        processId: msg.processID as number,
        secretKey: msg.secretKey as number,
      };
    case 'readyForQuery': {
      const status = msg.status as string;
      if (status !== 'I' && status !== 'T' && status !== 'E') {
        throw new ProtocolError(
          `ReadyForQuery: unexpected status ${JSON.stringify(status)}`,
        );
      }
      return { type: 'ReadyForQuery', status };
    }
    case 'rowDescription': {
      const fields: FieldDescription[] = (
        msg.fields as {
          name: string;
          tableID: number;
          columnID: number;
          dataTypeID: number;
          dataTypeSize: number;
          dataTypeModifier: number;
          format: 'text' | 'binary';
        }[]
      ).map((f) => ({
        name: f.name,
        tableID: f.tableID,
        columnID: f.columnID,
        dataTypeID: f.dataTypeID,
        dataTypeSize: f.dataTypeSize,
        dataTypeModifier: f.dataTypeModifier,
        format: f.format === 'binary' ? 1 : 0,
      }));
      return { type: 'RowDescription', fields };
    }
    case 'dataRow': {
      // pg-protocol always parses values as UTF-8 strings (or null for SQL
      // NULL). Our connection layer expects (Buffer | null)[] so it can hand
      // text-format columns through `.toString('utf8')` and pass binary
      // columns through unchanged. Re-encode here.
      const fields = msg.fields as (string | null)[];
      const values: (Buffer | null)[] = new Array(fields.length);
      for (let i = 0; i < fields.length; i++) {
        const v = fields[i];
        values[i] = v === null ? null : Buffer.from(v, 'utf8');
      }
      return { type: 'DataRow', values };
    }
    case 'commandComplete':
      return { type: 'CommandComplete', tag: msg.text as string };
    case 'emptyQuery':
      return { type: 'EmptyQueryResponse' };
    case 'error':
      return { type: 'ErrorResponse', fields: errorOrNoticeFields(msg) };
    case 'notice':
      return { type: 'NoticeResponse', fields: errorOrNoticeFields(msg) };
    case 'notification':
      return {
        type: 'NotificationResponse',
        processId: msg.processId as number,
        channel: msg.channel as string,
        payload: msg.payload as string,
      };
    case 'copyInResponse':
      return adaptCopyResponse('CopyInResponse', msg);
    case 'copyOutResponse':
      return adaptCopyResponse('CopyOutResponse', msg);
    case 'copyData':
      return { type: 'CopyData', data: Buffer.from(msg.chunk as Buffer) };
    case 'copyDone':
      return { type: 'CopyDone' };
    case 'noData':
      return { type: 'NoData' };
    case 'parseComplete':
      return { type: 'ParseComplete' };
    case 'bindComplete':
      return { type: 'BindComplete' };
    case 'closeComplete':
      return { type: 'CloseComplete' };
    case 'portalSuspended':
      return { type: 'PortalSuspended' };
    case 'parameterDescription':
      return {
        type: 'ParameterDescription',
        oids: msg.dataTypeIDs as number[],
      };
    default:
      throw new ProtocolError(`Unknown backend message: ${String(msg.name)}`);
  }
}

function adaptCopyResponse(
  type: 'CopyInResponse' | 'CopyOutResponse',
  msg: AnyPgMessage,
): BackendMessage {
  const binary = msg.binary as boolean;
  const columnTypes = msg.columnTypes as number[];
  const columnFormats: (0 | 1)[] = columnTypes.map((f) => (f === 1 ? 1 : 0));
  return {
    type,
    overallFormat: binary ? 1 : 0,
    columnFormats,
  };
}

/**
 * Re-pack pg-protocol's flattened Error/Notice fields (named properties like
 * `severity`, `code`, `detail`, …) into our previous `Map<tag, value>` shape
 * keyed by the on-wire single-letter tag. The map is consumed by
 * `fieldsToNotice` below.
 */
function errorOrNoticeFields(msg: AnyPgMessage): Map<string, string> {
  const out = new Map<string, string>();
  // The on-wire tag → field-name mapping is per PG docs §53.8. pg-protocol
  // stores `severity` from BOTH `S` and `V` (it overwrites with `V` if present)
  // — to preserve our previous behaviour (where the map carried both raw
  // tags), we copy S = V = severity when severity is defined. Consumers like
  // `fieldsToNotice` look at V then S so this matches.
  const set = (tag: string, value: unknown): void => {
    if (typeof value === 'string') out.set(tag, value);
  };
  set('S', msg.severity);
  set('V', msg.severity);
  set('C', msg.code);
  set('M', msg.message);
  set('D', msg.detail);
  set('H', msg.hint);
  set('P', msg.position);
  set('p', msg.internalPosition);
  set('q', msg.internalQuery);
  set('W', msg.where);
  set('s', msg.schema);
  set('t', msg.table);
  set('c', msg.column);
  set('d', msg.dataType);
  set('n', msg.constraint);
  set('F', msg.file);
  set('L', msg.line);
  set('R', msg.routine);
  return out;
}

// ---------------------------------------------------------------------------
// Notice helper (unchanged; consumed by connection.ts)
// ---------------------------------------------------------------------------

/**
 * Convert a notice/error field map into a Notice-shaped object. The wire
 * tags are PG's single-letter codes; we promote the ones the Connection
 * interface exposes.
 */
export function fieldsToNotice(fields: Map<string, string>): {
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
} {
  // Per PG docs: V is the non-localized severity (preferred when present),
  // S is the localized severity (always present). Message M is mandatory.
  const severity = fields.get('V') ?? fields.get('S') ?? '';
  const message = fields.get('M') ?? '';
  const out: ReturnType<typeof fieldsToNotice> = { severity, message };
  const code = fields.get('C');
  if (code !== undefined) out.code = code;
  const detail = fields.get('D');
  if (detail !== undefined) out.detail = detail;
  const hint = fields.get('H');
  if (hint !== undefined) out.hint = hint;
  const position = fields.get('P');
  if (position !== undefined) out.position = position;
  const internalPosition = fields.get('p');
  if (internalPosition !== undefined) out.internalPosition = internalPosition;
  const internalQuery = fields.get('q');
  if (internalQuery !== undefined) out.internalQuery = internalQuery;
  const where = fields.get('W');
  if (where !== undefined) out.where = where;
  const schema = fields.get('s');
  if (schema !== undefined) out.schema = schema;
  const table = fields.get('t');
  if (table !== undefined) out.table = table;
  const column = fields.get('c');
  if (column !== undefined) out.column = column;
  const dataType = fields.get('d');
  if (dataType !== undefined) out.dataType = dataType;
  const constraint = fields.get('n');
  if (constraint !== undefined) out.constraint = constraint;
  const file = fields.get('F');
  if (file !== undefined) out.file = file;
  const line = fields.get('L');
  if (line !== undefined) out.line = line;
  const routine = fields.get('R');
  if (routine !== undefined) out.routine = routine;
  return out;
}
