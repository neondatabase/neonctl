/**
 * Direct-SSL negotiation tests (libpq `sslnegotiation=direct`, PG 17+).
 *
 * The classic flow sends an `SSLRequest` packet and waits for 'S'/'N'; direct
 * SSL skips that probe and starts the TLS handshake immediately, advertising
 * the `postgresql` ALPN protocol. We can't run a real TLS handshake in a unit
 * test, so we replace `node:tls`'s `connect` with a fake that records the
 * options it was handed and synchronously drives the connect callback. This
 * lets us assert the two behaviours that define the direct path:
 *
 *   1. The raw socket is NEVER written to (no `SSLRequest` byte sequence).
 *   2. `tls.connect` is invoked with `ALPNProtocols: ['postgresql']`.
 *
 * `vi.mock('node:tls')` is scoped to this file and only overrides `connect`
 * (everything else is the real module via `...actual`), so the rest of the
 * tls unit suite — which never calls `tls.connect` — is unaffected and stays
 * in `tls.test.ts`.
 */

import { describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import type * as net from 'node:net';
import type * as tls from 'node:tls';

// Records every options object passed to the mocked `tls.connect`.
const connectCalls: tls.ConnectionOptions[] = [];

vi.mock('node:tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tls')>();
  return {
    ...actual,
    connect: (opts: tls.ConnectionOptions, cb?: () => void): unknown => {
      connectCalls.push(opts);
      // Minimal TLSSocket stand-in: a real EventEmitter (so `.on` /
      // `.removeListener` work), reporting no peer cert (channel binding null)
      // and resolving the handshake callback on the next tick.
      const sock = Object.assign(new EventEmitter(), {
        getPeerX509Certificate: (): undefined => undefined,
        getPeerCertificate: (): Record<string, never> => ({}),
      });
      if (cb) {
        queueMicrotask(cb);
      }
      return sock;
    },
  };
});

// Imported AFTER the mock declaration; vitest hoists `vi.mock` so the import
// observes the patched module.
import { negotiateTls } from './tls.js';

class FakeRawSocket extends EventEmitter {
  public writes: Buffer[] = [];
  public unshifted: Buffer[] = [];
  public write(chunk: Buffer): void {
    this.writes.push(chunk);
  }
  public unshift(chunk: Buffer): void {
    this.unshifted.push(chunk);
  }
}

function asSocket(s: FakeRawSocket): net.Socket {
  return s as unknown as net.Socket;
}

describe('negotiateTls — sslnegotiation=direct', () => {
  test('does NOT send SSLRequest and advertises ALPN postgresql', async () => {
    connectCalls.length = 0;
    const fake = new FakeRawSocket();
    const result = await negotiateTls(
      asSocket(fake),
      'require',
      { ALPNProtocols: ['postgresql'], servername: 'db.example.com' },
      {},
      'direct',
    );
    // No SSLRequest probe was written to the raw socket.
    expect(fake.writes).toHaveLength(0);
    // The TLS handshake ran (callback resolved).
    expect(result.kind).toBe('tls');
    // ALPN protocol was offered to tls.connect.
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].ALPNProtocols).toEqual(['postgresql']);
    // The raw socket is threaded into tls.connect's `socket` option.
    expect(
      (connectCalls[0] as tls.ConnectionOptions & { socket?: unknown }).socket,
    ).toBe(fake);
  });

  test('classic (postgres) negotiation still sends SSLRequest first', async () => {
    connectCalls.length = 0;
    const fake = new FakeRawSocket();
    // Reply 'S' on the next tick so sendSslRequest resolves and we upgrade.
    const orig = fake.write.bind(fake);
    fake.write = (chunk: Buffer): void => {
      orig(chunk);
      queueMicrotask(() => fake.emit('data', Buffer.from('S')));
    };
    const result = await negotiateTls(
      asSocket(fake),
      'require',
      { ALPNProtocols: ['postgresql'] },
      {},
      'postgres',
    );
    // The 8-byte SSLRequest packet WAS written.
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].toString('hex')).toBe('0000000804d2162f');
    expect(result.kind).toBe('tls');
    expect(connectCalls[0].ALPNProtocols).toEqual(['postgresql']);
  });

  test('default negotiation arg is postgres (sends SSLRequest)', async () => {
    connectCalls.length = 0;
    const fake = new FakeRawSocket();
    const orig = fake.write.bind(fake);
    fake.write = (chunk: Buffer): void => {
      orig(chunk);
      queueMicrotask(() => fake.emit('data', Buffer.from('S')));
    };
    // Omit the negotiation argument entirely — must behave as 'postgres'.
    const result = await negotiateTls(asSocket(fake), 'require', {}, {});
    expect(fake.writes).toHaveLength(1);
    expect(result.kind).toBe('tls');
  });
});
