/**
 * TLS negotiation for the psql wire layer (WP-02).
 *
 * Two responsibilities:
 *
 *   1. Drive the PG-flavoured SSL handshake. Postgres negotiates TLS
 *      *before* the protocol startup: client sends an `SSLRequest`
 *      (8-byte fixed message), server replies with a single byte —
 *      'S' to accept, 'N' to refuse. On 'S' we wrap the existing socket
 *      with `tls.connect({ socket })`; on 'N' we either bail (require/
 *      verify-*) or fall through plaintext (prefer/allow/disable).
 *
 *   2. Extract `tls-server-end-point` channel-binding material from the
 *      negotiated TLS session for SCRAM-SHA-256-PLUS. Per RFC 5929 §4 the
 *      data is the hash of the peer certificate computed with the cert's
 *      own signature hash, unless that hash is MD5 or SHA-1 — in which
 *      case the binding uses SHA-256. libpq's policy (`fe-secure-openssl.c`
 *      `PgChannelBinding`) is "always SHA-256 of the DER cert", which is
 *      also what the PG server expects. We follow libpq.
 *
 * Notes:
 *   - We deliberately do NOT validate the server cert here; that's the
 *     caller's responsibility (pass `tlsOpts.rejectUnauthorized` etc.). The
 *     ssl-mode → tls-options mapping lives in `connection.ts`.
 *   - `verify-ca` and `verify-full` differ only in hostname checking, which
 *     Node's `tls.connect` performs automatically when `checkServerIdentity`
 *     is the default and `servername` is set. The connection layer wires
 *     `servername` to the configured host before calling us.
 */

import type * as net from 'node:net';
import * as tls from 'node:tls';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { SSLRequest } from './protocol.js';

export type SslMode =
  | 'disable'
  | 'allow'
  | 'prefer'
  | 'require'
  | 'verify-ca'
  | 'verify-full';

export type TlsResult =
  | { kind: 'plain'; socket: net.Socket }
  | {
      kind: 'tls';
      socket: tls.TLSSocket;
      /**
       * `tls-server-end-point` channel-binding material (RFC 5929 §4).
       * `null` only if the peer cert was unavailable (extremely unusual on
       * a successful TLS handshake; a custom Agent could trigger this).
       */
      channelBindingData: Buffer | null;
    };

/**
 * libpq-style PEM file paths to be loaded and passed into `tls.connect`.
 * Each path is resolved exactly once per negotiateTls call. A missing file
 * surfaces as a clear "could not read ssl<file>: <ENOENT|EACCES>" error;
 * we deliberately do NOT silently fall back to system CAs / no-cert mode,
 * matching libpq's behaviour where an explicit `sslrootcert=` that fails
 * to read aborts the connection.
 */
export type TlsFileOptions = {
  /** Path to client cert (PEM). Mapped to tls.connect's `cert`. */
  sslcert?: string;
  /** Path to client key (PEM). Mapped to tls.connect's `key`. */
  sslkey?: string;
  /** Path to CA cert(s) (PEM, may contain a bundle). Mapped to `ca`. */
  sslrootcert?: string;
  /** Path to CRL (PEM). Mapped to `crl`. */
  sslcrl?: string;
};

/**
 * Hash of the peer cert for `tls-server-end-point`. libpq always uses SHA-256
 * of the DER-encoded certificate; we match that.
 *
 * Exposed for tests so we can stub the peer cert.
 */
export function computeChannelBindingData(cert: tls.PeerCertificate): Buffer {
  // `cert.raw` is the DER-encoded certificate. Strict typing in @types/node
  // marks it as `Buffer | undefined` on some versions, hence the guard.
  const raw: Buffer | undefined = cert.raw;
  if (!raw || raw.length === 0) {
    throw new Error('TLS channel binding: peer certificate has no DER bytes');
  }
  return createHash('sha256').update(raw).digest();
}

/**
 * Send SSLRequest, read the 1-byte server response, and either upgrade the
 * socket to TLS or stay plain (depending on `sslMode`).
 *
 * `tlsOpts` is passed through to `tls.connect` — the connection layer fills
 * in `host`, `servername`, `ca`, `rejectUnauthorized`, etc. before calling.
 *
 * `fileOpts` carries libpq-style PEM file paths (`sslcert`, `sslkey`,
 * `sslrootcert`, `sslcrl`). Each present path is read from disk before the
 * TLS handshake and threaded into the corresponding tls.connect option
 * (`cert` / `key` / `ca` / `crl`). Read failures bubble out as
 * `could not read ssl<…>: <message>` so the caller sees the libpq diagnostic
 * shape rather than a bare ENOENT.
 */
export async function negotiateTls(
  socket: net.Socket,
  sslMode: SslMode,
  tlsOpts: tls.ConnectionOptions = {},
  fileOpts: TlsFileOptions = {},
): Promise<TlsResult> {
  if (sslMode === 'disable') {
    return { kind: 'plain', socket };
  }

  const reply = await sendSslRequest(socket);

  if (reply === 'S') {
    const mergedOpts = await loadTlsFileOptions(tlsOpts, fileOpts);
    return upgradeToTls(socket, mergedOpts);
  }

  // reply === 'N': server refused TLS.
  if (
    sslMode === 'require' ||
    sslMode === 'verify-ca' ||
    sslMode === 'verify-full'
  ) {
    throw new Error(
      `SSL connection required (sslmode=${sslMode}) but server refused (replied 'N')`,
    );
  }
  // 'allow' / 'prefer': fall back to plain text.
  return { kind: 'plain', socket };
}

/**
 * Read each non-empty file path in `fileOpts` and merge the bytes onto a
 * shallow copy of `tlsOpts`. Each ENOENT / EACCES / permission error is
 * surfaced as `could not read ssl<file>: <reason>` so users immediately
 * know which option pointed at a bad path.
 *
 * Exported for tests (`tls.test.ts` swaps in a mocked `tls.connect`).
 */
export async function loadTlsFileOptions(
  tlsOpts: tls.ConnectionOptions,
  fileOpts: TlsFileOptions,
): Promise<tls.ConnectionOptions> {
  const merged: tls.ConnectionOptions = { ...tlsOpts };

  if (fileOpts.sslrootcert !== undefined && fileOpts.sslrootcert !== '') {
    merged.ca = await readPem('sslrootcert', fileOpts.sslrootcert);
  }
  if (fileOpts.sslcert !== undefined && fileOpts.sslcert !== '') {
    merged.cert = await readPem('sslcert', fileOpts.sslcert);
  }
  if (fileOpts.sslkey !== undefined && fileOpts.sslkey !== '') {
    merged.key = await readPem('sslkey', fileOpts.sslkey);
  }
  if (fileOpts.sslcrl !== undefined && fileOpts.sslcrl !== '') {
    merged.crl = await readPem('sslcrl', fileOpts.sslcrl);
  }

  return merged;
}

async function readPem(label: string, path: string): Promise<Buffer> {
  try {
    return await fs.readFile(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read ${label} "${path}": ${reason}`);
  }
}

/**
 * Send SSLRequest and pull off the 1-byte server response. The byte is
 * outside the regular framed protocol (it has no length / type header), so
 * we can't reuse MessageParser; instead we peel off one byte and push any
 * remainder back onto the socket via `unshift`.
 *
 * Exported for tests.
 */
export function sendSslRequest(socket: net.Socket): Promise<'S' | 'N'> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      if (chunk.length === 0) return;
      const first = String.fromCharCode(chunk[0]);
      if (first !== 'S' && first !== 'N') {
        cleanup();
        reject(
          new Error(
            `Unexpected SSLRequest response byte 0x${chunk[0].toString(16)}`,
          ),
        );
        return;
      }
      // Any extra bytes belong to subsequent messages; push them back.
      if (chunk.length > 1) {
        socket.unshift(chunk.subarray(1));
      }
      cleanup();
      resolve(first);
    };
    const cleanup = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(SSLRequest());
  });
}

function upgradeToTls(
  socket: net.Socket,
  tlsOpts: tls.ConnectionOptions,
): Promise<TlsResult> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const tlsSocket = tls.connect(
      {
        ...tlsOpts,
        socket,
      },
      () => {
        cleanup();
        let channelBindingData: Buffer | null = null;
        try {
          // Prefer the modern X509Certificate API (Node 15.6+): it returns a
          // proper `X509Certificate` instance whose `.raw` is the DER-encoded
          // cert. Falls back to the legacy `getPeerCertificate(true)` for
          // compatibility.
          const x509 = (
            tlsSocket as unknown as {
              getPeerX509Certificate?: () => { raw: Buffer } | undefined;
            }
          ).getPeerX509Certificate?.();
          if (x509?.raw && x509.raw.length > 0) {
            channelBindingData = createHash('sha256').update(x509.raw).digest();
          } else {
            // `detailed = true` gets us the full peer cert chain. Some
            // Node/OpenSSL combinations leave `.raw` undefined on the legacy
            // API when `rejectUnauthorized: false`; in that case we have to
            // accept that channel binding is unavailable.
            const peerCert = tlsSocket.getPeerCertificate(true);
            if (peerCert?.raw && peerCert.raw.length > 0) {
              channelBindingData = computeChannelBindingData(peerCert);
            }
          }
        } catch {
          // Best-effort: a missing peer cert => no channel binding. SASL
          // path will fall back to SCRAM-SHA-256 (non-PLUS).
          channelBindingData = null;
        }
        resolve({ kind: 'tls', socket: tlsSocket, channelBindingData });
      },
    );
    const cleanup = (): void => {
      tlsSocket.removeListener('error', onError);
    };
    tlsSocket.on('error', onError);
  });
}
