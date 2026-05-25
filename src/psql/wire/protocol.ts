/**
 * PostgreSQL wire protocol message codec (WP-02).
 *
 * Hand-rolled minimal replacement for `pg-protocol`. The repo's network is
 * sandboxed and we can't add the dep, so we implement just enough of
 * protocol v3.0 (PG 7.4+) to handle:
 *
 *   - Startup (with optional SSLRequest + SASL/MD5/Cleartext auth)
 *   - Simple Query
 *   - ParameterStatus / BackendKeyData / ReadyForQuery
 *   - NoticeResponse / NotificationResponse / ErrorResponse
 *   - CancelRequest (out-of-band)
 *   - COPY framing (CopyData / CopyDone / CopyFail) — encoder stubs here,
 *     full driver in WP-16.
 *   - Extended-query framing (Parse / Bind / Describe / Execute / Sync /
 *     Flush / Close) — encoder stubs here, driver in WP-21.
 *
 * Reference: https://www.postgresql.org/docs/current/protocol-message-formats.html
 *
 * Design notes:
 *   - Frontend message functions return a fully-formed Buffer ready to write
 *     to the socket. They allocate; we accept the cost because messages are
 *     small (<= a few KB typically) and the simple shape keeps the protocol
 *     easy to audit.
 *   - The backend parser is a streaming framer: `MessageParser.feed(chunk)`
 *     appends to an internal accumulator and pulls off complete messages
 *     (1-byte type + 4-byte length-including-itself + body). Partial messages
 *     stay buffered for the next `feed()` call. Length is bounds-checked so
 *     malformed input throws instead of OOM-ing.
 *   - Strings on the wire are UTF-8 cstrings (NUL-terminated). We do not
 *     attempt to re-encode `client_encoding` ourselves; libpq's behavior is
 *     "the server speaks whatever encoding the client claimed in startup",
 *     and we always claim UTF8.
 */

import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol v3.0 = (3 << 16) | 0 = 196608. */
const PROTOCOL_VERSION_3 = 196608;

/** Magic numbers for special startup variants (no message type byte). */
const SSL_REQUEST_CODE = 80877103;
const CANCEL_REQUEST_CODE = 80877102;
// const GSSENC_REQUEST_CODE = 80877104; // Reserved; not implemented.

// Frontend message type bytes. Not all are used here; left as docstrings of
// the wire alphabet for future maintenance.
const FE_QUERY = 0x51; // 'Q'
const FE_PARSE = 0x50; // 'P'
const FE_BIND = 0x42; // 'B'
const FE_DESCRIBE = 0x44; // 'D'
const FE_EXECUTE = 0x45; // 'E'
const FE_SYNC = 0x53; // 'S'
const FE_FLUSH = 0x48; // 'H'
const FE_CLOSE = 0x43; // 'C'
const FE_TERMINATE = 0x58; // 'X'
const FE_PASSWORD = 0x70; // 'p' — also SASL initial/response
const FE_COPY_DATA = 0x64; // 'd'
const FE_COPY_DONE = 0x63; // 'c'
const FE_COPY_FAIL = 0x66; // 'f'

// ---------------------------------------------------------------------------
// Backend message types
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
// ---------------------------------------------------------------------------

/**
 * StartupMessage (no type byte).
 *
 *   Int32 length (incl. self)
 *   Int32 protocol version (196608 for v3.0)
 *   { cstring key, cstring value }*
 *   0x00 terminator
 */
export function StartupMessage(params: Record<string, string>): Buffer {
  const entries: { key: Buffer; value: Buffer }[] = [];
  let body = 4 + 4; // length + protocol
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const k = Buffer.from(key, 'utf8');
    const v = Buffer.from(value, 'utf8');
    entries.push({ key: k, value: v });
    body += k.length + 1 + v.length + 1;
  }
  body += 1; // trailing 0

  const buf = Buffer.alloc(body);
  let off = 0;
  buf.writeInt32BE(body, off);
  off += 4;
  buf.writeInt32BE(PROTOCOL_VERSION_3, off);
  off += 4;
  for (const { key, value } of entries) {
    key.copy(buf, off);
    off += key.length;
    buf[off++] = 0;
    value.copy(buf, off);
    off += value.length;
    buf[off++] = 0;
  }
  buf[off] = 0;
  return buf;
}

/**
 * SSLRequest (no type byte).
 *
 *   Int32 length = 8
 *   Int32 80877103
 */
export function SSLRequest(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(8, 0);
  buf.writeInt32BE(SSL_REQUEST_CODE, 4);
  return buf;
}

/**
 * CancelRequest (no type byte; sent on a fresh connection).
 *
 *   Int32 length = 16
 *   Int32 80877102
 *   Int32 process id
 *   Int32 secret key
 */
export function CancelRequest(processId: number, secretKey: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeInt32BE(16, 0);
  buf.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  buf.writeInt32BE(processId, 8);
  buf.writeInt32BE(secretKey, 12);
  return buf;
}

/** Query: 'Q' Int32 len cstring sql */
export function Query(sql: string): Buffer {
  const s = Buffer.from(sql, 'utf8');
  const len = 4 + s.length + 1;
  const buf = Buffer.alloc(1 + len);
  buf[0] = FE_QUERY;
  buf.writeInt32BE(len, 1);
  s.copy(buf, 5);
  buf[buf.length - 1] = 0;
  return buf;
}

/** Terminate: 'X' Int32 4 */
export function Terminate(): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = FE_TERMINATE;
  buf.writeInt32BE(4, 1);
  return buf;
}

/** Sync: 'S' Int32 4 */
export function Sync(): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = FE_SYNC;
  buf.writeInt32BE(4, 1);
  return buf;
}

/** Flush: 'H' Int32 4 */
export function Flush(): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = FE_FLUSH;
  buf.writeInt32BE(4, 1);
  return buf;
}

/**
 * Parse: 'P' Int32 len cstring(stmt) cstring(sql) Int16 nparam {Int32 oid}*
 */
export function Parse(name: string, sql: string, paramTypes: number[]): Buffer {
  const n = Buffer.from(name, 'utf8');
  const s = Buffer.from(sql, 'utf8');
  const len = 4 + (n.length + 1) + (s.length + 1) + 2 + paramTypes.length * 4;
  const buf = Buffer.alloc(1 + len);
  let off = 0;
  buf[off++] = FE_PARSE;
  buf.writeInt32BE(len, off);
  off += 4;
  n.copy(buf, off);
  off += n.length;
  buf[off++] = 0;
  s.copy(buf, off);
  off += s.length;
  buf[off++] = 0;
  buf.writeUInt16BE(paramTypes.length, off);
  off += 2;
  for (const oid of paramTypes) {
    buf.writeUInt32BE(oid, off);
    off += 4;
  }
  return buf;
}

/**
 * Bind: 'B' Int32 len cstring(portal) cstring(stmt)
 *       Int16 nFormats {Int16 fmt}*
 *       Int16 nValues  {Int32 len, bytes | -1 if null}*
 *       Int16 nResultFormats {Int16 fmt}*
 *
 * `params` of `null` encodes as len = -1. Buffer params go raw. Strings UTF8.
 */
export function Bind(
  portal: string,
  stmt: string,
  paramFormats: (0 | 1)[],
  params: (Buffer | string | null)[],
  resultFormats: (0 | 1)[],
): Buffer {
  const p = Buffer.from(portal, 'utf8');
  const s = Buffer.from(stmt, 'utf8');

  const paramBufs: (Buffer | null)[] = params.map((v) => {
    if (v === null) return null;
    if (Buffer.isBuffer(v)) return v;
    return Buffer.from(v, 'utf8');
  });

  let len = 4 + (p.length + 1) + (s.length + 1);
  len += 2 + paramFormats.length * 2;
  len += 2;
  for (const b of paramBufs) {
    len += 4;
    if (b !== null) len += b.length;
  }
  len += 2 + resultFormats.length * 2;

  const buf = Buffer.alloc(1 + len);
  let off = 0;
  buf[off++] = FE_BIND;
  buf.writeInt32BE(len, off);
  off += 4;
  p.copy(buf, off);
  off += p.length;
  buf[off++] = 0;
  s.copy(buf, off);
  off += s.length;
  buf[off++] = 0;

  buf.writeUInt16BE(paramFormats.length, off);
  off += 2;
  for (const fmt of paramFormats) {
    buf.writeUInt16BE(fmt, off);
    off += 2;
  }

  buf.writeUInt16BE(paramBufs.length, off);
  off += 2;
  for (const b of paramBufs) {
    if (b === null) {
      buf.writeInt32BE(-1, off);
      off += 4;
    } else {
      buf.writeInt32BE(b.length, off);
      off += 4;
      b.copy(buf, off);
      off += b.length;
    }
  }

  buf.writeUInt16BE(resultFormats.length, off);
  off += 2;
  for (const fmt of resultFormats) {
    buf.writeUInt16BE(fmt, off);
    off += 2;
  }
  return buf;
}

/** Describe: 'D' Int32 len byte('S'|'P') cstring(name) */
export function Describe(target: 'S' | 'P', name: string): Buffer {
  const n = Buffer.from(name, 'utf8');
  const len = 4 + 1 + n.length + 1;
  const buf = Buffer.alloc(1 + len);
  let off = 0;
  buf[off++] = FE_DESCRIBE;
  buf.writeInt32BE(len, off);
  off += 4;
  buf[off++] = target.charCodeAt(0);
  n.copy(buf, off);
  off += n.length;
  buf[off] = 0;
  return buf;
}

/** Execute: 'E' Int32 len cstring(portal) Int32 maxRows */
export function Execute(portal: string, maxRows: number): Buffer {
  const p = Buffer.from(portal, 'utf8');
  const len = 4 + p.length + 1 + 4;
  const buf = Buffer.alloc(1 + len);
  let off = 0;
  buf[off++] = FE_EXECUTE;
  buf.writeInt32BE(len, off);
  off += 4;
  p.copy(buf, off);
  off += p.length;
  buf[off++] = 0;
  buf.writeInt32BE(maxRows, off);
  return buf;
}

/** Close: 'C' Int32 len byte('S'|'P') cstring(name) */
export function Close(target: 'S' | 'P', name: string): Buffer {
  const n = Buffer.from(name, 'utf8');
  const len = 4 + 1 + n.length + 1;
  const buf = Buffer.alloc(1 + len);
  let off = 0;
  buf[off++] = FE_CLOSE;
  buf.writeInt32BE(len, off);
  off += 4;
  buf[off++] = target.charCodeAt(0);
  n.copy(buf, off);
  off += n.length;
  buf[off] = 0;
  return buf;
}

/**
 * PasswordMessage / cleartext-or-MD5 path: 'p' Int32 len cstring(password)
 */
export function PasswordMessage(password: string): Buffer {
  const p = Buffer.from(password, 'utf8');
  const len = 4 + p.length + 1;
  const buf = Buffer.alloc(1 + len);
  buf[0] = FE_PASSWORD;
  buf.writeInt32BE(len, 1);
  p.copy(buf, 5);
  buf[buf.length - 1] = 0;
  return buf;
}

/**
 * SASLInitialResponse: 'p' Int32 len cstring(mechanism)
 *                          Int32 responseLen (or -1 if none)
 *                          bytes(response)
 */
export function SASLInitialResponse(
  mechanism: string,
  response: Buffer,
): Buffer {
  const m = Buffer.from(mechanism, 'utf8');
  const len = 4 + m.length + 1 + 4 + response.length;
  const buf = Buffer.alloc(1 + len);
  let off = 0;
  buf[off++] = FE_PASSWORD;
  buf.writeInt32BE(len, off);
  off += 4;
  m.copy(buf, off);
  off += m.length;
  buf[off++] = 0;
  buf.writeInt32BE(response.length, off);
  off += 4;
  response.copy(buf, off);
  return buf;
}

/** SASLResponse: 'p' Int32 len bytes(response) */
export function SASLResponse(response: Buffer): Buffer {
  const len = 4 + response.length;
  const buf = Buffer.alloc(1 + len);
  buf[0] = FE_PASSWORD;
  buf.writeInt32BE(len, 1);
  response.copy(buf, 5);
  return buf;
}

/** CopyData: 'd' Int32 len bytes */
export function CopyData(data: Buffer): Buffer {
  const len = 4 + data.length;
  const buf = Buffer.alloc(1 + len);
  buf[0] = FE_COPY_DATA;
  buf.writeInt32BE(len, 1);
  data.copy(buf, 5);
  return buf;
}

/** CopyDone: 'c' Int32 4 */
export function CopyDone(): Buffer {
  const buf = Buffer.alloc(5);
  buf[0] = FE_COPY_DONE;
  buf.writeInt32BE(4, 1);
  return buf;
}

/** CopyFail: 'f' Int32 len cstring(reason) */
export function CopyFail(message: string): Buffer {
  const m = Buffer.from(message, 'utf8');
  const len = 4 + m.length + 1;
  const buf = Buffer.alloc(1 + len);
  buf[0] = FE_COPY_FAIL;
  buf.writeInt32BE(len, 1);
  m.copy(buf, 5);
  buf[buf.length - 1] = 0;
  return buf;
}

// ---------------------------------------------------------------------------
// Backend message parser
// ---------------------------------------------------------------------------

/**
 * Streaming framer. Caller pushes raw socket bytes via `feed()`, gets back
 * an array of fully-parsed messages. Leftover bytes (incomplete trailing
 * message) stay buffered for next call.
 *
 * Memory: holds at most one accumulator buffer. We compact on every feed
 * once the head pointer crosses 32 KiB so a long-running connection doesn't
 * accumulate unreachable bytes. (Compaction is amortized O(n) — same shape
 * as a circular-buffer pull.)
 */
const COMPACT_THRESHOLD = 32 * 1024;

export class MessageParser {
  private buf: Buffer = Buffer.alloc(0);
  private head = 0;

  public feed(chunk: Buffer): BackendMessage[] {
    if (chunk.length > 0) {
      // Concatenate (only the live region of `buf`) + new chunk.
      if (this.head === this.buf.length) {
        this.buf = chunk;
      } else {
        this.buf = Buffer.concat([this.buf.subarray(this.head), chunk]);
      }
      this.head = 0;
    } else if (this.head >= this.buf.length) {
      return [];
    }

    const out: BackendMessage[] = [];
    while (this.buf.length - this.head >= 5) {
      const type = this.buf[this.head];
      // Length includes the 4 length bytes but NOT the type byte.
      const declared = this.buf.readInt32BE(this.head + 1);
      if (declared < 4) {
        throw new ProtocolError(
          `Backend message length ${String(declared)} < 4 (type 0x${type.toString(16)})`,
        );
      }
      const totalSize = 1 + declared;
      if (this.buf.length - this.head < totalSize) {
        break; // Incomplete; wait for more bytes.
      }
      const body = this.buf.subarray(this.head + 5, this.head + totalSize);
      out.push(parseMessage(type, body));
      this.head += totalSize;
    }

    if (this.head > COMPACT_THRESHOLD) {
      this.buf = this.buf.subarray(this.head);
      this.head = 0;
    }
    return out;
  }

  /**
   * Number of bytes buffered but not yet emitted (e.g. partial trailing
   * message). Exposed for tests / diagnostics.
   */
  public get bufferedBytes(): number {
    return this.buf.length - this.head;
  }
}

// ---------------------------------------------------------------------------
// Per-message parsing
// ---------------------------------------------------------------------------

function parseMessage(type: number, body: Buffer): BackendMessage {
  switch (type) {
    case 0x52: // 'R' Authentication*
      return parseAuth(body);
    case 0x53: // 'S' ParameterStatus
      return parseParameterStatus(body);
    case 0x4b: // 'K' BackendKeyData
      return parseBackendKeyData(body);
    case 0x5a: // 'Z' ReadyForQuery
      return parseReadyForQuery(body);
    case 0x54: // 'T' RowDescription
      return parseRowDescription(body);
    case 0x44: // 'D' DataRow
      return parseDataRow(body);
    case 0x43: // 'C' CommandComplete
      return { type: 'CommandComplete', tag: readCString(body, 0).value };
    case 0x49: // 'I' EmptyQueryResponse
      return { type: 'EmptyQueryResponse' };
    case 0x45: // 'E' ErrorResponse
      return { type: 'ErrorResponse', fields: parseErrorFields(body) };
    case 0x4e: // 'N' NoticeResponse
      return { type: 'NoticeResponse', fields: parseErrorFields(body) };
    case 0x41: // 'A' NotificationResponse
      return parseNotification(body);
    case 0x47: // 'G' CopyInResponse
      return parseCopyResponse('CopyInResponse', body);
    case 0x48: // 'H' CopyOutResponse
      return parseCopyResponse('CopyOutResponse', body);
    case 0x64: // 'd' CopyData
      return { type: 'CopyData', data: Buffer.from(body) };
    case 0x63: // 'c' CopyDone
      return { type: 'CopyDone' };
    case 0x6e: // 'n' NoData
      return { type: 'NoData' };
    case 0x31: // '1' ParseComplete
      return { type: 'ParseComplete' };
    case 0x32: // '2' BindComplete
      return { type: 'BindComplete' };
    case 0x33: // '3' CloseComplete
      return { type: 'CloseComplete' };
    case 0x73: // 's' PortalSuspended
      return { type: 'PortalSuspended' };
    case 0x74: // 't' ParameterDescription
      return parseParameterDescription(body);
    default:
      throw new ProtocolError(
        `Unknown backend message type 0x${type.toString(16)} (${String.fromCharCode(type)})`,
      );
  }
}

function parseAuth(body: Buffer): BackendMessage {
  if (body.length < 4) {
    throw new ProtocolError('Authentication message too short');
  }
  const code = body.readInt32BE(0);
  switch (code) {
    case 0:
      return { type: 'AuthenticationOk' };
    case 3:
      return { type: 'AuthenticationCleartextPassword' };
    case 5:
      if (body.length !== 4 + 4) {
        throw new ProtocolError(
          `AuthenticationMD5Password expected 8-byte body, got ${String(body.length)}`,
        );
      }
      return {
        type: 'AuthenticationMD5Password',
        salt: Buffer.from(body.subarray(4, 8)),
      };
    case 10: {
      // SASL: zero-or-more cstrings, terminated by an empty cstring (i.e. 0x00).
      const mechanisms: string[] = [];
      let off = 4;
      while (off < body.length) {
        const { value, next } = readCString(body, off);
        if (value === '') break;
        mechanisms.push(value);
        off = next;
      }
      return { type: 'AuthenticationSASL', mechanisms };
    }
    case 11:
      return {
        type: 'AuthenticationSASLContinue',
        data: Buffer.from(body.subarray(4)),
      };
    case 12:
      return {
        type: 'AuthenticationSASLFinal',
        data: Buffer.from(body.subarray(4)),
      };
    default:
      throw new ProtocolError(
        `Unsupported Authentication subtype ${String(code)} (KerberosV5/SSPI/GSS/SSPI Continue not implemented)`,
      );
  }
}

function parseParameterStatus(body: Buffer): BackendMessage {
  const { value: name, next } = readCString(body, 0);
  const { value } = readCString(body, next);
  return { type: 'ParameterStatus', name, value };
}

function parseBackendKeyData(body: Buffer): BackendMessage {
  if (body.length !== 8) {
    throw new ProtocolError(
      `BackendKeyData expected 8-byte body, got ${String(body.length)}`,
    );
  }
  return {
    type: 'BackendKeyData',
    processId: body.readInt32BE(0),
    secretKey: body.readInt32BE(4),
  };
}

function parseReadyForQuery(body: Buffer): BackendMessage {
  if (body.length !== 1) {
    throw new ProtocolError(
      `ReadyForQuery expected 1-byte body, got ${String(body.length)}`,
    );
  }
  const ch = String.fromCharCode(body[0]);
  if (ch !== 'I' && ch !== 'T' && ch !== 'E') {
    throw new ProtocolError(
      `ReadyForQuery: unexpected status ${JSON.stringify(ch)}`,
    );
  }
  return { type: 'ReadyForQuery', status: ch };
}

function parseRowDescription(body: Buffer): BackendMessage {
  if (body.length < 2) {
    throw new ProtocolError('RowDescription body too short');
  }
  const n = body.readUInt16BE(0);
  let off = 2;
  const fields: FieldDescription[] = [];
  for (let i = 0; i < n; i++) {
    const { value: name, next } = readCString(body, off);
    off = next;
    if (off + 18 > body.length) {
      throw new ProtocolError('RowDescription field truncated');
    }
    const tableID = body.readInt32BE(off);
    off += 4;
    const columnID = body.readInt16BE(off);
    off += 2;
    const dataTypeID = body.readInt32BE(off);
    off += 4;
    const dataTypeSize = body.readInt16BE(off);
    off += 2;
    const dataTypeModifier = body.readInt32BE(off);
    off += 4;
    const fmt = body.readInt16BE(off);
    off += 2;
    if (fmt !== 0 && fmt !== 1) {
      throw new ProtocolError(
        `RowDescription field ${String(i)} has invalid format ${String(fmt)}`,
      );
    }
    fields.push({
      name,
      tableID,
      columnID,
      dataTypeID,
      dataTypeSize,
      dataTypeModifier,
      format: fmt,
    });
  }
  return { type: 'RowDescription', fields };
}

function parseDataRow(body: Buffer): BackendMessage {
  if (body.length < 2) throw new ProtocolError('DataRow body too short');
  const n = body.readUInt16BE(0);
  let off = 2;
  const values: (Buffer | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (off + 4 > body.length) {
      throw new ProtocolError('DataRow column header truncated');
    }
    const len = body.readInt32BE(off);
    off += 4;
    if (len === -1) {
      values.push(null);
    } else {
      if (len < 0 || off + len > body.length) {
        throw new ProtocolError(
          `DataRow column ${String(i)} length ${String(len)} out of bounds`,
        );
      }
      values.push(Buffer.from(body.subarray(off, off + len)));
      off += len;
    }
  }
  return { type: 'DataRow', values };
}

function parseNotification(body: Buffer): BackendMessage {
  if (body.length < 4) {
    throw new ProtocolError('NotificationResponse body too short');
  }
  const processId = body.readInt32BE(0);
  const { value: channel, next } = readCString(body, 4);
  const { value: payload } = readCString(body, next);
  return { type: 'NotificationResponse', processId, channel, payload };
}

function parseCopyResponse(
  kind: 'CopyInResponse' | 'CopyOutResponse',
  body: Buffer,
): BackendMessage {
  if (body.length < 3) {
    throw new ProtocolError(`${kind} body too short`);
  }
  const overall = body[0];
  if (overall !== 0 && overall !== 1) {
    throw new ProtocolError(
      `${kind} overall format must be 0 or 1, got ${String(overall)}`,
    );
  }
  const ncols = body.readUInt16BE(1);
  const expected = 3 + ncols * 2;
  if (body.length < expected) {
    throw new ProtocolError(
      `${kind} truncated: ncols=${String(ncols)} but body=${String(body.length)}`,
    );
  }
  const columnFormats: (0 | 1)[] = [];
  for (let i = 0; i < ncols; i++) {
    const fmt = body.readInt16BE(3 + i * 2);
    if (fmt !== 0 && fmt !== 1) {
      throw new ProtocolError(
        `${kind} column ${String(i)} format must be 0 or 1, got ${String(fmt)}`,
      );
    }
    columnFormats.push(fmt);
  }
  return { type: kind, overallFormat: overall, columnFormats };
}

function parseParameterDescription(body: Buffer): BackendMessage {
  if (body.length < 2) {
    throw new ProtocolError('ParameterDescription body too short');
  }
  const n = body.readUInt16BE(0);
  const oids: number[] = [];
  if (body.length < 2 + n * 4) {
    throw new ProtocolError('ParameterDescription truncated');
  }
  for (let i = 0; i < n; i++) {
    oids.push(body.readUInt32BE(2 + i * 4));
  }
  return { type: 'ParameterDescription', oids };
}

/**
 * ErrorResponse / NoticeResponse share the same body format:
 *   { byte tag, cstring value }*
 *   0x00 terminator
 *
 * Field tag glossary (PG docs §53.8): S/V/C/M/D/H/P/p/q/W/s/t/c/d/n/F/L/R.
 * We don't try to interpret each tag — that's the caller's job; we just
 * return the raw map.
 */
function parseErrorFields(body: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (off < body.length) {
    const tag = body[off];
    if (tag === 0) break;
    off += 1;
    const { value, next } = readCString(body, off);
    out.set(String.fromCharCode(tag), value);
    off = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reads a UTF-8 cstring starting at `off`. Returns the value and the offset
 * past the trailing NUL. Throws on missing terminator. */
function readCString(
  buf: Buffer,
  off: number,
): { value: string; next: number } {
  for (let i = off; i < buf.length; i++) {
    if (buf[i] === 0) {
      return {
        value: buf.toString('utf8', off, i),
        next: i + 1,
      };
    }
  }
  throw new ProtocolError(
    `cstring missing NUL terminator (off=${String(off)}, end=${String(buf.length)})`,
  );
}

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
