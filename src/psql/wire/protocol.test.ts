/**
 * Tests for the wire-protocol message codec (WP-02).
 *
 * Strategy:
 *
 *   - Encoders: build each frontend message and check byte-by-byte against
 *     the layout in the Postgres docs (§52 / §53). We don't read these back
 *     through the parser — that would let an encoder + parser pair agree on
 *     a *wrong* layout while the test still passes.
 *
 *   - Parser: feed pre-built byte fixtures and assert the emitted message
 *     stream. Streaming behaviour is exercised by feeding one byte at a
 *     time and checking that the parser only emits when it has a complete
 *     message.
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
  ProtocolError,
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
// Backend message builders for parser fixtures
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
// Frontend encoders
// ---------------------------------------------------------------------------

describe('frontend encoders', () => {
  test('StartupMessage v3 with user + database', () => {
    const buf = StartupMessage({ user: 'alice', database: 'db' });
    // Layout: Int32 length, Int32 196608, "user\0alice\0database\0db\0", 0x00
    const expected = Buffer.concat([
      Buffer.alloc(4), // length placeholder
      Buffer.from([0, 3, 0, 0]), // protocol version 196608 = 0x00030000
      cstring('user'),
      cstring('alice'),
      cstring('database'),
      cstring('db'),
      Buffer.from([0]), // terminator
    ]);
    expected.writeInt32BE(expected.length, 0);
    expect(buf.equals(expected)).toBe(true);
  });

  test('SSLRequest is the 8-byte magic', () => {
    expect(SSLRequest().toString('hex')).toBe('0000000804d2162f');
  });

  test('CancelRequest carries processId and secretKey', () => {
    const buf = CancelRequest(0x11223344, 0x55667788);
    expect(buf.length).toBe(16);
    expect(buf.readInt32BE(0)).toBe(16);
    expect(buf.readInt32BE(4)).toBe(80877102);
    expect(buf.readInt32BE(8)).toBe(0x11223344);
    expect(buf.readInt32BE(12)).toBe(0x55667788);
  });

  test('Query frames as Q + len + cstring', () => {
    const buf = Query('SELECT 1');
    expect(String.fromCharCode(buf[0])).toBe('Q');
    expect(buf.readInt32BE(1)).toBe(4 + 'SELECT 1'.length + 1);
    expect(buf.subarray(5, 5 + 8).toString()).toBe('SELECT 1');
    expect(buf[buf.length - 1]).toBe(0);
  });

  test('Terminate / Sync / Flush are bare 5-byte messages', () => {
    expect(Terminate().toString('hex')).toBe('5800000004');
    expect(Sync().toString('hex')).toBe('5300000004');
    expect(Flush().toString('hex')).toBe('4800000004');
  });

  test('PasswordMessage uses tag p + cstring', () => {
    const buf = PasswordMessage('s3cret');
    expect(String.fromCharCode(buf[0])).toBe('p');
    expect(buf.readInt32BE(1)).toBe(4 + 6 + 1);
    expect(buf.subarray(5, 11).toString()).toBe('s3cret');
    expect(buf[buf.length - 1]).toBe(0);
  });

  test('SASLInitialResponse contains mechanism cstring and length-prefixed body', () => {
    const body = Buffer.from('n,,n=,r=abc', 'utf8');
    const buf = SASLInitialResponse('SCRAM-SHA-256', body);
    expect(String.fromCharCode(buf[0])).toBe('p');
    // Layout: 'p' Int32 len cstring(mech) Int32 bodyLen body
    let off = 5;
    expect(buf.subarray(off, off + 13).toString()).toBe('SCRAM-SHA-256');
    off += 13;
    expect(buf[off]).toBe(0);
    off += 1;
    expect(buf.readInt32BE(off)).toBe(body.length);
    off += 4;
    expect(buf.subarray(off).equals(body)).toBe(true);
  });

  test('SASLResponse is tag p + body (no mechanism)', () => {
    const body = Buffer.from('c=biws,r=abc,p=xxx', 'utf8');
    const buf = SASLResponse(body);
    expect(String.fromCharCode(buf[0])).toBe('p');
    expect(buf.readInt32BE(1)).toBe(4 + body.length);
    expect(buf.subarray(5).equals(body)).toBe(true);
  });

  test('Parse encodes name, sql, and param OIDs', () => {
    const buf = Parse('stmt1', 'SELECT $1', [23]);
    expect(String.fromCharCode(buf[0])).toBe('P');
    let off = 5;
    expect(buf.subarray(off, off + 5).toString()).toBe('stmt1');
    off += 5;
    expect(buf[off++]).toBe(0);
    expect(buf.subarray(off, off + 9).toString()).toBe('SELECT $1');
    off += 9;
    expect(buf[off++]).toBe(0);
    expect(buf.readUInt16BE(off)).toBe(1);
    off += 2;
    expect(buf.readUInt32BE(off)).toBe(23);
  });

  test('Bind handles null parameters', () => {
    const buf = Bind('', 'stmt1', [0], [null, Buffer.from('hi')], [0]);
    expect(String.fromCharCode(buf[0])).toBe('B');
    let off = 5;
    expect(buf[off++]).toBe(0); // empty portal cstring
    expect(buf.subarray(off, off + 5).toString()).toBe('stmt1');
    off += 5;
    expect(buf[off++]).toBe(0);
    expect(buf.readUInt16BE(off)).toBe(1);
    off += 2;
    expect(buf.readUInt16BE(off)).toBe(0); // text format
    off += 2;
    expect(buf.readUInt16BE(off)).toBe(2);
    off += 2;
    // first param is null → -1
    expect(buf.readInt32BE(off)).toBe(-1);
    off += 4;
    // second param "hi"
    expect(buf.readInt32BE(off)).toBe(2);
    off += 4;
    expect(buf.subarray(off, off + 2).toString()).toBe('hi');
    off += 2;
    expect(buf.readUInt16BE(off)).toBe(1); // result formats count
    off += 2;
    expect(buf.readUInt16BE(off)).toBe(0); // result format text
  });

  test('Describe/Execute/Close use the target byte and name cstring', () => {
    const d = Describe('S', 'stmt1');
    expect(String.fromCharCode(d[0])).toBe('D');
    expect(String.fromCharCode(d[5])).toBe('S');
    expect(d.subarray(6, 11).toString()).toBe('stmt1');
    expect(d[d.length - 1]).toBe(0);

    const e = Execute('p1', 100);
    expect(String.fromCharCode(e[0])).toBe('E');
    expect(e.subarray(5, 7).toString()).toBe('p1');
    expect(e[7]).toBe(0);
    expect(e.readInt32BE(8)).toBe(100);

    const c = Close('P', 'p2');
    expect(String.fromCharCode(c[0])).toBe('C');
    expect(String.fromCharCode(c[5])).toBe('P');
    expect(c.subarray(6, 8).toString()).toBe('p2');
  });

  test('Copy framing', () => {
    const cd = CopyData(Buffer.from([1, 2, 3]));
    expect(String.fromCharCode(cd[0])).toBe('d');
    expect(cd.readInt32BE(1)).toBe(4 + 3);
    expect(cd.subarray(5).toString('hex')).toBe('010203');

    expect(CopyDone().toString('hex')).toBe('6300000004');

    const cf = CopyFail('boom');
    expect(String.fromCharCode(cf[0])).toBe('f');
    expect(cf.subarray(5, 9).toString()).toBe('boom');
    expect(cf[cf.length - 1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Backend parser
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
    // RowDescription: one column "?column?" of int4 (oid 23), text format.
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
      Buffer.from([0, 0, 0, 1]), // len 1
      Buffer.from('1'),
    ]);
    const row2 = Buffer.concat([
      Buffer.from([0, 1]),
      Buffer.from([0, 0, 0, 0, -1].slice(0, 4)), // len -1 (null)
    ]);
    // The above slice produced [0,0,0,0] (-1 wrapped). Fix:
    const nullVal = Buffer.alloc(4);
    nullVal.writeInt32BE(-1, 0);
    const row2Fixed = Buffer.concat([Buffer.from([0, 1]), nullVal]);

    const cycle = Buffer.concat([
      backendMessage('T', colDesc),
      backendMessage('D', row1),
      backendMessage('D', row2Fixed),
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

    const d1 = out[1];
    if (d1.type !== 'DataRow') throw new Error('expected DataRow');
    expect(d1.values).toHaveLength(1);
    expect(d1.values[0]?.toString()).toBe('1');

    const d2 = out[2];
    if (d2.type !== 'DataRow') throw new Error('expected DataRow');
    expect(d2.values[0]).toBeNull();

    expect(out[3]).toEqual({ type: 'CommandComplete', tag: 'SELECT 2' });
    expect(out[4]).toEqual({ type: 'ReadyForQuery', status: 'I' });
    // We've drained two unused refs; suppress unused-var noise.
    void row2;
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

  test('rejects declared length < 4', () => {
    const bad = Buffer.from([0x5a, 0, 0, 0, 0]); // 'Z' with length 0
    const p = new MessageParser();
    expect(() => p.feed(bad)).toThrow(ProtocolError);
  });
});
