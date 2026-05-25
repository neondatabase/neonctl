/**
 * TLS-negotiation tests.
 *
 * We don't spin up a real TLS handshake here — we drive `sendSslRequest`
 * against a `net.Socket` stub that responds with 'S' or 'N'. For the
 * channel-binding extraction we feed a synthetic peer cert through
 * `computeChannelBindingData` and check the SHA-256.
 *
 * Tests for the full `negotiateTls` happy-path (including `tls.connect`)
 * are deferred to the integration suite — they'd require either a self-
 * signed cert fixture (out of scope for a unit test) or the network access
 * we don't have.
 */

import { describe, expect, test } from 'vitest';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import type * as tls from 'node:tls';

import {
  computeChannelBindingData,
  negotiateTls,
  sendSslRequest,
} from './tls.js';

// ---------------------------------------------------------------------------
// Fake socket that emits a single response byte after seeing a write.
// Implements just enough of net.Socket for sendSslRequest.
// ---------------------------------------------------------------------------

type FakeOpts = {
  reply: 'S' | 'N' | Buffer;
  /** If set, emit a parser-error before the reply. */
  emitError?: Error;
};

class FakeSocket extends EventEmitter {
  public writes: Buffer[] = [];
  public unshifted: Buffer[] = [];

  public constructor(private readonly opts: FakeOpts) {
    super();
  }

  public write(chunk: Buffer): void {
    this.writes.push(chunk);
    // Defer the reply so the listener is fully wired.
    queueMicrotask(() => {
      if (this.opts.emitError) {
        this.emit('error', this.opts.emitError);
        return;
      }
      const reply = this.opts.reply;
      const buf = Buffer.isBuffer(reply) ? reply : Buffer.from(reply);
      this.emit('data', buf);
    });
  }

  public unshift(chunk: Buffer): void {
    this.unshifted.push(chunk);
  }
}

function asSocket(s: FakeSocket): net.Socket {
  return s as unknown as net.Socket;
}

// ---------------------------------------------------------------------------
// sendSslRequest
// ---------------------------------------------------------------------------

describe('sendSslRequest', () => {
  test('returns "S" when server agrees to TLS', async () => {
    const fake = new FakeSocket({ reply: 'S' });
    const reply = await sendSslRequest(asSocket(fake));
    expect(reply).toBe('S');
    // First write is the 8-byte SSLRequest.
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].toString('hex')).toBe('0000000804d2162f');
  });

  test('returns "N" when server refuses', async () => {
    const fake = new FakeSocket({ reply: 'N' });
    const reply = await sendSslRequest(asSocket(fake));
    expect(reply).toBe('N');
  });

  test('unshifts trailing bytes back onto the socket', async () => {
    // Server sometimes sends 'S' immediately followed by a TLS ClientHello
    // continuation — we must preserve those bytes for tls.connect to read.
    const buf = Buffer.concat([Buffer.from('S'), Buffer.from('TAIL')]);
    const fake = new FakeSocket({ reply: buf });
    const reply = await sendSslRequest(asSocket(fake));
    expect(reply).toBe('S');
    expect(fake.unshifted).toHaveLength(1);
    expect(fake.unshifted[0].toString()).toBe('TAIL');
  });

  test('rejects on socket error', async () => {
    const err = new Error('econnreset');
    const fake = new FakeSocket({ reply: 'S', emitError: err });
    await expect(sendSslRequest(asSocket(fake))).rejects.toBe(err);
  });

  test('rejects unexpected reply byte', async () => {
    const fake = new FakeSocket({ reply: Buffer.from([0x7a]) });
    await expect(sendSslRequest(asSocket(fake))).rejects.toThrow(
      /Unexpected SSLRequest response byte/,
    );
  });
});

// ---------------------------------------------------------------------------
// negotiateTls — sslmode branches that don't need a real handshake
// ---------------------------------------------------------------------------

describe('negotiateTls', () => {
  test('sslmode=disable skips the handshake entirely', async () => {
    const fake = new FakeSocket({ reply: 'S' });
    const result = await negotiateTls(asSocket(fake), 'disable');
    expect(result.kind).toBe('plain');
    expect(fake.writes).toHaveLength(0);
  });

  test('sslmode=prefer falls back to plain when server replies N', async () => {
    const fake = new FakeSocket({ reply: 'N' });
    const result = await negotiateTls(asSocket(fake), 'prefer');
    expect(result.kind).toBe('plain');
  });

  test('sslmode=require throws when server replies N', async () => {
    const fake = new FakeSocket({ reply: 'N' });
    await expect(negotiateTls(asSocket(fake), 'require')).rejects.toThrow(
      /SSL connection required/,
    );
  });

  test('sslmode=verify-full throws when server replies N', async () => {
    const fake = new FakeSocket({ reply: 'N' });
    await expect(negotiateTls(asSocket(fake), 'verify-full')).rejects.toThrow(
      /SSL connection required/,
    );
  });
});

// ---------------------------------------------------------------------------
// computeChannelBindingData
// ---------------------------------------------------------------------------

describe('computeChannelBindingData', () => {
  test('hashes peer cert DER bytes with SHA-256', () => {
    const der = Buffer.from('fake-cert-bytes');
    const expected = createHash('sha256').update(der).digest();
    const got = computeChannelBindingData({
      raw: der,
    } as unknown as tls.PeerCertificate);
    expect(got.equals(expected)).toBe(true);
  });

  test('throws when peer cert has no raw bytes', () => {
    expect(() =>
      computeChannelBindingData({
        raw: Buffer.alloc(0),
      } as unknown as tls.PeerCertificate),
    ).toThrow(/no DER bytes/);
    expect(() =>
      computeChannelBindingData({} as unknown as tls.PeerCertificate),
    ).toThrow(/no DER bytes/);
  });
});
