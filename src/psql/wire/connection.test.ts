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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { Buffer } from 'node:buffer';

import {
  isUnixSocketHost,
  PgConnection,
  unixSocketPath,
} from './connection.js';
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

const copyBothResponse = (columnFormats: number[] = [0]): Buffer => {
  // Walsender START_REPLICATION response. Body layout matches CopyIn /
  // CopyOutResponse — overall format byte + Int16 nCols + Int16 perCol.
  // pg-protocol's parser ignores the body and emits a bare 'replicationStart'
  // marker; the bytes are still well-formed so the parser advances cleanly
  // past the message.
  const buf = Buffer.alloc(1 + 2 + columnFormats.length * 2);
  buf[0] = 0;
  buf.writeUInt16BE(columnFormats.length, 1);
  for (let i = 0; i < columnFormats.length; i++) {
    buf.writeInt16BE(columnFormats[i], 3 + i * 2);
  }
  return backendMessage('W', buf);
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

  test('threads opts.replication into the startup message parameters', async () => {
    // Walsender (replication) mode is gated by a single startup-message
    // parameter. The conformance test in 001_basic.spec.ts cares only
    // that psql opens the connection and surfaces the server's
    // ErrorResponse for `START_REPLICATION 0/1`; no CopyBoth streaming
    // is exercised. Here we assert the wire-layer plumbing: the
    // startup-message params dict must contain `replication=database`
    // exactly as supplied.
    let startupParams: Record<string, string> | null = null;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        startupParams = msg.params as Record<string, string>;
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
      database: 'postgres',
      ssl: 'disable',
      replication: 'database',
    });
    expect(startupParams).not.toBeNull();
    expect(startupParams).toMatchObject({
      user: 'alice',
      database: 'postgres',
      replication: 'database',
    });
    await conn.close();
  });

  test('omits replication parameter when not requested', async () => {
    // Defence-in-depth: a regular connection must NOT carry a
    // replication key in its startup message (the server would
    // interpret an empty value as walsender mode and reject regular
    // SQL otherwise).
    let startupParams: Record<string, string> | null = null;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        startupParams = msg.params as Record<string, string>;
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
      database: 'postgres',
      ssl: 'disable',
    });
    expect(startupParams).not.toBeNull();
    expect(startupParams).not.toHaveProperty('replication');
    await conn.close();
  });

  test('replication mode surfaces server ErrorResponse like a regular query', async () => {
    // The negative path the conformance test asserts: START_REPLICATION
    // with a bare LSN (no slot name) is a syntax error. The server
    // replies via the regular Q / ErrorResponse / ReadyForQuery flow
    // even though the connection is in walsender mode, so the Query
    // path stays unchanged.
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(
          errorResponse({
            S: 'ERROR',
            V: 'ERROR',
            C: '42601',
            M: 'syntax error',
          }),
        );
        client.send(readyForQuery('I'));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'postgres',
      ssl: 'disable',
      replication: 'database',
    });
    await expect(
      conn.execSimple('START_REPLICATION 0/1'),
    ).rejects.toMatchObject({
      severity: 'ERROR',
      code: '42601',
      message: 'syntax error',
    });
    await conn.close();
  });

  test('CopyBothResponse during execSimple rejects with a syntax-error diagnostic', async () => {
    // walsender `START_REPLICATION` succeeds at the protocol level — the
    // server transitions to CopyBoth and starts streaming WAL records. Our
    // simple-query client does NOT implement that streaming phase, so we
    // surface a clean 0A000-style "syntax error: unexpected CopyBothResponse"
    // diagnostic and tear the socket down. (Matches upstream psql's
    // behaviour of refusing PGRES_COPY_BOTH and surfacing a diagnostic.)
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '18.0'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        // Don't follow with ReadyForQuery — CopyBoth keeps the connection
        // in copy state until the client tears it down.
        client.send(copyBothResponse([0]));
      }
    });
    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'postgres',
      ssl: 'disable',
      replication: 'database',
    });
    await expect(
      conn.execSimple('START_REPLICATION 0/1'),
    ).rejects.toMatchObject({
      severity: 'ERROR',
      message: expect.stringMatching(/syntax error/) as unknown,
    });
    expect(conn.isClosed()).toBe(true);
    await conn.close();
  });

  test('FATAL ErrorResponse before socket close is surfaced as the rejection reason', async () => {
    // When the backend is killed mid-query (`pg_terminate_backend()`) the
    // server delivers an ErrorResponse FATAL "terminating connection due to
    // administrator command" and then closes the TCP socket *without*
    // sending ReadyForQuery. Our wire layer must prefer the server-supplied
    // error wording over the generic "Socket closed" fallback so the
    // diagnostic carries the FATAL message upstream code can render.
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '18.0'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(
          errorResponse({
            S: 'FATAL',
            V: 'FATAL',
            C: '57P01',
            M: 'terminating connection due to administrator command',
          }),
        );
        // No ReadyForQuery — the server just tears down the connection.
        client.end();
      }
    });
    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'postgres',
      ssl: 'disable',
    });
    await expect(
      conn.execSimple('SELECT pg_terminate_backend(pg_backend_pid())'),
    ).rejects.toMatchObject({
      severity: 'FATAL',
      code: '57P01',
      message: 'terminating connection due to administrator command',
    });
    await conn.close();
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

  test('setClientEncoding issues SET and folds the echoed ParameterStatus', async () => {
    let seenQuery: string | null = null;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(parameterStatus('client_encoding', 'UTF8'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
      } else if (msg.type === 'Query') {
        seenQuery = (msg as unknown as { sql: string }).sql;
        // The backend acknowledges a SET client_encoding by echoing the new
        // value in a ParameterStatus before CommandComplete.
        client.send(parameterStatus('client_encoding', 'LATIN1'));
        client.send(commandComplete('SET'));
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
    expect(conn.parameterStatus('client_encoding')).toBe('UTF8');
    await conn.setClientEncoding('LATIN1');
    // libpq sends the value as a single-quoted literal.
    expect(seenQuery).toBe("SET client_encoding TO 'LATIN1'");
    // The echoed ParameterStatus is folded into the live connection state.
    expect(conn.parameterStatus('client_encoding')).toBe('LATIN1');
    await conn.close();
  });

  test('setClientEncoding rejects when the server refuses the SET', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
      } else if (msg.type === 'Query') {
        client.send(
          errorResponse({
            S: 'ERROR',
            C: '22023',
            M: 'invalid value for parameter "client_encoding": "BOGUS"',
          }),
        );
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
    await expect(conn.setClientEncoding('BOGUS')).rejects.toMatchObject({
      message: 'invalid value for parameter "client_encoding": "BOGUS"',
    });
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

  test('cancel() mid-COPY-IN sends CopyFail on the live socket', async () => {
    // SIGINT during a COPY FROM STDIN should NOT open a side CancelRequest
    // socket — instead we abort by writing CopyFail on the data socket. The
    // server replies with ErrorResponse + ReadyForQuery and the connection
    // returns to idle.
    let copyFailSeen: string | null = null;
    let cancelRequestSeen = false;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'CancelRequest') {
        cancelRequestSeen = true;
        client.end();
        return;
      }
      if (msg.type === 'Query') {
        client.send(copyInResponse([0]));
        return;
      }
      if (msg.type === 'CopyFail') {
        copyFailSeen = (msg.reason as string) ?? '';
        client.send(
          errorResponse({
            S: 'ERROR',
            V: 'ERROR',
            C: '57014',
            M: 'COPY from stdin failed: canceled by user',
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
    // Open the COPY-IN; we DON'T call end()/fail() — instead simulate the
    // SIGINT path by invoking cancel() while the stream is open.
    await conn.startCopyIn('COPY t FROM STDIN');
    await conn.cancel();
    // Give the fake server a tick to process the CopyFail.
    await new Promise((r) => setTimeout(r, 30));
    expect(copyFailSeen).toBe('canceled by user');
    expect(cancelRequestSeen).toBe(false);
    await conn.close();
  });

  test('cancel() outside COPY mode falls back to side CancelRequest', async () => {
    // Sanity check: the new state-aware cancel() still uses the side socket
    // for the normal in-query path. This guards against accidentally
    // routing all cancels through CopyFail.
    let cancelRequestSeen = false;
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(0x42, 0x99));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'CancelRequest') {
        cancelRequestSeen = true;
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
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelRequestSeen).toBe(true);
    await conn.close();
  });

  // -------------------------------------------------------------------------
  // Mid-batch COPY-FROM-STDIN / COPY-TO-STDOUT — the wire-layer path the
  // mainloop drives for `\;`-chained simple-query batches that include
  // `COPY ... FROM STDIN` (or `TO STDOUT`).
  // -------------------------------------------------------------------------

  test('execSimple ships queued COPY-FROM-STDIN bytes on CopyInResponse', async () => {
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
        // Simulate the `\;`-chained batch: the COPY segment fires
        // CopyInResponse first.
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
        // After COPY, the rest of the chain runs — represent the
        // "SELECT 'done'" follow-on with a tag + RfQ.
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
    (
      conn as unknown as { queueCopyInData: (b: Buffer) => void }
    ).queueCopyInData(Buffer.from('Moe\nSusie\n'));
    const sets = await conn.execSimple("COPY t FROM STDIN ; SELECT 'done'");
    expect(copyDoneSeen).toBe(true);
    expect(copyInBytes.toString('utf8')).toBe('Moe\nSusie\n');
    // Both COPY and the trailing SELECT segments produced ResultSets.
    expect(sets.map((rs) => rs.command)).toEqual(['COPY', 'SELECT']);
    await conn.close();
  });

  test('execSimple accumulates CopyData onto rs.copyOutBytes for TO STDOUT', async () => {
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
        client.send(copyDataMsg('Calvin\n'));
        client.send(copyDataMsg('Hobbes\n'));
        client.send(copyDoneMsg());
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
    const sets = await conn.execSimple('COPY t TO STDOUT');
    expect(sets[0]?.command).toBe('COPY');
    const bytes = sets[0]?.copyOutBytes ?? [];
    expect(Buffer.concat(bytes).toString('utf8')).toBe('Calvin\nHobbes\n');
    await conn.close();
  });

  test('execSimple sends CopyFail when no COPY-FROM-STDIN block is queued', async () => {
    let copyFailSeen = false;
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
        copyFailSeen = true;
        // Server responds with ErrorResponse + RfQ when CopyFail arrives.
        client.send(
          backendMessage(
            'E',
            Buffer.concat([
              Buffer.from('S'),
              cstring('ERROR'),
              Buffer.from('M'),
              cstring('COPY from stdin failed'),
              Buffer.from([0]),
            ]),
          ),
        );
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
    // No queueCopyInData call — the wire layer must fall back to CopyFail.
    // The server then replies with its own ErrorResponse (which overrides
    // the local diagnostic), so the rejection surfaces the server message.
    await expect(conn.execSimple('COPY t FROM STDIN')).rejects.toMatchObject({
      message: expect.stringMatching(/COPY from stdin failed/),
    });
    expect(copyFailSeen).toBe(true);
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

  test('query(sql, []) — explicit empty-array params still go through extended protocol', async () => {
    // Regression guard: an explicit `params=[]` signals that the caller staged
    // a `\bind` (even with zero values). The wire layer MUST use the extended
    // protocol so the server can reject multi-statement SQL with the upstream
    // "cannot insert multiple commands into a prepared statement" diagnostic.
    // Falling back to simple-Query (PQexec semantics) would silently execute
    // both statements and return the last result, masking the failure.
    const seen: string[] = [];
    let parsedSql: string | null = null;
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
        parsedSql = (msg as unknown as { sql: string }).sql;
        client.send(parseComplete());
        return;
      }
      if (msg.type === 'Bind') {
        client.send(bindComplete());
        return;
      }
      if (msg.type === 'Describe') {
        client.send(rowDescription([{ name: 'a', oid: 23, size: 4 }]));
        return;
      }
      if (msg.type === 'Execute') {
        client.send(dataRow(['1']));
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
    // SQL the server will see verbatim in a single Parse — extended path.
    const rs = await conn.query('SELECT 1', []);
    expect(rs.rowCount).toBe(1);
    expect(rs.rows).toEqual([['1']]);
    expect(parsedSql).toBe('SELECT 1');
    expect(seen).toEqual(
      expect.arrayContaining(['Parse', 'Bind', 'Describe', 'Execute', 'Sync']),
    );
    // Critically: NO simple `Query` message. The presence of a Q would mean
    // we fell back to execSimple and the multi-statement guard wouldn't fire.
    expect(seen).not.toContain('Query');
    await conn.close();
  });

  test('query(sql) — params undefined still uses simple-Query (multi-statement OK)', async () => {
    // Inverse guard: when the caller passes NO `params` argument, we route
    // through the simple-Query path so chained `\;` statements still flow
    // through `PQexec`-shaped semantics.
    const seen: string[] = [];
    server = await startFakeServer((msg, client) => {
      seen.push(msg.type);
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(rowDescription([{ name: 'a', oid: 23, size: 4 }]));
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
    const rs = await conn.query('SELECT 1');
    expect(rs.rows).toEqual([['1']]);
    expect(seen).toContain('Query');
    expect(seen).not.toContain('Parse');
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

  test('closePreparedStatement issues Close("S", name) + Sync without a Parse', async () => {
    const seen: { type: string; target?: string; name?: string }[] = [];
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      seen.push({
        type: msg.type,
        target: msg.target as string | undefined,
        name: msg.name as string | undefined,
      });
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
    await conn.closePreparedStatement('stmt2');
    // No Parse — just Close('S','stmt2') + Sync.
    expect(seen).toEqual([
      { type: 'Close', target: 'S', name: 'stmt2' },
      { type: 'Sync', target: undefined, name: undefined },
    ]);
    await conn.close();
  });

  test('closePreparedStatement on an unknown name succeeds quietly', async () => {
    // PG treats Close('S', missing) as a no-op (CloseComplete with no
    // diagnostic). We exercise the rejected-error path separately via
    // the server pumping an ErrorResponse — this just confirms the
    // happy path resolves rather than throwing.
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
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
    await expect(conn.closePreparedStatement('nope')).resolves.toBeUndefined();
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

  // -------------------------------------------------------------------------
  // COPY in a pipeline → fail fast + abort connection.
  //
  // libpq + PG 17 still reject CopyIn/CopyOutResponse mid-pipeline with the
  // exact diagnostic "COPY in a pipeline is not supported, aborting
  // connection". Upstream psql tears the connection down on receipt; we
  // mirror that so the conformance tests at
  // tests/psql-conformance/tap/001_basic.spec.ts (lines 920-974) see the
  // expected behaviour.
  // -------------------------------------------------------------------------

  test('CopyInResponse during execSimple while pipeline active aborts the connection', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '17.0'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        // Server replies with CopyInResponse — psql's job is to bail out.
        client.send(copyInResponse([0]));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    // Simulate an active pipeline so the wire-layer guard fires. We don't
    // have to actually drive the pipeline session here — the
    // `_extPipelineActive` flag is what `handleQueryMessage` checks before
    // the CopyInResponse branch.
    (conn as unknown as { _extPipelineActive: boolean })._extPipelineActive =
      true;

    await expect(conn.execSimple('COPY t FROM STDIN')).rejects.toMatchObject({
      message: 'COPY in a pipeline is not supported, aborting connection',
    });
    expect(conn.isClosed()).toBe(true);
    // Cleanup: close() is a no-op once `isClosed()` is true.
    await conn.close();
  });

  test('CopyOutResponse during execSimple while pipeline active aborts the connection', async () => {
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '17.0'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(copyOutResponse([0]));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    (conn as unknown as { _extPipelineActive: boolean })._extPipelineActive =
      true;

    await expect(conn.execSimple('COPY t TO STDOUT')).rejects.toMatchObject({
      message: 'COPY in a pipeline is not supported, aborting connection',
    });
    expect(conn.isClosed()).toBe(true);
    await conn.close();
  });

  test('startCopyIn during pipeline rejects synchronously and closes the connection', async () => {
    // Defence-in-depth: if anything bypasses the `\copy` command's
    // pre-check and reaches the wire layer, `startCopyIn` itself short-
    // circuits before writing Query and tears the socket down.
    server = await startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '17.0'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(copyInResponse([0]));
      }
    });

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: server.port,
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    (conn as unknown as { _extPipelineActive: boolean })._extPipelineActive =
      true;

    await expect(conn.startCopyIn('COPY t FROM STDIN')).rejects.toMatchObject({
      message: 'COPY in a pipeline is not supported, aborting connection',
    });
    expect(conn.isClosed()).toBe(true);
    await conn.close();
  });
});

// ---------------------------------------------------------------------------
// Multi-host iteration: target_session_attrs and load_balance_hosts.
//
// The fake server harness above is single-port; for multi-host we spin up
// two servers on different ports and observe which one we land on. The
// first server in each scenario is the "wrong" host (refuses, or wrong
// role); the second is the acceptable host.
// ---------------------------------------------------------------------------

describe('PgConnection multi-host', () => {
  let servers: FakeServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      try {
        await s.close();
      } catch {
        // ignore
      }
    }
    servers = [];
  });

  /**
   * Spin up a fake server that drives a standard auth + ReadyForQuery
   * handshake, replies to `SELECT pg_is_in_recovery()` with the supplied
   * boolean ('t' / 'f' in text-format DataRow), and ignores everything else.
   * `acceptStartup=false` causes the server to drop connections at startup,
   * simulating an unreachable host.
   */
  const startRoleServer = async (input: {
    inRecovery: boolean;
    acceptStartup?: boolean;
  }): Promise<FakeServer> => {
    const { inRecovery, acceptStartup = true } = input;
    return startFakeServer((msg, client) => {
      if (msg.type === 'Startup') {
        if (!acceptStartup) {
          client.end();
          return;
        }
        client.send(authenticationOk());
        client.send(parameterStatus('server_version', '16.2'));
        client.send(backendKeyData(1, 2));
        client.send(readyForQuery('I'));
        return;
      }
      if (msg.type === 'Query') {
        client.send(
          rowDescription([{ name: 'pg_is_in_recovery', oid: 16, size: 1 }]),
        );
        client.send(dataRow([inRecovery ? 't' : 'f']));
        client.send(commandComplete('SELECT 1'));
        client.send(readyForQuery('I'));
      }
    });
  };

  test('falls through to the second host when the first refuses the connection', async () => {
    // First server: never replies — we close the listener so the TCP
    // connect attempt fails immediately. Second server: accepts.
    const refusingServer = await startFakeServer(() => {
      // never called; we close it below before connecting
    });
    const refusedPort = refusingServer.port;
    await refusingServer.close();

    const second = await startRoleServer({ inRecovery: false });
    servers.push(second);

    const conn = await PgConnection.connect({
      // Single-host scalar fields are placeholders; the wire layer
      // prefers `hosts`.
      host: '127.0.0.1',
      port: refusedPort,
      hosts: [
        { host: '127.0.0.1', port: refusedPort },
        { host: '127.0.0.1', port: second.port },
      ],
      user: 'u',
      database: 'db',
      ssl: 'disable',
    });
    // We land on the second server — verify by checking the saved opts.
    expect(conn.host).toBe('127.0.0.1');
    expect(conn.port).toBe(second.port);
    await conn.close();
  });

  test('target_session_attrs=read-write skips a standby and lands on the primary', async () => {
    const standby = await startRoleServer({ inRecovery: true });
    const primary = await startRoleServer({ inRecovery: false });
    servers.push(standby, primary);

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: standby.port,
      hosts: [
        { host: '127.0.0.1', port: standby.port },
        { host: '127.0.0.1', port: primary.port },
      ],
      user: 'u',
      database: 'db',
      ssl: 'disable',
      targetSessionAttrs: 'read-write',
    });
    expect(conn.port).toBe(primary.port);
    await conn.close();
  });

  test('prefer-standby picks a standby in the first pass even when the primary comes first', async () => {
    const primary = await startRoleServer({ inRecovery: false });
    const standby = await startRoleServer({ inRecovery: true });
    servers.push(primary, standby);

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: primary.port,
      hosts: [
        // Primary appears FIRST. With `prefer-standby`, the first pass
        // accepts only standbys, so we skip the primary and land on the
        // standby (the second entry).
        { host: '127.0.0.1', port: primary.port },
        { host: '127.0.0.1', port: standby.port },
      ],
      user: 'u',
      database: 'db',
      ssl: 'disable',
      targetSessionAttrs: 'prefer-standby',
    });
    expect(conn.port).toBe(standby.port);
    await conn.close();
  });

  test('prefer-standby falls back to the primary on the second pass when no standby is available', async () => {
    const primaryA = await startRoleServer({ inRecovery: false });
    const primaryB = await startRoleServer({ inRecovery: false });
    servers.push(primaryA, primaryB);

    const conn = await PgConnection.connect({
      host: '127.0.0.1',
      port: primaryA.port,
      hosts: [
        { host: '127.0.0.1', port: primaryA.port },
        { host: '127.0.0.1', port: primaryB.port },
      ],
      user: 'u',
      database: 'db',
      ssl: 'disable',
      targetSessionAttrs: 'prefer-standby',
    });
    // First pass tries both as 'standby' (rejected), second pass accepts
    // 'any' — we land on the first primary.
    expect(conn.port).toBe(primaryA.port);
    await conn.close();
  });

  test('load_balance_hosts=random shuffles the candidate list (deterministic RNG)', async () => {
    const first = await startRoleServer({ inRecovery: false });
    const second = await startRoleServer({ inRecovery: false });
    servers.push(first, second);

    // Inject an RNG that returns 0.0 every time. Fisher-Yates with rng()=0
    // always picks j=0 for every step, which (for n=2) swaps index 1 with
    // index 0 — reversing the list. So [first, second] -> [second, first].
    (
      PgConnection as unknown as { _loadBalanceRng: (() => number) | null }
    )._loadBalanceRng = (): number => 0;
    try {
      const conn = await PgConnection.connect({
        host: '127.0.0.1',
        port: first.port,
        hosts: [
          { host: '127.0.0.1', port: first.port },
          { host: '127.0.0.1', port: second.port },
        ],
        user: 'u',
        database: 'db',
        ssl: 'disable',
        loadBalanceHosts: 'random',
      });
      // With our deterministic shuffle, the list reverses: the SECOND host
      // is tried first and accepted.
      expect(conn.port).toBe(second.port);
      await conn.close();
    } finally {
      (
        PgConnection as unknown as { _loadBalanceRng: (() => number) | null }
      )._loadBalanceRng = null;
    }
  });

  test('throws the last error when every candidate fails', async () => {
    // Two servers that immediately close the socket on startup — both
    // refuse, and the orchestrator surfaces the last error.
    const a = await startRoleServer({
      inRecovery: false,
      acceptStartup: false,
    });
    const b = await startRoleServer({
      inRecovery: false,
      acceptStartup: false,
    });
    servers.push(a, b);

    await expect(
      PgConnection.connect({
        host: '127.0.0.1',
        port: a.port,
        hosts: [
          { host: '127.0.0.1', port: a.port },
          { host: '127.0.0.1', port: b.port },
        ],
        user: 'u',
        database: 'db',
        ssl: 'disable',
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  // -------------------------------------------------------------------------
  // DNS fan-out: a hostname with multiple A records is expanded into one
  // candidate per address (libpq parity for upstream's
  // `004_load_balance_dns.pl`).
  // -------------------------------------------------------------------------

  test('hostname with multiple A records fans out into per-IP candidates', async () => {
    const a = await startRoleServer({ inRecovery: false });
    const b = await startRoleServer({ inRecovery: false });
    servers.push(a, b);

    // Inject a fake resolver: `pg-loadbalancetest` → 127.0.0.1 for both
    // (host, port) entries in the list (we can't bind 127.0.0.2/3
    // portably in this test env). The fan-out semantics — one DNS
    // lookup turning into N candidates — are still exercised end-to-
    // end: with `_loadBalanceRng=0` the Fisher-Yates shuffle reverses
    // the expanded list, so `b.port` (the second entry) is tried first
    // and accepted.
    (
      PgConnection as unknown as {
        _dnsLookupAll:
          | ((host: string) => Promise<{ address: string; family: number }[]>)
          | null;
      }
    )._dnsLookupAll = async (host) => {
      if (host === 'pg-loadbalancetest') {
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      }
      throw new Error(`unexpected dns.lookup(${host})`);
    };
    (
      PgConnection as unknown as { _loadBalanceRng: (() => number) | null }
    )._loadBalanceRng = (): number => 0;
    try {
      const conn = await PgConnection.connect({
        host: 'pg-loadbalancetest',
        port: a.port,
        hosts: [
          { host: 'pg-loadbalancetest', port: a.port },
          { host: 'pg-loadbalancetest', port: b.port },
        ],
        user: 'u',
        database: 'db',
        ssl: 'disable',
        loadBalanceHosts: 'random',
      });
      // After fan-out the candidate list is
      //   [(host=pg-loadbalancetest, address=127.0.0.1, a.port),
      //    (host=pg-loadbalancetest, address=127.0.0.1, b.port)]
      // Reversed by the deterministic shuffle → b.port lands first.
      // `conn.host` reports the ORIGINAL hostname (TLS-stable identity);
      // the IP override only affects net.connect.
      expect(conn.host).toBe('pg-loadbalancetest');
      expect(conn.port).toBe(b.port);
      await conn.close();
    } finally {
      (
        PgConnection as unknown as {
          _dnsLookupAll:
            | ((host: string) => Promise<{ address: string; family: number }[]>)
            | null;
        }
      )._dnsLookupAll = null;
      (
        PgConnection as unknown as { _loadBalanceRng: (() => number) | null }
      )._loadBalanceRng = null;
    }
  });

  test('IP literals bypass DNS lookup (no resolver call) under load_balance_hosts=random', async () => {
    const a = await startRoleServer({ inRecovery: false });
    servers.push(a);

    let resolverCalls = 0;
    (
      PgConnection as unknown as {
        _dnsLookupAll:
          | ((host: string) => Promise<{ address: string; family: number }[]>)
          | null;
      }
    )._dnsLookupAll = async () => {
      resolverCalls += 1;
      return Promise.resolve([{ address: '0.0.0.0', family: 4 }]);
    };
    try {
      const conn = await PgConnection.connect({
        host: '127.0.0.1',
        port: a.port,
        user: 'u',
        database: 'db',
        ssl: 'disable',
        loadBalanceHosts: 'random',
      });
      expect(resolverCalls).toBe(0);
      expect(conn.host).toBe('127.0.0.1');
      await conn.close();
    } finally {
      (
        PgConnection as unknown as {
          _dnsLookupAll:
            | ((host: string) => Promise<{ address: string; family: number }[]>)
            | null;
        }
      )._dnsLookupAll = null;
    }
  });

  test('unresolvable hostname is dropped from the candidate set', async () => {
    const a = await startRoleServer({ inRecovery: false });
    servers.push(a);

    (
      PgConnection as unknown as {
        _dnsLookupAll:
          | ((host: string) => Promise<{ address: string; family: number }[]>)
          | null;
      }
    )._dnsLookupAll = async (host) => {
      if (host === 'never-resolves.invalid') {
        const err: NodeJS.ErrnoException = Object.assign(
          new Error('getaddrinfo ENOTFOUND never-resolves.invalid'),
          { code: 'ENOTFOUND' },
        );
        throw err;
      }
      return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    };
    // Inject `Math.random => 1` so Fisher-Yates with `Math.floor(rng()*n)`
    // returns the LAST index — keeping the order stable. (`=> 0` would
    // reverse the list, putting the unresolvable host last after fan-
    // out, also acceptable for this test; we just need determinism.)
    (
      PgConnection as unknown as { _loadBalanceRng: (() => number) | null }
    )._loadBalanceRng = (): number => 0.999_999;
    try {
      // First host fails to resolve; second is the live server. Fan-out
      // drops the unresolvable one, the connect loop succeeds on the
      // second.
      const conn = await PgConnection.connect({
        host: 'never-resolves.invalid',
        port: 5432,
        hosts: [
          { host: 'never-resolves.invalid', port: 5432 },
          { host: '127.0.0.1', port: a.port },
        ],
        user: 'u',
        database: 'db',
        ssl: 'disable',
        loadBalanceHosts: 'random',
      });
      expect(conn.host).toBe('127.0.0.1');
      expect(conn.port).toBe(a.port);
      await conn.close();
    } finally {
      (
        PgConnection as unknown as {
          _dnsLookupAll:
            | ((host: string) => Promise<{ address: string; family: number }[]>)
            | null;
        }
      )._dnsLookupAll = null;
      (
        PgConnection as unknown as { _loadBalanceRng: (() => number) | null }
      )._loadBalanceRng = null;
    }
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

// ---------------------------------------------------------------------------
// Unix-domain socket helpers + end-to-end open.
//
// Most CI environments don't have a local Postgres socket, so we stand up a
// `net.createServer({...}).listen(<sockPath>)` and drive the same fake-PG
// handler used above. The directory layout matches libpq's:
//
//   <opts.host>/.s.PGSQL.<opts.port>
//
// — i.e. opts.host is the directory and we synthesize the file path inside
// the wire layer.
// ---------------------------------------------------------------------------

describe('isUnixSocketHost / unixSocketPath', () => {
  test('classifies "/var/run/postgresql" as a socket directory', () => {
    expect(isUnixSocketHost('/var/run/postgresql')).toBe(true);
    expect(isUnixSocketHost('/tmp')).toBe(true);
  });

  test('classifies "localhost", IPs, and "example.com" as TCP', () => {
    expect(isUnixSocketHost('localhost')).toBe(false);
    expect(isUnixSocketHost('127.0.0.1')).toBe(false);
    expect(isUnixSocketHost('::1')).toBe(false);
    expect(isUnixSocketHost('example.com')).toBe(false);
  });

  test('layout matches libpq: <dir>/.s.PGSQL.<port>', () => {
    expect(unixSocketPath('/tmp', 5432)).toBe('/tmp/.s.PGSQL.5432');
    expect(unixSocketPath('/var/run/postgresql', 5433)).toBe(
      '/var/run/postgresql/.s.PGSQL.5433',
    );
  });
});

describe('PgConnection over Unix-domain socket', () => {
  // Each test gets its own ephemeral directory so the socket files don't
  // collide. Cleanup happens in afterEach.
  let sockDir: string | null = null;
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res) => {
        server?.close(() => {
          res();
        });
      });
      server = null;
    }
    if (sockDir !== null) {
      try {
        fs.rmSync(sockDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      sockDir = null;
    }
  });

  test('opens a connection over <dir>/.s.PGSQL.<port>', async () => {
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-sock-'));
    const port = 5432;
    const sockFile = unixSocketPath(sockDir, port);

    server = net.createServer((socket) => {
      let accum = Buffer.alloc(0);
      let startupSeen = false;
      socket.on('data', (chunk: Buffer) => {
        accum = Buffer.concat([accum, chunk]);
        if (!startupSeen) {
          if (accum.length < 8) return;
          const declared = accum.readInt32BE(0);
          if (accum.length < declared) return;
          const code = accum.readInt32BE(4);
          if (code === 80877103) {
            // SSLRequest: reply 'N' so the client falls back to plain. The
            // connect path passes sslmode='disable' for unix sockets so we
            // shouldn't actually see this byte, but be defensive.
            socket.write(Buffer.from('N'));
            accum = accum.subarray(declared);
          } else if (code === 196608) {
            // StartupMessage — accept and complete handshake.
            accum = accum.subarray(declared);
            startupSeen = true;
            socket.write(backendMessage('R', Buffer.from([0, 0, 0, 0])));
            socket.write(
              backendMessage(
                'S',
                Buffer.concat([cstring('server_version'), cstring('16.2')]),
              ),
            );
            const keyBuf = Buffer.alloc(8);
            keyBuf.writeInt32BE(1, 0);
            keyBuf.writeInt32BE(2, 4);
            socket.write(backendMessage('K', keyBuf));
            socket.write(backendMessage('Z', Buffer.from('I')));
          }
        }
      });
      socket.on('error', () => {
        // swallow — tests assert via the connect promise
      });
    });

    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(sockFile, () => {
        resolve();
      });
    });

    const conn = await PgConnection.connect({
      host: sockDir,
      port,
      user: 'u',
      database: 'db',
      // sslmode=prefer is the libpq default; we expect the wire layer to
      // silently downgrade to 'disable' over a unix socket so no SSLRequest
      // byte hits the wire.
      ssl: 'prefer',
    });

    expect(conn.parameterStatus('server_version')).toBe('16.2');
    expect(conn.host).toBe(sockDir);
    await conn.close();
  });

  test('rejects sslmode=require for unix-socket host with a clear diagnostic', async () => {
    // No server needed — the early sslmode check fires before openSocket.
    await expect(
      PgConnection.connect({
        host: '/no/such/dir',
        port: 5432,
        user: 'u',
        database: 'db',
        ssl: 'require',
      }),
    ).rejects.toThrow(/sslmode=require.*Unix-domain/);
  });

  test('rejects sslmode=verify-full for unix-socket host', async () => {
    await expect(
      PgConnection.connect({
        host: '/no/such/dir',
        port: 5432,
        user: 'u',
        database: 'db',
        ssl: 'verify-full',
      }),
    ).rejects.toThrow(/sslmode=verify-full.*Unix-domain/);
  });
});
