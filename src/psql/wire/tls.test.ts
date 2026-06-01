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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import type * as tls from 'node:tls';

import {
  computeChannelBindingData,
  loadTlsFileOptions,
  mapTlsHandshakeError,
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

// ---------------------------------------------------------------------------
// libpq PEM file paths → tls.connect option merging.
//
// Each present TlsFileOptions entry is read once and threaded into the
// matching tls.connect key (`ca`, `cert`, `key`, `crl`). The actual TLS
// handshake isn't exercised — we only need to know the bytes reach the
// options dict and that read failures surface a clear "could not read …"
// diagnostic.
// ---------------------------------------------------------------------------

describe('loadTlsFileOptions', () => {
  const fixtures = (): {
    dir: string;
    caPath: string;
    certPath: string;
    keyPath: string;
    crlPath: string;
    cleanup: () => void;
  } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    const caPath = path.join(dir, 'ca.pem');
    const certPath = path.join(dir, 'client.crt');
    const keyPath = path.join(dir, 'client.key');
    const crlPath = path.join(dir, 'crl.pem');
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nca-bytes\n');
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ncert-bytes\n');
    fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nkey-bytes\n');
    // A real private key must be u=rw-only; loadTlsFileOptions enforces the
    // same libpq permission check, so the fixture key has to be 0600 or the
    // read is (correctly) refused.
    fs.chmodSync(keyPath, 0o600);
    fs.writeFileSync(crlPath, '-----BEGIN X509 CRL-----\ncrl-bytes\n');
    return {
      dir,
      caPath,
      certPath,
      keyPath,
      crlPath,
      cleanup: (): void => {
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  test('reads sslrootcert / sslcert / sslkey / sslcrl into ca / cert / key / crl', async () => {
    const f = fixtures();
    try {
      const merged = await loadTlsFileOptions(
        { servername: 'example.com' },
        {
          sslrootcert: f.caPath,
          sslcert: f.certPath,
          sslkey: f.keyPath,
          sslcrl: f.crlPath,
        },
      );
      // Existing options are preserved.
      expect(merged.servername).toBe('example.com');
      // PEM bytes land on Node's tls.connect option keys verbatim.
      expect(Buffer.isBuffer(merged.ca)).toBe(true);
      expect((merged.ca as Buffer).toString()).toContain('ca-bytes');
      expect(Buffer.isBuffer(merged.cert)).toBe(true);
      expect((merged.cert as Buffer).toString()).toContain('cert-bytes');
      expect(Buffer.isBuffer(merged.key)).toBe(true);
      expect((merged.key as Buffer).toString()).toContain('key-bytes');
      expect(Buffer.isBuffer(merged.crl)).toBe(true);
      expect((merged.crl as Buffer).toString()).toContain('crl-bytes');
    } finally {
      f.cleanup();
    }
  });

  test('does not touch tls options when no file paths are supplied', async () => {
    const merged = await loadTlsFileOptions(
      { rejectUnauthorized: true, servername: 'h' },
      {},
    );
    expect(merged).toEqual({ rejectUnauthorized: true, servername: 'h' });
    expect(merged.ca).toBeUndefined();
    expect(merged.cert).toBeUndefined();
    expect(merged.key).toBeUndefined();
    expect(merged.crl).toBeUndefined();
  });

  test('treats empty string paths as "not set"', async () => {
    // An empty path would be a libpq-style "unset" signal; we must not try
    // to read "" from disk (which would throw EISDIR or similar).
    const merged = await loadTlsFileOptions(
      {},
      { sslcert: '', sslkey: '', sslrootcert: '', sslcrl: '' },
    );
    expect(merged.ca).toBeUndefined();
    expect(merged.cert).toBeUndefined();
    expect(merged.key).toBeUndefined();
    expect(merged.crl).toBeUndefined();
  });

  test('surfaces a clear error when sslrootcert points at a missing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const missing = path.join(dir, 'does-not-exist.pem');
      await expect(
        loadTlsFileOptions({}, { sslrootcert: missing }),
      ).rejects.toThrow(/could not read sslrootcert ".*does-not-exist\.pem"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('surfaces a clear error when sslcert points at a missing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const missing = path.join(dir, 'gone.crt');
      await expect(
        loadTlsFileOptions({}, { sslcert: missing }),
      ).rejects.toThrow(/could not read sslcert ".*gone\.crt"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('surfaces a clear error when sslkey points at a missing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const missing = path.join(dir, 'no.key');
      await expect(loadTlsFileOptions({}, { sslkey: missing })).rejects.toThrow(
        /could not read sslkey ".*no\.key"/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plumbs sslpassword through to tls.connect as passphrase', async () => {
    const f = fixtures();
    try {
      const merged = await loadTlsFileOptions(
        {},
        { sslkey: f.keyPath, sslpassword: 'sekret' },
        'require',
      );
      expect(merged.passphrase).toBe('sekret');
      expect(Buffer.isBuffer(merged.key)).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test('treats empty sslpassword as "not set"', async () => {
    const merged = await loadTlsFileOptions({}, { sslpassword: '' });
    expect(merged.passphrase).toBeUndefined();
  });

  test('sslmode=require + nonexistent sslrootcert never opens the file', async () => {
    // libpq only opens sslrootcert in verify-ca / verify-full. The TS impl
    // must mirror that — an unreadable placeholder path must not abort the
    // require-mode handshake.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const missing = path.join(dir, 'definitely-missing.pem');
      // No throw — and merged.ca stays undefined.
      const merged = await loadTlsFileOptions(
        {},
        { sslrootcert: missing },
        'require',
      );
      expect(merged.ca).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sslmode=verify-ca + nonexistent sslrootcert still surfaces the read error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const missing = path.join(dir, 'gone.pem');
      await expect(
        loadTlsFileOptions({}, { sslrootcert: missing }, 'verify-ca'),
      ).rejects.toThrow(/could not read sslrootcert ".*gone\.pem"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sslmode=verify-full + nonexistent sslrootcert still surfaces the read error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const missing = path.join(dir, 'gone.pem');
      await expect(
        loadTlsFileOptions({}, { sslrootcert: missing }, 'verify-full'),
      ).rejects.toThrow(/could not read sslrootcert ".*gone\.pem"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('omitted sslMode defaults to eager read (back-compat)', async () => {
    // Older callers that don't thread the sslmode through must still see
    // the read failure — this is the pre-existing diagnostic shape.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const missing = path.join(dir, 'unset.pem');
      await expect(
        loadTlsFileOptions({}, { sslrootcert: missing }),
      ).rejects.toThrow(/could not read sslrootcert/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // sslkey permission guard (libpq's group/world-access stat check).
  // -------------------------------------------------------------------------
  test('rejects a group/world-readable sslkey (0644)', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const keyPath = path.join(dir, 'loose.key');
      fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nk\n');
      fs.chmodSync(keyPath, 0o644);
      await expect(
        loadTlsFileOptions({}, { sslkey: keyPath }, 'require'),
      ).rejects.toThrow(
        `private key file "${keyPath}" has group or world access`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts a 0600 sslkey', async () => {
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-pem-'));
    try {
      const keyPath = path.join(dir, 'tight.key');
      fs.writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nk\n');
      fs.chmodSync(keyPath, 0o600);
      const merged = await loadTlsFileOptions(
        {},
        { sslkey: keyPath },
        'require',
      );
      expect(Buffer.isBuffer(merged.key)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // sslcrldir: read + concatenate every CRL file in the directory.
  // -------------------------------------------------------------------------
  test('reads every CRL file in sslcrldir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-crl-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'a.crl'),
        '-----BEGIN X509 CRL-----\ncrl-a\n',
      );
      fs.writeFileSync(
        path.join(dir, 'b.crl'),
        '-----BEGIN X509 CRL-----\ncrl-b\n',
      );
      const merged = await loadTlsFileOptions({}, { sslcrldir: dir });
      // Two files → crl is an array of two buffers.
      expect(Array.isArray(merged.crl)).toBe(true);
      const joined = (merged.crl as Buffer[]).map((b) => b.toString()).join('');
      expect(joined).toContain('crl-a');
      expect(joined).toContain('crl-b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('combines sslcrl + sslcrldir into the crl array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-crl-'));
    try {
      const single = path.join(dir, 'single.pem');
      fs.writeFileSync(single, '-----BEGIN X509 CRL-----\nsingle\n');
      const crlDir = path.join(dir, 'crls');
      fs.mkdirSync(crlDir);
      fs.writeFileSync(
        path.join(crlDir, 'dir.crl'),
        '-----BEGIN X509 CRL-----\nfrom-dir\n',
      );
      const merged = await loadTlsFileOptions(
        {},
        { sslcrl: single, sslcrldir: crlDir },
      );
      const joined = (merged.crl as Buffer[]).map((b) => b.toString()).join('');
      expect(joined).toContain('single');
      expect(joined).toContain('from-dir');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('surfaces a clear error when sslcrldir is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-crl-'));
    try {
      const missing = path.join(dir, 'no-such-dir');
      await expect(
        loadTlsFileOptions({}, { sslcrldir: missing }),
      ).rejects.toThrow(/could not read sslcrldir ".*no-such-dir"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// libpq-style TLS handshake error wording.
// ---------------------------------------------------------------------------
describe('mapTlsHandshakeError', () => {
  test('maps hostname mismatch to libpq wording with the servername', () => {
    const err = Object.assign(
      new Error("Hostname/IP does not match certificate's altnames"),
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    );
    const mapped = mapTlsHandshakeError(err, 'db.example.com');
    expect(mapped.message).toBe(
      'server certificate for "db.example.com" does not match host name "db.example.com"',
    );
    expect((mapped as Error & { cause?: unknown }).cause).toBe(err);
  });

  test('maps chain-verification failures to "certificate verify failed"', () => {
    const err = Object.assign(new Error('self-signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    const mapped = mapTlsHandshakeError(err, 'h');
    expect(mapped.message).toBe('certificate verify failed');
    expect((mapped as Error & { cause?: unknown }).cause).toBe(err);
  });

  test('passes through unrelated errors unchanged', () => {
    const err = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    expect(mapTlsHandshakeError(err, 'h')).toBe(err);
  });
});

// ---------------------------------------------------------------------------
// negotiateTls + sslmode='disable' must NOT touch the filesystem even when
// file paths are supplied — short-circuit comes first.
// ---------------------------------------------------------------------------

describe('negotiateTls + file options', () => {
  test('disable mode skips file loading entirely', async () => {
    // Even with bogus sslrootcert paths, sslmode='disable' must return
    // plain immediately without attempting any disk I/O.
    const fake = new FakeSocket({ reply: 'N' });
    const result = await negotiateTls(
      asSocket(fake),
      'disable',
      {},
      { sslrootcert: '/path/does/not/exist/ca.pem' },
    );
    expect(result.kind).toBe('plain');
    expect(fake.writes).toHaveLength(0);
  });

  test('prefer + server-refused N skips file loading (no TLS upgrade)', async () => {
    // When the server replies 'N', we never reach the file-loading path —
    // even if the user supplied an invalid sslrootcert. This matches libpq:
    // bad cert files only blow up when we actually need them.
    const fake = new FakeSocket({ reply: 'N' });
    const result = await negotiateTls(
      asSocket(fake),
      'prefer',
      {},
      { sslrootcert: '/path/does/not/exist/ca.pem' },
    );
    expect(result.kind).toBe('plain');
  });
});
