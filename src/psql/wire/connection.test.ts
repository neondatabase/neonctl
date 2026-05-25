/**
 * `PgConnection` integration tests against an in-process fake Postgres.
 *
 * The fake server is a `net.createServer` that:
 *   - parses both unframed startup messages (SSLRequest / StartupMessage /
 *     CancelRequest) and framed frontend messages (Q, p, X, …),
 *   - drives a scripted response sequence supplied by each test.
 *
 * The fake covers three flows:
 *   1. Cleartext-password auth → AuthenticationOk → ready.
 *   2. SASL/SCRAM-SHA-256 auth (no channel binding).
 *   3. Simple-query exchange (including notice/notification + error paths).
 *
 * We deliberately *don't* exercise TLS here — the plain-TCP path keeps the
 * test self-contained and fast (no cert fixtures needed). TLS-specific
 * verification lives in `tls.test.ts`.
 */

import { afterEach, describe, expect, test } from 'vitest';
import * as net from 'node:net';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { PgConnection } from './connection.js';
import { CancelRequest } from './protocol.js';

// ---------------------------------------------------------------------------
// Fake server harness
// ---------------------------------------------------------------------------

type FrontendMessage = { type: string } & Record<string, unknown>;

type ServerClient = {
  send: (chunk: Buffer) => void;
  end: () => void;
};

type ServerHandler = (msg: FrontendMessage, client: ServerClient) => void;

type FakeServer = {
  port: number;
  close: () => Promise<void>;
};

function startFakeServer(handler: ServerHandler): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let accum = Buffer.alloc(0);
      let startupSeen = false;
      const client: ServerClient = {
        send: (chunk) => socket.write(chunk),
        end: () => socket.end(),
      };

      socket.on('data', (chunk: Buffer) => {
        accum = Buffer.concat([accum, chunk]);
        // Drain as many complete messages as we can.
        for (;;) {
          if (!startupSeen) {
            if (accum.length < 8) return;
            const declared = accum.readInt32BE(0);
            if (accum.length < declared) return;
            const code = accum.readInt32BE(4);
            if (code === 80877103) {
              // SSLRequest: reply 'N' so the client falls back to plain.
              socket.write(Buffer.from('N'));
              accum = accum.subarray(declared);
              continue;
            }
            if (code === 80877102) {
              const pid = accum.readInt32BE(8);
              const secret = accum.readInt32BE(12);
              accum = accum.subarray(declared);
              handler(
                { type: 'CancelRequest', processId: pid, secretKey: secret },
                client,
              );
              continue;
            }
            if (code === 196608) {
              const params = parseStartup(accum.subarray(0, declared));
              accum = accum.subarray(declared);
              startupSeen = true;
              handler({ type: 'Startup', params }, client);
              continue;
            }
            return; // unknown leading frame
          }
          if (accum.length < 5) return;
          const t = accum[0];
          const len = accum.readInt32BE(1);
          const total = 1 + len;
          if (accum.length < total) return;
          const body = accum.subarray(5, total);
          accum = accum.subarray(total);
          handler(decodeFrontend(t, body), client);
        }
      });

      socket.on('error', () => {
        // Tests assert through promises; swallow stray errors to keep the
        // test output clean.
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Could not resolve server address'));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Frontend decoding (just the messages our tests care about)
// ---------------------------------------------------------------------------

function parseStartup(buf: Buffer): Record<string, string> {
  const params: Record<string, string> = {};
  let off = 8;
  while (off < buf.length - 1) {
    const keyEnd = buf.indexOf(0, off);
    if (keyEnd < 0 || keyEnd === off) break;
    const key = buf.toString('utf8', off, keyEnd);
    off = keyEnd + 1;
    const valEnd = buf.indexOf(0, off);
    if (valEnd < 0) break;
    const val = buf.toString('utf8', off, valEnd);
    off = valEnd + 1;
    params[key] = val;
  }
  return params;
}

function decodeFrontend(type: number, body: Buffer): FrontendMessage {
  switch (String.fromCharCode(type)) {
    case 'Q': {
      const end = body.indexOf(0);
      return { type: 'Query', sql: body.toString('utf8', 0, end) };
    }
    case 'X':
      return { type: 'Terminate' };
    case 'P': {
      // Parse: cstring(name) cstring(sql) Int16 nparam {Int32 oid}*
      const nameEnd = body.indexOf(0);
      const name = body.toString('utf8', 0, nameEnd);
      const sqlEnd = body.indexOf(0, nameEnd + 1);
      const sql = body.toString('utf8', nameEnd + 1, sqlEnd);
      const nparam = body.readUInt16BE(sqlEnd + 1);
      const oids: number[] = [];
      for (let i = 0; i < nparam; i++) {
        oids.push(body.readUInt32BE(sqlEnd + 3 + i * 4));
      }
      return { type: 'Parse', name, sql, paramTypes: oids };
    }
    case 'B': {
      // Bind: cstring(portal) cstring(stmt) Int16 nFmt {Int16}* Int16 nVals
      //        {Int32 len, bytes|-1}* Int16 nResFmt {Int16}*
      const portalEnd = body.indexOf(0);
      const portal = body.toString('utf8', 0, portalEnd);
      const stmtEnd = body.indexOf(0, portalEnd + 1);
      const stmt = body.toString('utf8', portalEnd + 1, stmtEnd);
      let off = stmtEnd + 1;
      const nFmt = body.readUInt16BE(off);
      off += 2 + nFmt * 2;
      const nVals = body.readUInt16BE(off);
      off += 2;
      const values: (string | null)[] = [];
      for (let i = 0; i < nVals; i++) {
        const len = body.readInt32BE(off);
        off += 4;
        if (len === -1) {
          values.push(null);
        } else {
          values.push(body.toString('utf8', off, off + len));
          off += len;
        }
      }
      return { type: 'Bind', portal, stmt, values };
    }
    case 'D': {
      // Describe: byte(target) cstring(name)
      const target = String.fromCharCode(body[0]);
      const nameEnd = body.indexOf(0, 1);
      const name = body.toString('utf8', 1, nameEnd);
      return { type: 'Describe', target, name };
    }
    case 'E': {
      // Execute: cstring(portal) Int32 maxRows
      const nameEnd = body.indexOf(0);
      const portal = body.toString('utf8', 0, nameEnd);
      const maxRows = body.readInt32BE(nameEnd + 1);
      return { type: 'Execute', portal, maxRows };
    }
    case 'S':
      return { type: 'Sync' };
    case 'H':
      return { type: 'Flush' };
    case 'C': {
      // Close: byte(target) cstring(name)
      const target = String.fromCharCode(body[0]);
      const nameEnd = body.indexOf(0, 1);
      const name = body.toString('utf8', 1, nameEnd);
      return { type: 'Close', target, name };
    }
    case 'p': {
      // 'p' covers PasswordMessage, SASLInitialResponse, and SASLResponse.
      // Disambiguate by structure:
      //   SASLInitialResponse: cstring(mech) Int32 bodyLen bytes
      //   PasswordMessage:     cstring(password)   — ends with NUL
      //   SASLResponse:        opaque bytes        — typically no NUL at end
      const nul = body.indexOf(0);
      if (nul > 0 && body.length >= nul + 1 + 4) {
        const len = body.readInt32BE(nul + 1);
        if (len >= 0 && nul + 1 + 4 + len === body.length) {
          return {
            type: 'SASLInitial',
            mechanism: body.toString('utf8', 0, nul),
            body: body.subarray(nul + 5),
          };
        }
      }
      if (body[body.length - 1] === 0) {
        return {
          type: 'PasswordMessage',
          password: body.toString('utf8', 0, body.length - 1),
        };
      }
      return { type: 'SASLResponse', body };
    }
    case 'd':
      // CopyData: opaque bytes
      return { type: 'CopyData', data: Buffer.from(body) };
    case 'c':
      // CopyDone (no body)
      return { type: 'CopyDone' };
    case 'f': {
      // CopyFail: cstring(reason)
      const end = body.indexOf(0);
      return {
        type: 'CopyFail',
        reason: body.toString('utf8', 0, end >= 0 ? end : body.length),
      };
    }
    default:
      return { type: 'Unknown', byte: type, body };
  }
}

// ---------------------------------------------------------------------------
// Backend message builders
// ---------------------------------------------------------------------------

function backendMessage(typeChar: string, body: Buffer): Buffer {
  const buf = Buffer.alloc(1 + 4 + body.length);
  buf[0] = typeChar.charCodeAt(0);
  buf.writeInt32BE(4 + body.length, 1);
  body.copy(buf, 5);
  return buf;
}

function cstring(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

const authenticationOk = (): Buffer =>
  backendMessage('R', Buffer.from([0, 0, 0, 0]));

const authenticationCleartext = (): Buffer =>
  backendMessage('R', Buffer.from([0, 0, 0, 3]));

const authenticationSASL = (mechanisms: string[]): Buffer =>
  backendMessage(
    'R',
    Buffer.concat([
      Buffer.from([0, 0, 0, 10]),
      ...mechanisms.map(cstring),
      Buffer.from([0]),
    ]),
  );

const authenticationSASLContinue = (body: Buffer): Buffer =>
  backendMessage('R', Buffer.concat([Buffer.from([0, 0, 0, 11]), body]));

const authenticationSASLFinal = (body: Buffer): Buffer =>
  backendMessage('R', Buffer.concat([Buffer.from([0, 0, 0, 12]), body]));

const parameterStatus = (k: string, v: string): Buffer =>
  backendMessage('S', Buffer.concat([cstring(k), cstring(v)]));

const backendKeyData = (pid: number, secret: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeInt32BE(pid, 0);
  b.writeInt32BE(secret, 4);
  return backendMessage('K', b);
};

const readyForQuery = (status: 'I' | 'T' | 'E' = 'I'): Buffer =>
  backendMessage('Z', Buffer.from(status));

const rowDescription = (
  cols: { name: string; oid: number; size: number }[],
): Buffer => {
  const parts: Buffer[] = [Buffer.from([0, cols.length & 0xff])];
  for (const c of cols) {
    parts.push(cstring(c.name));
    parts.push(Buffer.alloc(4)); // tableID
    parts.push(Buffer.alloc(2)); // columnID
    const oid = Buffer.alloc(4);
    oid.writeInt32BE(c.oid, 0);
    parts.push(oid);
    const sz = Buffer.alloc(2);
    sz.writeInt16BE(c.size, 0);
    parts.push(sz);
    parts.push(Buffer.alloc(4)); // typmod
    parts.push(Buffer.from([0, 0])); // text format
  }
  return backendMessage('T', Buffer.concat(parts));
};

const dataRow = (values: (string | null)[]): Buffer => {
  const parts: Buffer[] = [Buffer.from([0, values.length & 0xff])];
  for (const v of values) {
    if (v === null) {
      const n = Buffer.alloc(4);
      n.writeInt32BE(-1, 0);
      parts.push(n);
    } else {
      const b = Buffer.from(v, 'utf8');
      const len = Buffer.alloc(4);
      len.writeInt32BE(b.length, 0);
      parts.push(len, b);
    }
  }
  return backendMessage('D', Buffer.concat(parts));
};

const commandComplete = (tag: string): Buffer =>
  backendMessage('C', cstring(tag));

const noticeResponse = (fields: Record<string, string>): Buffer => {
  const parts: Buffer[] = [];
  for (const [tag, val] of Object.entries(fields)) {
    parts.push(Buffer.from(tag));
    parts.push(cstring(val));
  }
  parts.push(Buffer.from([0]));
  return backendMessage('N', Buffer.concat(parts));
};

const notificationResponse = (
  pid: number,
  channel: string,
  payload: string,
): Buffer => {
  const head = Buffer.alloc(4);
  head.writeInt32BE(pid, 0);
  return backendMessage(
    'A',
    Buffer.concat([head, cstring(channel), cstring(payload)]),
  );
};

const errorResponse = (fields: Record<string, string>): Buffer => {
  const parts: Buffer[] = [];
  for (const [tag, val] of Object.entries(fields)) {
    parts.push(Buffer.from(tag));
    parts.push(cstring(val));
  }
  parts.push(Buffer.from([0]));
  return backendMessage('E', Buffer.concat(parts));
};

const parseComplete = (): Buffer => backendMessage('1', Buffer.alloc(0));
const bindComplete = (): Buffer => backendMessage('2', Buffer.alloc(0));
const closeComplete = (): Buffer => backendMessage('3', Buffer.alloc(0));
const parameterDescription = (oids: number[]): Buffer => {
  const buf = Buffer.alloc(2 + oids.length * 4);
  buf.writeUInt16BE(oids.length, 0);
  for (let i = 0; i < oids.length; i++) {
    buf.writeUInt32BE(oids[i], 2 + i * 4);
  }
  return backendMessage('t', buf);
};

// COPY message builders (WP-16).
const copyInResponse = (columnFormats: number[] = [0]): Buffer => {
  const buf = Buffer.alloc(1 + 2 + columnFormats.length * 2);
  buf[0] = 0; // overall text format
  buf.writeUInt16BE(columnFormats.length, 1);
  for (let i = 0; i < columnFormats.length; i++) {
    buf.writeInt16BE(columnFormats[i], 3 + i * 2);
  }
  return backendMessage('G', buf);
};

const copyOutResponse = (columnFormats: number[] = [0]): Buffer => {
  const buf = Buffer.alloc(1 + 2 + columnFormats.length * 2);
  buf[0] = 0; // overall text format
  buf.writeUInt16BE(columnFormats.length, 1);
  for (let i = 0; i < columnFormats.length; i++) {
    buf.writeInt16BE(columnFormats[i], 3 + i * 2);
  }
  return backendMessage('H', buf);
};

const copyDataMsg = (data: Buffer | string): Buffer => {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return backendMessage('d', buf);
};

const copyDoneMsg = (): Buffer => backendMessage('c', Buffer.alloc(0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PgConnection', () => {
  let server: FakeServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  test('connects with cleartext auth, captures ParameterStatus + key', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationCleartext());
        return;
      }
      if (msg.type === 'PasswordMessage') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(parameterStatus('TimeZone', 'UTC'));
        client.send(backendKeyData(0x42, 0x99));
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'alice',
      password: 's3cret',
      database: 'db',
      ssl: 'disable',
    });

    expect(conn.parameterStatus('server_version')).toBe('16.2');
    expect(conn.parameterStatus('TimeZone')).toBe('UTC');
    expect(conn.serverVersion).toBeGreaterThan(0);

    await conn.close();
  });

  test('retains the connect-time password on the password getter', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'alice',
      password: 's3cret',
      database: 'db',
      ssl: 'disable',
    });
    // The password getter must return exactly what was passed at connect so
    // `\c <newdb>` can reconnect without re-prompting (matches libpq's
    // behaviour of retaining the credential on the live `PGconn`).
    expect(conn.password).toBe('s3cret');
    await conn.close();
  });

  test('runs execSimple(SELECT 1) end-to-end', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
      } else if (msg.type === 'Query') {
        client.send(rowDescription([{ name: '?column?', oid: 23, size: 4 }]));
        client.send(dataRow(['1']));
        client.send(commandComplete('SELECT 1'));
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    const sets = await conn.execSimple('SELECT 1');
    expect(sets).toHaveLength(1);
    expect(sets[0].command).toBe('SELECT');
    expect(sets[0].rowCount).toBe(1);
    expect(sets[0].fields[0].name).toBe('?column?');
    expect(sets[0].rows).toEqual([['1']]);
    await conn.close();
  });

  test('SASL/SCRAM-SHA-256 happy path', async () => {
    const password = 'hunter2';
    const salt = Buffer.from('1234567890abcdef', 'hex');
    const iterations = 4096;
    const serverNonceSuffix = 'BBBBBBBBBBBBBBBBBBBB';

    let saslCtx: {
      clientFirstBare: string;
      serverFirst: string;
    } = { clientFirstBare: '', serverFirst: '' };

    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationSASL(['SCRAM-SHA-256']));
        return;
      }
      if (msg.type === 'SASLInitial') {
        const m = msg as unknown as { mechanism: string; body: Buffer };
        const cf = m.body.toString('utf8');
        const rIdx = cf.indexOf(',r=');
        const clientNonce = cf.substring(rIdx + 3);
        const nIdx = cf.indexOf('n=');
        const clientFirstBare = cf.substring(nIdx);
        const combinedNonce = clientNonce + serverNonceSuffix;
        const serverFirst = `r=${combinedNonce},s=${salt.toString('base64')},i=${String(iterations)}`;
        saslCtx = { clientFirstBare, serverFirst };
        client.send(authenticationSASLContinue(Buffer.from(serverFirst)));
        return;
      }
      if (msg.type === 'SASLResponse') {
        const m = msg as unknown as { body: Buffer };
        const cFinal = m.body.toString('utf8');
        const pIdx = cFinal.lastIndexOf(',p=');
        const clientFinalWithoutProof = cFinal.substring(0, pIdx);
        const authMessage = `${saslCtx.clientFirstBare},${saslCtx.serverFirst},${clientFinalWithoutProof}`;
        const saltedPassword = pbkdf2Sync(
          Buffer.from(password, 'utf8'),
          salt,
          iterations,
          32,
          'sha256',
        );
        const serverKey = createHmac('sha256', saltedPassword)
          .update('Server Key')
          .digest();
        const serverSignature = createHmac('sha256', serverKey)
          .update(authMessage)
          .digest();
        client.send(
          authenticationSASLFinal(
            Buffer.from(`v=${serverSignature.toString('base64')}`),
          ),
        );
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(7, 8));
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'alice',
      password,
      database: 'db',
      ssl: 'disable',
    });
    expect(conn.parameterStatus('server_version')).toBe('16.2');
    await conn.close();
  });

  test('NoticeResponse and NotificationResponse fire registered handlers', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
      } else if (msg.type === 'Query') {
        client.send(
          noticeResponse({
            S: 'NOTICE',
            V: 'NOTICE',
            M: 'a friendly notice',
            C: '00000',
          }),
        );
        client.send(notificationResponse(42, 'channel', 'payload'));
        client.send(commandComplete('DO'));
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });

    const notices: string[] = [];
    const notifications: { channel: string; payload: string; pid: number }[] =
      [];
    conn.onNotice((n) => notices.push(n.message));
    conn.onNotification((channel, payload, pid) =>
      notifications.push({ channel, payload, pid }),
    );

    await conn.execSimple('DO $$ BEGIN RAISE NOTICE %, 1; END $$');
    expect(notices).toContain('a friendly notice');
    expect(notifications).toEqual([
      { channel: 'channel', payload: 'payload', pid: 42 },
    ]);

    await conn.close();
  });

  test('ErrorResponse during query rejects the promise', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
      } else if (msg.type === 'Query') {
        client.send(
          errorResponse({
            S: 'ERROR',
            V: 'ERROR',
            C: '42601',
            M: 'syntax error',
          }),
        );
        client.send(readyForQuery('E'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    await expect(conn.execSimple('NOPE')).rejects.toMatchObject({
      severity: 'ERROR',
      code: '42601',
      message: 'syntax error',
    });
    await conn.close();
  });

  test('cancel() opens a side socket with the right body', async () => {
    let cancelSeen: { processId: number; secretKey: number } | null = null;
    const pid = 0xdeadbeef | 0;
    const secret = 0x12345678;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(pid, secret));
        client.send(readyForQuery('I'));
      } else if (msg.type === 'CancelRequest') {
        cancelSeen = {
          processId: msg.processId as number,
          secretKey: msg.secretKey as number,
        };
        client.end();
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    await conn.cancel();
    // Give the fake server time to surface its onData callback.
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelSeen).toEqual({ processId: pid, secretKey: secret });
    // Also confirm the CancelRequest body shape matches the encoder.
    expect(CancelRequest(pid, secret).length).toBe(16);
    await conn.close();
  });

  // -------------------------------------------------------------------------
  // COPY streaming (WP-16).
  // -------------------------------------------------------------------------

  test('startCopyIn round-trips CopyData chunks and reports tag', async () => {
    let copyInBytes: Buffer = Buffer.alloc(0);
    let copyDoneSeen = false;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(copyInResponse([0]));
        return;
      }
      if (msg.type === 'CopyData') {
        copyInBytes = Buffer.concat([copyInBytes, msg.data as Buffer]);
        return;
      }
      if (msg.type === 'CopyDone') {
        copyDoneSeen = true;
        client.send(commandComplete('COPY 2'));
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    const copyIn = await conn.startCopyIn('COPY t FROM STDIN WITH csv');
    await copyIn.write(Buffer.from('1,a\n'));
    await copyIn.write(Buffer.from('2,b\n'));
    await copyIn.end();

    // Give the fake server a tick to flush ReadyForQuery.
    await new Promise((r) => setTimeout(r, 10));
    expect(copyDoneSeen).toBe(true);
    expect(copyInBytes.toString('utf8')).toBe('1,a\n2,b\n');
    expect(
      (conn as unknown as { lastCopyTag: string | null }).lastCopyTag,
    ).toBe('COPY 2');
    await conn.close();
  });

  test('startCopyOut yields 3 CopyData chunks then completes', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(copyOutResponse([0]));
        client.send(copyDataMsg('alpha\n'));
        client.send(copyDataMsg('beta\n'));
        client.send(copyDataMsg('gamma\n'));
        client.send(copyDoneMsg());
        client.send(commandComplete('COPY 3'));
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    const stream = await conn.startCopyOut('COPY t TO STDOUT');
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk.toString('utf8'));
    }
    expect(chunks).toEqual(['alpha\n', 'beta\n', 'gamma\n']);
    expect(
      (conn as unknown as { lastCopyTag: string | null }).lastCopyTag,
    ).toBe('COPY 3');
    await conn.close();
  });

  test('startCopyIn → fail() surfaces server ErrorResponse', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(copyInResponse([0]));
        return;
      }
      if (msg.type === 'CopyFail') {
        client.send(
          errorResponse({
            S: 'ERROR',
            V: 'ERROR',
            C: '57014',
            M: 'COPY from stdin failed: client requested fail',
          }),
        );
        client.send(readyForQuery('E'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    const copyIn = await conn.startCopyIn('COPY t FROM STDIN');
    await expect(copyIn.fail('client requested fail')).rejects.toMatchObject({
      severity: 'ERROR',
      code: '57014',
    });
    await conn.close();
  });

  // -------------------------------------------------------------------------
  // Extended protocol (WP-21).
  // -------------------------------------------------------------------------

  test('query(sql, params) drives Parse/Bind/Describe/Execute/Sync', async () => {
    const seen: string[] = [];
    let bindValues: (string | null)[] | null = null;
    server = await startFakeServer((msg, client) => {
      seen.push(msg.type);
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Parse') {
        client.send(parseComplete());
        return;
      }
      if (msg.type === 'Bind') {
        bindValues = msg.values as (string | null)[];
        client.send(bindComplete());
        return;
      }
      if (msg.type === 'Describe') {
        client.send(rowDescription([{ name: 'greeting', oid: 25, size: -1 }]));
        return;
      }
      if (msg.type === 'Execute') {
        client.send(dataRow(['hello']));
        client.send(commandComplete('SELECT 1'));
        return;
      }
      if (msg.type === 'Sync') {
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    const rs = await conn.query('SELECT $1', ['hello']);
    expect(rs.command).toBe('SELECT');
    expect(rs.rowCount).toBe(1);
    expect(rs.fields[0].name).toBe('greeting');
    expect(rs.rows).toEqual([['hello']]);
    expect(bindValues).toEqual(['hello']);
    // Order: Startup, then P, B, D, E, S in any interleaving from the parser.
    expect(seen).toEqual(
      expect.arrayContaining(['Parse', 'Bind', 'Describe', 'Execute', 'Sync']),
    );
    await conn.close();
  });

  test('prepare() returns a usable PreparedStatement', async () => {
    let parseSeen: { name: string; sql: string; paramTypes: number[] } | null =
      null;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Parse') {
        parseSeen = msg as unknown as typeof parseSeen;
        client.send(parseComplete());
        return;
      }
      if (msg.type === 'Describe') {
        // Statement-target: ParameterDescription then RowDescription.
        client.send(parameterDescription([23]));
        client.send(rowDescription([{ name: 'col', oid: 23, size: 4 }]));
        return;
      }
      if (msg.type === 'Bind') {
        client.send(bindComplete());
        return;
      }
      if (msg.type === 'Execute') {
        client.send(dataRow(['42']));
        client.send(commandComplete('SELECT 1'));
        return;
      }
      if (msg.type === 'Close') {
        client.send(closeComplete());
        return;
      }
      if (msg.type === 'Sync') {
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    const stmt = await conn.prepare('s1', 'SELECT $1::int', [23]);
    expect(parseSeen).toMatchObject({
      name: 's1',
      sql: 'SELECT $1::int',
      paramTypes: [23],
    });
    expect(stmt.name).toBe('s1');
    expect(stmt.paramTypes).toEqual([23]);
    const fields = await stmt.describe();
    expect(fields[0].name).toBe('col');

    await stmt.bind(['42']);
    const rs = await stmt.execute();
    expect(rs.rows).toEqual([['42']]);
    await stmt.close();

    await conn.close();
  });

  test('pipeline() flushes 3 queries and returns ordered results', async () => {
    let parseCount = 0;
    let bindCount = 0;
    let execCount = 0;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Parse') {
        parseCount++;
        client.send(parseComplete());
        return;
      }
      if (msg.type === 'Bind') {
        bindCount++;
        client.send(bindComplete());
        return;
      }
      if (msg.type === 'Execute') {
        execCount++;
        client.send(rowDescription([{ name: 'n', oid: 23, size: 4 }]));
        client.send(dataRow([String(execCount)]));
        client.send(commandComplete('SELECT 1'));
        return;
      }
      if (msg.type === 'Sync') {
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    const pipe = conn.pipeline();
    await pipe.parse('', 'SELECT 1', []);
    await pipe.bind('', []);
    void pipe.execute('', 0);
    await pipe.parse('', 'SELECT 2', []);
    await pipe.bind('', []);
    void pipe.execute('', 0);
    await pipe.parse('', 'SELECT 3', []);
    await pipe.bind('', []);
    void pipe.execute('', 0);
    const results = await pipe.end();
    expect(parseCount).toBe(3);
    expect(bindCount).toBe(3);
    expect(execCount).toBe(3);
    expect(results).toHaveLength(3);
    expect(results[0].rows).toEqual([['1']]);
    expect(results[1].rows).toEqual([['2']]);
    expect(results[2].rows).toEqual([['3']]);
    await conn.close();
  });
});

// ---------------------------------------------------------------------------
// Identifier / literal escaping (no server required)
// ---------------------------------------------------------------------------

describe('PgConnection escaping (offline)', () => {
  // escapeIdentifier and escapeLiteral don't touch `this`; we exercise them
  // via a prototype-only stub so we don't need a real socket.
  const conn = Object.create(PgConnection.prototype) as PgConnection;

  test('escapeIdentifier doubles embedded quotes', () => {
    expect(conn.escapeIdentifier('simple')).toBe('"simple"');
    expect(conn.escapeIdentifier('weird"name')).toBe('"weird""name"');
  });

  test('escapeLiteral doubles single quotes', () => {
    expect(conn.escapeLiteral("o'brien")).toBe("'o''brien'");
  });

  test('escapeLiteral switches to E-string when backslashes present', () => {
    expect(conn.escapeLiteral('a\\b')).toBe("E'a\\\\b'");
    expect(conn.escapeLiteral("a'\\b")).toBe("E'a''\\\\b'");
  });
});
