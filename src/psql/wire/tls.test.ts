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
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import type * as tls from 'node:tls';

import {
  attachKeyLogListener,
  computeChannelBindingData,
  loadTlsFileOptions,
  mapTlsHandshakeError,
  negotiateTls,
  readCaDir,
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

  // -------------------------------------------------------------------------
  // sslcertmode: disable suppresses the client cert/key; require demands one.
  // -------------------------------------------------------------------------
  test('sslcertmode=disable skips the client cert/key even when both are set', async () => {
    const f = fixtures();
    try {
      const merged = await loadTlsFileOptions(
        {},
        { sslcert: f.certPath, sslkey: f.keyPath, sslcertmode: 'disable' },
      );
      expect(merged.cert).toBeUndefined();
      expect(merged.key).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  test('sslcertmode=allow sends the cert/key when present', async () => {
    const f = fixtures();
    try {
      const merged = await loadTlsFileOptions(
        {},
        { sslcert: f.certPath, sslkey: f.keyPath, sslcertmode: 'allow' },
      );
      expect((merged.cert as Buffer).toString()).toContain('cert-bytes');
      expect((merged.key as Buffer).toString()).toContain('key-bytes');
    } finally {
      f.cleanup();
    }
  });

  test('sslcertmode=require throws when no client cert is configured', async () => {
    await expect(
      loadTlsFileOptions({}, { sslcertmode: 'require' }),
    ).rejects.toThrow(
      'sslcertmode value "require" requires a client certificate',
    );
  });

  test('sslcertmode=require with an empty sslcert path still throws', async () => {
    await expect(
      loadTlsFileOptions({}, { sslcert: '', sslcertmode: 'require' }),
    ).rejects.toThrow(
      'sslcertmode value "require" requires a client certificate',
    );
  });

  test('sslcertmode=require with a configured cert loads it', async () => {
    const f = fixtures();
    try {
      const merged = await loadTlsFileOptions(
        {},
        { sslcert: f.certPath, sslkey: f.keyPath, sslcertmode: 'require' },
      );
      expect((merged.cert as Buffer).toString()).toContain('cert-bytes');
    } finally {
      f.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // DER auto-detection: libpq accepts sslcert/sslkey/sslrootcert in PEM or DER
  // (binary) form. Node's tls.connect wants PEM, so a non-PEM file is treated
  // as DER and wrapped in the correct armor in-memory.
  // -------------------------------------------------------------------------

  /** Decode the base64 body of a single PEM block back to its DER bytes. */
  const pemBodyToDer = (pem: string): Buffer => {
    const body = pem
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
    return Buffer.from(body, 'base64');
  };

  test('wraps a DER (non-PEM) sslcert in CERTIFICATE armor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-der-'));
    try {
      // Arbitrary binary bytes that do NOT start with the PEM marker — stands
      // in for a DER-encoded cert. Includes high bytes so it is unambiguously
      // binary, not accidentally text.
      const der = Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x00, 0xff, 0xfe, 0x7f]);
      const certPath = path.join(dir, 'client.der');
      fs.writeFileSync(certPath, der);
      const merged = await loadTlsFileOptions({}, { sslcert: certPath });
      const pem = (merged.cert as Buffer).toString('ascii');
      expect(pem).toContain('-----BEGIN CERTIFICATE-----');
      expect(pem).toContain('-----END CERTIFICATE-----');
      // The armored body must base64-decode back to the original DER bytes.
      expect(pemBodyToDer(pem).equals(der)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A DER sslkey is decoded with `crypto.createPrivateKey` (trying PKCS#8,
  // then PKCS#1, then SEC1) and re-exported as canonical PKCS#8 PEM, rather
  // than blindly wrapped in PKCS#8 armor. Blind wrapping breaks on a DER key
  // that is actually PKCS#1/SEC1 (and on what OpenSSL 3.0.x's
  // `openssl pkey -outform der` emits for RSA) with `DECODER unsupported`.
  // We assert BOTH input encodings round-trip to a loadable PKCS#8 PEM.
  test.each(['pkcs8', 'pkcs1'] as const)(
    'decodes a DER (%s) sslkey into loadable PKCS#8 PEM',
    async (derType) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-der-'));
      try {
        const { privateKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048,
        });
        const der = privateKey.export({
          format: 'der',
          type: derType,
        });
        const keyPath = path.join(dir, 'client.key.der');
        fs.writeFileSync(keyPath, der);
        fs.chmodSync(keyPath, 0o600);
        const merged = await loadTlsFileOptions({}, { sslkey: keyPath });
        const pem = (merged.key as Buffer).toString('ascii');
        // Always normalized to PKCS#8 armor regardless of input encoding.
        expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
        expect(pem).toContain('-----END PRIVATE KEY-----');
        // The re-exported PEM is a real key OpenSSL accepts (the bug surfaced
        // as a throw at this exact decode step under the old blind wrapping).
        expect(() => createPrivateKey(pem)).not.toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('rejects a DER sslkey that is not a valid private key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-der-'));
    try {
      // Not a decodable key (a bare truncated SEQUENCE) — must fail loudly,
      // not silently mislabel as PEM.
      const der = Buffer.from([0x30, 0x82, 0x02, 0x5d, 0x02, 0x01, 0x00, 0x80]);
      const keyPath = path.join(dir, 'client.key.der');
      fs.writeFileSync(keyPath, der);
      fs.chmodSync(keyPath, 0o600);
      await expect(loadTlsFileOptions({}, { sslkey: keyPath })).rejects.toThrow(
        /PKCS#8, PKCS#1, or SEC1/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('wraps a DER (non-PEM) sslrootcert in CERTIFICATE armor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-der-'));
    try {
      const der = Buffer.from([0x30, 0x82, 0x03, 0x11, 0xca, 0xfe, 0xba, 0xbe]);
      const caPath = path.join(dir, 'root.der');
      fs.writeFileSync(caPath, der);
      const merged = await loadTlsFileOptions(
        {},
        { sslrootcert: caPath },
        'verify-full',
      );
      const pem = (merged.ca as Buffer).toString('ascii');
      expect(pem).toContain('-----BEGIN CERTIFICATE-----');
      expect(pemBodyToDer(pem).equals(der)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves an already-PEM sslcert untouched (no double-armor)', async () => {
    const f = fixtures();
    try {
      const merged = await loadTlsFileOptions({}, { sslcert: f.certPath });
      const pem = (merged.cert as Buffer).toString();
      // PEM input flows through verbatim — exactly one BEGIN marker, and the
      // original body text survives.
      expect(pem).toBe('-----BEGIN CERTIFICATE-----\ncert-bytes\n');
      expect(pem.match(/-----BEGIN/g)?.length).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  test('converts an openssl-minted DER cert (when openssl is on PATH)', async () => {
    let openssl = true;
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      openssl = false;
    }
    if (!openssl) return; // hermetic skip: no openssl in this environment
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-der-'));
    try {
      const keyPem = path.join(dir, 'k.pem');
      const certPem = path.join(dir, 'c.pem');
      const certDer = path.join(dir, 'c.der');
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPem,
        '-out',
        certPem,
        '-days',
        '1',
        '-subj',
        '/CN=der-test',
      ]);
      execFileSync('openssl', [
        'x509',
        '-in',
        certPem,
        '-outform',
        'der',
        '-out',
        certDer,
      ]);
      const merged = await loadTlsFileOptions({}, { sslcert: certDer });
      const pem = (merged.cert as Buffer).toString('ascii');
      expect(pem).toContain('-----BEGIN CERTIFICATE-----');
      // The wrapped PEM must equal the PEM openssl emits from the same cert.
      const expectedDer = fs.readFileSync(certDer);
      expect(pemBodyToDer(pem).equals(expectedDer)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // sslrootcert=system: trust store, not a file path. Honour $SSL_CERT_FILE
  // (libpq's OpenSSL behaviour); otherwise leave `ca` unset (built-in store).
  // -------------------------------------------------------------------------
  test('sslrootcert=system without SSL_CERT_FILE leaves ca unset', async () => {
    const saved = process.env.SSL_CERT_FILE;
    delete process.env.SSL_CERT_FILE;
    try {
      const merged = await loadTlsFileOptions(
        { rejectUnauthorized: true },
        { sslrootcert: 'system' },
        'verify-full',
      );
      expect(merged.ca).toBeUndefined();
      // rejectUnauthorized must survive untouched.
      expect(merged.rejectUnauthorized).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = saved;
    }
  });

  test('sslrootcert=system with SSL_CERT_FILE reads that file as the CA', async () => {
    const f = fixtures();
    const saved = process.env.SSL_CERT_FILE;
    process.env.SSL_CERT_FILE = f.caPath;
    try {
      const merged = await loadTlsFileOptions(
        { rejectUnauthorized: true },
        { sslrootcert: 'system' },
        'verify-full',
      );
      expect(Buffer.isBuffer(merged.ca)).toBe(true);
      expect((merged.ca as Buffer).toString()).toContain('ca-bytes');
    } finally {
      if (saved === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = saved;
      f.cleanup();
    }
  });

  test('sslrootcert=system never tries to read a file named "system"', async () => {
    const saved = process.env.SSL_CERT_FILE;
    delete process.env.SSL_CERT_FILE;
    try {
      // Would throw `could not read sslrootcert "system"` if we treated the
      // value as a path; the trust-store branch must short-circuit instead.
      await expect(
        loadTlsFileOptions({}, { sslrootcert: 'system' }, 'verify-full'),
      ).resolves.toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = saved;
    }
  });

  // -------------------------------------------------------------------------
  // SSL_CERT_DIR: OpenSSL hashed-dir of CA files honoured by
  // sslrootcert=system, alongside (or instead of) SSL_CERT_FILE.
  // -------------------------------------------------------------------------
  const withSslCertEnv = async (
    file: string | undefined,
    dir: string | undefined,
    fn: () => Promise<void>,
  ): Promise<void> => {
    const savedFile = process.env.SSL_CERT_FILE;
    const savedDir = process.env.SSL_CERT_DIR;
    if (file === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = file;
    if (dir === undefined) delete process.env.SSL_CERT_DIR;
    else process.env.SSL_CERT_DIR = dir;
    try {
      await fn();
    } finally {
      if (savedFile === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = savedFile;
      if (savedDir === undefined) delete process.env.SSL_CERT_DIR;
      else process.env.SSL_CERT_DIR = savedDir;
    }
  };

  test('readCaDir reads every regular file in the directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-cadir-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'a.0'),
        '-----BEGIN CERTIFICATE-----\nca-a\n-----END CERTIFICATE-----\n',
      );
      fs.writeFileSync(
        path.join(dir, 'b.0'),
        '-----BEGIN CERTIFICATE-----\nca-b\n-----END CERTIFICATE-----\n',
      );
      // Subdirectories are skipped (only hashed CA files live at the top).
      fs.mkdirSync(path.join(dir, 'nested'));
      const cas = await readCaDir(dir);
      expect(cas).toHaveLength(2);
      const joined = cas.map((c) => c.toString()).sort();
      expect(joined[0]).toContain('ca-a');
      expect(joined[1]).toContain('ca-b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readCaDir surfaces a clear error for a missing directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-cadir-'));
    try {
      const missing = path.join(dir, 'no-such-dir');
      await expect(readCaDir(missing)).rejects.toThrow(
        /could not read SSL_CERT_DIR ".*no-such-dir"/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sslrootcert=system reads SSL_CERT_DIR files into the ca array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-cadir-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'one.0'),
        '-----BEGIN CERTIFICATE-----\ndir-ca-1\n-----END CERTIFICATE-----\n',
      );
      fs.writeFileSync(
        path.join(dir, 'two.0'),
        '-----BEGIN CERTIFICATE-----\ndir-ca-2\n-----END CERTIFICATE-----\n',
      );
      await withSslCertEnv(undefined, dir, async () => {
        const merged = await loadTlsFileOptions(
          {},
          { sslrootcert: 'system' },
          'verify-full',
        );
        expect(Array.isArray(merged.ca)).toBe(true);
        const cas = (merged.ca as Buffer[]).map((c) => c.toString()).sort();
        expect(cas[0]).toContain('dir-ca-1');
        expect(cas[1]).toContain('dir-ca-2');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sslrootcert=system combines SSL_CERT_FILE and SSL_CERT_DIR', async () => {
    const f = fixtures();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-cadir-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'dir.0'),
        '-----BEGIN CERTIFICATE-----\nfrom-dir\n-----END CERTIFICATE-----\n',
      );
      await withSslCertEnv(f.caPath, dir, async () => {
        const merged = await loadTlsFileOptions(
          {},
          { sslrootcert: 'system' },
          'verify-full',
        );
        expect(Array.isArray(merged.ca)).toBe(true);
        const cas = (merged.ca as Buffer[]).map((c) => c.toString());
        expect(cas.some((c) => c.includes('ca-bytes'))).toBe(true);
        expect(cas.some((c) => c.includes('from-dir'))).toBe(true);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      f.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // sslkeylogfile: pre-checked for writability at connect time.
  // -------------------------------------------------------------------------
  test('sslkeylogfile pre-check accepts a writable path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-klf-'));
    try {
      const klf = path.join(dir, 'keys.log');
      await expect(
        loadTlsFileOptions({}, { sslkeylogfile: klf }),
      ).resolves.toBeDefined();
      // The pre-check opens the file for append, creating it.
      expect(fs.existsSync(klf)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sslkeylogfile in an unwritable dir surfaces "could not open"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-klf-'));
    try {
      // A path whose parent directory does not exist cannot be opened.
      const klf = path.join(dir, 'no-such-subdir', 'keys.log');
      await expect(
        loadTlsFileOptions({}, { sslkeylogfile: klf }),
      ).rejects.toThrow(/could not open sslkeylogfile ".*keys\.log"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// attachKeyLogListener: append each emitted keylog line to the target file.
// ---------------------------------------------------------------------------
describe('attachKeyLogListener', () => {
  test('appends each keylog line to the file in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-klf-'));
    try {
      const klf = path.join(dir, 'keys.log');
      const emitter = new EventEmitter();
      attachKeyLogListener(
        emitter as unknown as Parameters<typeof attachKeyLogListener>[0],
        klf,
      );
      emitter.emit('keylog', Buffer.from('CLIENT_RANDOM aaa 111\n'));
      emitter.emit('keylog', Buffer.from('CLIENT_RANDOM bbb 222\n'));
      const contents = fs.readFileSync(klf, 'utf8');
      expect(contents).toBe('CLIENT_RANDOM aaa 111\nCLIENT_RANDOM bbb 222\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('re-emits a socket error when the append fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neonctl-psql-klf-'));
    try {
      // Target a path under a file (not a directory) so appendFileSync throws.
      const notADir = path.join(dir, 'a-file');
      fs.writeFileSync(notADir, 'x');
      const klf = path.join(notADir, 'keys.log');
      const emitter = new EventEmitter();
      const errors: Error[] = [];
      emitter.on('error', (e: Error) => errors.push(e));
      attachKeyLogListener(
        emitter as unknown as Parameters<typeof attachKeyLogListener>[0],
        klf,
      );
      emitter.emit('keylog', Buffer.from('CLIENT_RANDOM aaa 111\n'));
      expect(errors).toHaveLength(1);
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

  test('maps ERR_OSSL_BAD_DECRYPT to libpq private-key-file wording with path', () => {
    const err = Object.assign(
      new Error('error:1C800064:Provider routines::bad decrypt'),
      { code: 'ERR_OSSL_BAD_DECRYPT' },
    );
    const mapped = mapTlsHandshakeError(err, 'h', '/keys/client.key');
    expect(mapped.message).toBe(
      'could not load private key file "/keys/client.key": error:1C800064:Provider routines::bad decrypt',
    );
    // The libpq-asserted `bad decrypt` token survives in the message tail.
    expect(mapped.message).toMatch(/private key file ".*".*bad decrypt/);
    expect((mapped as Error & { cause?: unknown }).cause).toBe(err);
  });

  test('maps a bad-decrypt message even without an OpenSSL error code', () => {
    const err = new Error('something something bad decrypt failure');
    const mapped = mapTlsHandshakeError(err, undefined, '/k.key');
    expect(mapped.message).toBe(
      'could not load private key file "/k.key": something something bad decrypt failure',
    );
  });

  test('bad-decrypt mapping omits the path segment when keyPath is unknown', () => {
    const err = Object.assign(new Error('bad decrypt'), {
      code: 'ERR_OSSL_BAD_DECRYPT',
    });
    const mapped = mapTlsHandshakeError(err);
    expect(mapped.message).toBe('could not load private key file: bad decrypt');
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
