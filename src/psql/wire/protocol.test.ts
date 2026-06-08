/**
 * Adapter tests for the `pg-protocol`-backed wire codec.
 *
 * Strategy:
 *
 *   - Frontend encoders: spot-check that we delegate to `pg-protocol`'s
 *     `serialize.*` correctly for the inputs that matter to us. We don't
 *     re-assert byte layout — pg-protocol owns that and has its own tests.
 *     We do verify our wrapper preserves required invariants (e.g. the
 *     `client_encoding` dedup in StartupMessage).
 *
 *   - MessageParser: feed pre-built byte fixtures (constructed against the
 *     PG protocol §52 message format docs) and assert that the emitted
 *     BackendMessage values have the expected `type` plus normalized field
 *     shapes our `connection.ts` switches on. The bytes themselves come
 *     from a fixture builder so tests don't accidentally couple to
 *     pg-protocol's internal layout.
 */

import { describe, expect, test } from 'vitest';
import { Buffer } from 'node:buffer';

import {
  Bind,
  CancelRequest,
  Close,
  CopyData,
  CopyDone,
  CopyFail,
  Describe,
  Execute,
  Flush,
  MessageParser,
  Parse,
  PasswordMessage,
  Query,
  SASLInitialResponse,
  SASLResponse,
  SSLRequest,
  StartupMessage,
  Sync,
  Terminate,
  fieldsToNotice,
} from './protocol.js';
import type { BackendMessage } from './protocol.js';

// ---------------------------------------------------------------------------
// Backend message fixture builders (PG protocol §52 / §53)
// ---------------------------------------------------------------------------

function backendMessage(typeByte: string, body: Buffer): Buffer {
  const out = Buffer.alloc(1 + 4 + body.length);
  out[0] = typeByte.charCodeAt(0);
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}

function cstring(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

// ---------------------------------------------------------------------------
// Frontend encoders (adapter sanity, not byte layout)
// ---------------------------------------------------------------------------

describe('frontend encoders', () => {
  test('StartupMessage emits a v3 startup frame and dedups client_encoding', () => {
    // `serialize.startup` always appends client_encoding=UTF8 internally;
    // our wrapper must strip any caller-supplied client_encoding to avoid
    // having it appear twice on the wire.
    const buf = StartupMessage({
      user: 'alice',
      database: 'db',
      client_encoding: 'UTF8',
    });
    // Layout sanity: Int32 length, Int32 196608 protocol version.
    expect(buf.readInt32BE(0)).toBe(buf.length);
    expect(buf.readInt32BE(4)).toBe(196608); // (3 << 16) | 0
    // Exactly one occurrence of "client_encoding" cstring.
    const occurrences =
      buf.toString('utf8').split('client_encoding').length - 1;
    expect(occurrences).toBe(1);
    // Caller-supplied values are present.
    expect(buf.includes(Buffer.from('alice\0'))).toBe(true);
    expect(buf.includes(Buffer.from('database\0db\0'))).toBe(true);
  });

  test('SSLRequest is the well-known 8-byte 80877103 frame', () => {
    expect(SSLRequest().toString('hex')).toBe('0000000804d2162f');
  });

  test('CancelRequest carries processId + secretKey', () => {
    const buf = CancelRequest(0x11223344, 0x55667788);
    expect(buf.length).toBe(16);
    expect(buf.readInt32BE(0)).toBe(16);
    expect(buf.readInt32BE(4)).toBe(80877102);
    expect(buf.readInt32BE(8)).toBe(0x11223344);
    expect(buf.readInt32BE(12)).toBe(0x55667788);
  });

  test('Query frames as Q + len + cstring(sql)', () => {
    const buf = Query('SELECT 1');
    expect(String.fromCharCode(buf[0])).toBe('Q');
    // The SQL bytes are present, NUL-terminated.
    expect(buf.includes(Buffer.from('SELECT 1\0'))).toBe(true);
    // Declared length matches the buffer (minus the type byte).
    expect(buf.readInt32BE(1)).toBe(buf.length - 1);
  });

  test('Terminate / Sync / Flush are bare 5-byte messages', () => {
    expect(Terminate().toString('hex')).toBe('5800000004');
    expect(Sync().toString('hex')).toBe('5300000004');
    expect(Flush().toString('hex')).toBe('4800000004');
  });

  test('PasswordMessage encodes as p + cstring(password)', () => {
    const buf = PasswordMessage('s3cret');
    expect(String.fromCharCode(buf[0])).toBe('p');
    expect(buf.includes(Buffer.from('s3cret\0'))).toBe(true);
  });

  test('Parse encodes name, sql, and parameter OIDs', () => {
    const buf = Parse('stmt1', 'SELECT $1', [23]);
    expect(String.fromCharCode(buf[0])).toBe('P');
    // Both cstrings are present.
    expect(buf.includes(Buffer.from('stmt1\0'))).toBe(true);
    expect(buf.includes(Buffer.from('SELECT $1\0'))).toBe(true);
    // Tail: Int16(1) Int32(23) — i.e. one parameter, OID = 23.
    expect(buf.readUInt16BE(buf.length - 6)).toBe(1);
    expect(buf.readUInt32BE(buf.length - 4)).toBe(23);
  });

  test('Describe / Execute / Close target a statement or portal', () => {
    const d = Describe('S', 'stmt1');
    expect(String.fromCharCode(d[0])).toBe('D');
    expect(d.includes(Buffer.from('Sstmt1\0'))).toBe(true);

    const e = Execute('p1', 100);
    expect(String.fromCharCode(e[0])).toBe('E');
    expect(e.includes(Buffer.from('p1\0'))).toBe(true);
    // Last 4 bytes = maxRows.
    expect(e.readUInt32BE(e.length - 4)).toBe(100);

    const c = Close('P', 'p2');
    expect(String.fromCharCode(c[0])).toBe('C');
    expect(c.includes(Buffer.from('Pp2\0'))).toBe(true);
  });

  test('Copy framing', () => {
    const cd = CopyData(Buffer.from([1, 2, 3]));
    expect(String.fromCharCode(cd[0])).toBe('d');
    expect(cd.subarray(cd.length - 3).toString('hex')).toBe('010203');

    expect(CopyDone().toString('hex')).toBe('6300000004');

    const cf = CopyFail('boom');
    expect(String.fromCharCode(cf[0])).toBe('f');
    expect(cf.includes(Buffer.from('boom\0'))).toBe(true);
  });

  test('Bind round-trips through pg-protocol with null + non-null values', () => {
    // We don't care about the exact byte layout (pg-protocol owns that), but
    // we do care that the frame can be sent and that distinguishing fields
    // (portal/stmt cstrings, presence of -1 for null) are still in the
    // buffer.
    const buf = Bind('', 'stmt1', [0], [null, Buffer.from('hi')], [0]);
    expect(String.fromCharCode(buf[0])).toBe('B');
    expect(buf.includes(Buffer.from('stmt1\0'))).toBe(true);
    // A null parameter writes a 4-byte -1 length somewhere in the body.
    let sawNullLen = false;
    for (let i = 5; i < buf.length - 4; i++) {
      if (buf.readInt32BE(i) === -1) {
        sawNullLen = true;
        break;
      }
    }
    expect(sawNullLen).toBe(true);
    // The non-null param "hi" must appear verbatim.
    expect(buf.includes(Buffer.from('hi'))).toBe(true);
  });

  test('SASLInitialResponse encodes mechanism cstring + length-prefixed body', () => {
    const body = Buffer.from('n,,n=,r=abc', 'utf8');
    const buf = SASLInitialResponse('SCRAM-SHA-256', body);
    expect(String.fromCharCode(buf[0])).toBe('p');
    // The mechanism cstring must appear.
    expect(buf.includes(Buffer.from('SCRAM-SHA-256\0'))).toBe(true);
    // The body bytes must appear verbatim.
    expect(buf.includes(body)).toBe(true);
  });

  test('SASLResponse encodes opaque body (no NUL terminator)', () => {
    const body = Buffer.from('c=biws,r=abc,p=xxx', 'utf8');
    const buf = SASLResponse(body);
    expect(String.fromCharCode(buf[0])).toBe('p');
    expect(buf.includes(body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backend parser — adapter shape mapping
// ---------------------------------------------------------------------------

describe('MessageParser', () => {
  test('parses ReadyForQuery in one shot', () => {
    const p = new MessageParser();
    const msgs = p.feed(backendMessage('Z', Buffer.from('I')));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'ReadyForQuery', status: 'I' });
    expect(p.bufferedBytes).toBe(0);
  });

  test('streams a typical SELECT 1 cycle byte-by-byte', () => {
    // RowDescription: one column "?column?" of int4 (OID 23), text format.
    const colDesc = Buffer.concat([
      Buffer.from([0, 1]), // 1 column
      cstring('?column?'),
      Buffer.alloc(4), // tableID
      Buffer.alloc(2), // columnID
      Buffer.from([0, 0, 0, 23]), // dataTypeID
      Buffer.from([0, 4]), // dataTypeSize
      Buffer.alloc(4), // dataTypeModifier
      Buffer.from([0, 0]), // format = text
    ]);
    const row1 = Buffer.concat([
      Buffer.from([0, 1]), // 1 column
      Buffer.from([0, 0, 0, 1]), // len = 1
      Buffer.from('1'),
    ]);
    const nullLen = Buffer.alloc(4);
    nullLen.writeInt32BE(-1, 0);
    const row2 = Buffer.concat([Buffer.from([0, 1]), nullLen]);

    const cycle = Buffer.concat([
      backendMessage('T', colDesc),
      backendMessage('D', row1),
      backendMessage('D', row2),
      backendMessage('C', cstring('SELECT 2')),
      backendMessage('Z', Buffer.from('I')),
    ]);

    const p = new MessageParser();
    const out: BackendMessage[] = [];
    for (let i = 0; i < cycle.length; i++) {
      out.push(...p.feed(cycle.subarray(i, i + 1)));
    }

    expect(out).toHaveLength(5);
    const desc = out[0];
    if (desc.type !== 'RowDescription') {
      throw new Error('expected RowDescription');
    }
    expect(desc.fields).toHaveLength(1);
    expect(desc.fields[0].name).toBe('?column?');
    expect(desc.fields[0].dataTypeID).toBe(23);
    expect(desc.fields[0].format).toBe(0);

    const d1 = out[1];
    if (d1.type !== 'DataRow') throw new Error('expected DataRow');
    expect(d1.values).toHaveLength(1);
    expect(d1.values[0]?.toString()).toBe('1');

    const d2 = out[2];
    if (d2.type !== 'DataRow') throw new Error('expected DataRow');
    expect(d2.values[0]).toBeNull();

    expect(out[3]).toEqual({ type: 'CommandComplete', tag: 'SELECT 2' });
    expect(out[4]).toEqual({ type: 'ReadyForQuery', status: 'I' });
  });

  test('returns nothing on truncated message and finishes on remainder', () => {
    const full = backendMessage('Z', Buffer.from('T'));
    const p = new MessageParser();
    const head = p.feed(full.subarray(0, 3));
    expect(head).toEqual([]);
    expect(p.bufferedBytes).toBe(3);
    const tail = p.feed(full.subarray(3));
    expect(tail).toEqual([{ type: 'ReadyForQuery', status: 'T' }]);
    expect(p.bufferedBytes).toBe(0);
  });

  test('parses ErrorResponse fields and converts to Notice', () => {
    const body = Buffer.concat([
      Buffer.from('S'),
      cstring('ERROR'),
      Buffer.from('V'),
      cstring('ERROR'),
      Buffer.from('C'),
      cstring('42P01'),
      Buffer.from('M'),
      cstring('relation "foo" does not exist'),
      Buffer.from('H'),
      cstring('check spelling'),
      Buffer.from([0]),
    ]);
    const p = new MessageParser();
    const [msg] = p.feed(backendMessage('E', body));
    if (msg.type !== 'ErrorResponse') {
      throw new Error('expected ErrorResponse');
    }
    expect(msg.fields.get('C')).toBe('42P01');
    const notice = fieldsToNotice(msg.fields);
    expect(notice.severity).toBe('ERROR');
    expect(notice.code).toBe('42P01');
    expect(notice.message).toBe('relation "foo" does not exist');
    expect(notice.hint).toBe('check spelling');
  });

  test('parses AuthenticationSASL mechanism list', () => {
    const body = Buffer.concat([
      Buffer.from([0, 0, 0, 10]), // subtype 10
      cstring('SCRAM-SHA-256'),
      cstring('SCRAM-SHA-256-PLUS'),
      Buffer.from([0]),
    ]);
    const [msg] = new MessageParser().feed(backendMessage('R', body));
    if (msg.type !== 'AuthenticationSASL') {
      throw new Error('expected AuthenticationSASL');
    }
    expect(msg.mechanisms).toEqual(['SCRAM-SHA-256', 'SCRAM-SHA-256-PLUS']);
  });

  test('parses ParameterStatus and BackendKeyData', () => {
    const ps = backendMessage(
      'S',
      Buffer.concat([cstring('server_version'), cstring('16.2')]),
    );
    const kd = backendMessage(
      'K',
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x10]),
        Buffer.from([0, 0, 0, 0x20]),
      ]),
    );
    const p = new MessageParser();
    const out = p.feed(Buffer.concat([ps, kd]));
    expect(out[0]).toEqual({
      type: 'ParameterStatus',
      name: 'server_version',
      value: '16.2',
    });
    expect(out[1]).toEqual({
      type: 'BackendKeyData',
      processId: 0x10,
      secretKey: 0x20,
    });
  });

  test('parses NotificationResponse', () => {
    const body = Buffer.concat([
      Buffer.from([0, 0, 0, 9]),
      cstring('chan'),
      cstring('payload'),
    ]);
    const [msg] = new MessageParser().feed(backendMessage('A', body));
    expect(msg).toEqual({
      type: 'NotificationResponse',
      processId: 9,
      channel: 'chan',
      payload: 'payload',
    });
  });

  test('parses CopyInResponse + CopyOutResponse with column formats', () => {
    const copyBody = Buffer.from([
      0x00, // overall format = text
      0x00,
      0x02, // 2 columns
      0x00,
      0x00, // text
      0x00,
      0x01, // binary
    ]);
    const inMsg = new MessageParser().feed(backendMessage('G', copyBody))[0];
    if (inMsg.type !== 'CopyInResponse') {
      throw new Error('expected CopyInResponse');
    }
    expect(inMsg.overallFormat).toBe(0);
    expect(inMsg.columnFormats).toEqual([0, 1]);

    const outMsg = new MessageParser().feed(backendMessage('H', copyBody))[0];
    if (outMsg.type !== 'CopyOutResponse') {
      throw new Error('expected CopyOutResponse');
    }
    expect(outMsg.columnFormats).toEqual([0, 1]);
  });

  test('parses extended-protocol terminators', () => {
    // ParseComplete (1), BindComplete (2), CloseComplete (3),
    // PortalSuspended (s), NoData (n), EmptyQueryResponse (I) — all body-less.
    const cycle = Buffer.concat([
      backendMessage('1', Buffer.alloc(0)),
      backendMessage('2', Buffer.alloc(0)),
      backendMessage('3', Buffer.alloc(0)),
      backendMessage('s', Buffer.alloc(0)),
      backendMessage('n', Buffer.alloc(0)),
      backendMessage('I', Buffer.alloc(0)),
    ]);
    const out = new MessageParser().feed(cycle);
    expect(out.map((m) => m.type)).toEqual([
      'ParseComplete',
      'BindComplete',
      'CloseComplete',
      'PortalSuspended',
      'NoData',
      'EmptyQueryResponse',
    ]);
  });

  test('parses ParameterDescription', () => {
    const body = Buffer.alloc(2 + 4 * 2);
    body.writeUInt16BE(2, 0);
    body.writeUInt32BE(23, 2);
    body.writeUInt32BE(25, 6);
    const [msg] = new MessageParser().feed(backendMessage('t', body));
    if (msg.type !== 'ParameterDescription') {
      throw new Error('expected ParameterDescription');
    }
    expect(msg.oids).toEqual([23, 25]);
  });

  test('parses CopyBothResponse (W) as a bare marker', () => {
    // pg-protocol parses 'W' as a `replicationStart` message, which we
    // surface as `CopyBothResponse` so the connection state machine can
    // recognise walsender / `START_REPLICATION` responses (without
    // implementing streaming replication; the body's per-column format
    // bytes are intentionally not decoded).
    const p = new MessageParser();
    const [msg] = p.feed(backendMessage('W', Buffer.alloc(0)));
    expect(msg.type).toBe('CopyBothResponse');
  });
});
