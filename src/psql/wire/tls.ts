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
import { promises as fs, appendFileSync } from 'node:fs';
import * as path from 'node:path';
import { SSLRequest } from './protocol.js';

export type SslMode =
  | 'disable'
  | 'allow'
  | 'prefer'
  | 'require'
  | 'verify-ca'
  | 'verify-full';

/**
 * libpq `sslnegotiation`: how TLS is initiated on the connection.
 *
 *   - `postgres` (default): the classic flow — send the 8-byte `SSLRequest`
 *     packet and await the server's single-byte 'S'/'N' reply before starting
 *     the TLS handshake.
 *   - `direct` (PG 17+): skip `SSLRequest` entirely and begin the TLS
 *     handshake immediately on the raw socket, advertising the `postgresql`
 *     ALPN protocol so a PG 17+ server (or TLS-aware proxy) recognises the
 *     direct-TLS ClientHello. Requires an encrypted sslmode (the parse and
 *     connection layers enforce that); there is no plaintext fallback.
 */
export type SslNegotiation = 'postgres' | 'direct';

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
  /**
   * libpq `sslcertmode`: governs whether the client cert/key are sent.
   *   - `disable`: never load / send {@link sslcert} or {@link sslkey},
   *     even when both are set.
   *   - `allow` (default when unset): load and send them when present.
   *   - `require`: a client cert MUST be present — if {@link sslcert} is
   *     unset, `loadTlsFileOptions` throws
   *     `sslcertmode value "require" requires a client certificate`.
   * (libpq additionally honours a default cert at
   * `~/.postgresql/postgresql.crt`; this client only sends an explicitly
   * configured {@link sslcert}, so "available" means "sslcert is set".)
   */
  sslcertmode?: 'disable' | 'allow' | 'require';
  /**
   * Passphrase for an encrypted PEM key supplied via {@link sslkey}.
   * Mapped to tls.connect's `passphrase` option; OpenSSL uses it to
   * decrypt the key at handshake time. Required when sslkey is an
   * encrypted PEM (PKCS#8 or legacy PEM-encrypted RSA/EC). Empty string
   * is treated as "no passphrase" to mirror libpq's behaviour.
   */
  sslpassword?: string;
  /**
   * Path to CA cert(s) (PEM, may contain a bundle), mapped to `ca`.
   *
   * The special value `system` (libpq `sslrootcert=system`) is NOT a file
   * path: it selects the OS / OpenSSL trust store. We emulate libpq's
   * OpenSSL build — if `SSL_CERT_FILE` is set we read THAT file as a CA
   * bundle, and if `SSL_CERT_DIR` is set we read every file in that directory
   * as additional CAs (both may be set together); otherwise we leave `ca`
   * unset so Node falls back to its built-in Mozilla root store.
   * `rejectUnauthorized` stays true either way.
   */
  sslrootcert?: string;
  /** Path to CRL (PEM). Mapped to `crl`. */
  sslcrl?: string;
  /**
   * Path to a directory of CRL files (libpq `sslcrldir`). Every regular file
   * in the directory is read and concatenated onto the `crl` bytes (after
   * {@link sslcrl}, if both are set). A read failure on the directory or any
   * file surfaces as `could not read sslcrldir "<path>": <reason>`.
   */
  sslcrldir?: string;
  /**
   * libpq `sslkeylogfile`: path the negotiated TLS session keys are appended
   * to (NSS key-log format) for offline decryption while debugging. The
   * handshake attaches a `'keylog'` listener and appends each emitted line.
   * The path is pre-checked (opened for append) before the handshake so a
   * bad path fails fast with `could not open sslkeylogfile "<path>":
   * <reason>` rather than silently dropping keys.
   */
  sslkeylogfile?: string;
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
 *
 * `fileOpts.sslkeylogfile`, when set, is pre-checked for writability here and
 * wired to a `'keylog'` listener on the upgraded socket so TLS session keys
 * are appended for offline decryption.
 *
 * `negotiation` selects how TLS is started (libpq `sslnegotiation`):
 *   - `'postgres'` (default): send `SSLRequest` and await the 'S'/'N' reply.
 *   - `'direct'`: skip `SSLRequest` and start the TLS handshake immediately
 *     on the raw socket (PG 17+). The caller must have set
 *     `tlsOpts.ALPNProtocols` to `['postgresql']`; there is no plaintext
 *     fallback, so a server that does not speak TLS surfaces the handshake
 *     failure rather than a quiet downgrade.
 */
export async function negotiateTls(
  socket: net.Socket,
  sslMode: SslMode,
  tlsOpts: tls.ConnectionOptions = {},
  fileOpts: TlsFileOptions = {},
  negotiation: SslNegotiation = 'postgres',
): Promise<TlsResult> {
  if (sslMode === 'disable') {
    return { kind: 'plain', socket };
  }

  // Direct SSL (libpq `sslnegotiation=direct`, PG 17+): skip the `SSLRequest`
  // probe and start the TLS handshake straight away. The parse layer has
  // already rejected weak sslmodes, so this path is only reached with an
  // encrypted mode — never falling back to plaintext.
  if (negotiation === 'direct') {
    const mergedOpts = await loadTlsFileOptions(tlsOpts, fileOpts, sslMode);
    return upgradeToTls(
      socket,
      mergedOpts,
      fileOpts.sslkeylogfile,
      fileOpts.sslkey,
    );
  }

  const reply = await sendSslRequest(socket);

  if (reply === 'S') {
    const mergedOpts = await loadTlsFileOptions(tlsOpts, fileOpts, sslMode);
    return upgradeToTls(
      socket,
      mergedOpts,
      fileOpts.sslkeylogfile,
      fileOpts.sslkey,
    );
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
 * Behaviour-defining details:
 *
 *   - `sslrootcert` is only read when `sslMode` is `verify-ca` /
 *     `verify-full`. Lower modes (require / prefer / allow) accept the
 *     server cert without consulting the trust anchor, matching libpq's
 *     policy of never opening the file in those modes. Tests can pass
 *     `'verify-ca'` as the sentinel to force the eager read for any
 *     non-disable mode (the default if omitted).
 *   - `sslpassword` is plumbed into `tls.connect` as `passphrase`; if
 *     unset OpenSSL leaves an encrypted key un-decryptable and the
 *     handshake errors with a "bad decrypt" diagnostic.
 *
 * Exported for tests (`tls.test.ts` swaps in a mocked `tls.connect`).
 */
export async function loadTlsFileOptions(
  tlsOpts: tls.ConnectionOptions,
  fileOpts: TlsFileOptions,
  sslMode?: SslMode,
): Promise<tls.ConnectionOptions> {
  const merged: tls.ConnectionOptions = { ...tlsOpts };

  // libpq only opens the trust-anchor file in modes that actually
  // validate the chain. Mirror that so a stale / placeholder
  // `sslrootcert=` doesn't blow up sslmode=require connections.
  const needsRootCert =
    sslMode === undefined ||
    sslMode === 'verify-ca' ||
    sslMode === 'verify-full';

  if (
    needsRootCert &&
    fileOpts.sslrootcert !== undefined &&
    fileOpts.sslrootcert !== ''
  ) {
    if (fileOpts.sslrootcert === 'system') {
      // `sslrootcert=system`: use the OS / OpenSSL trust store instead of a
      // file. libpq's OpenSSL build honours OpenSSL's $SSL_CERT_FILE (a single
      // bundle) and $SSL_CERT_DIR (a directory of hashed CA files); we read
      // both. With neither set, leaving `ca` unset makes Node fall back to its
      // built-in root store. `rejectUnauthorized` (set by the connection layer
      // for verify-* modes) is left intact.
      const systemCas: Buffer[] = [];
      const sslCertFile = process.env.SSL_CERT_FILE;
      if (sslCertFile !== undefined && sslCertFile !== '') {
        systemCas.push(
          await readPem('sslrootcert', sslCertFile, 'CERTIFICATE'),
        );
      }
      const sslCertDir = process.env.SSL_CERT_DIR;
      if (sslCertDir !== undefined && sslCertDir !== '') {
        systemCas.push(...(await readCaDir(sslCertDir)));
      }
      if (systemCas.length === 1) {
        merged.ca = systemCas[0];
      } else if (systemCas.length > 1) {
        merged.ca = systemCas;
      }
    } else {
      merged.ca = await readPem(
        'sslrootcert',
        fileOpts.sslrootcert,
        'CERTIFICATE',
      );
    }
  }
  // libpq `sslcertmode` gates whether the client cert/key are sent.
  //   - `disable`: skip loading them entirely, even when configured.
  //   - `require`: a cert MUST be configured (we only honour an explicit
  //     `sslcert`, not libpq's default `~/.postgresql/postgresql.crt`).
  //   - `allow` / unset: current behaviour (send when present).
  const certMode = fileOpts.sslcertmode ?? 'allow';
  const clientCert =
    fileOpts.sslcert !== undefined && fileOpts.sslcert !== ''
      ? fileOpts.sslcert
      : undefined;
  if (certMode === 'require' && clientCert === undefined) {
    throw new Error(
      `sslcertmode value "require" requires a client certificate`,
    );
  }
  if (certMode !== 'disable') {
    if (clientCert !== undefined) {
      merged.cert = await readPem('sslcert', clientCert, 'CERTIFICATE');
    }
    if (fileOpts.sslkey !== undefined && fileOpts.sslkey !== '') {
      await assertKeyPermissions(fileOpts.sslkey);
      merged.key = await readPem('sslkey', fileOpts.sslkey, 'PRIVATE KEY');
    }
  }
  // CRLs come from a single file (`sslcrl`) and/or every file in a directory
  // (`sslcrldir`). Node's `crl` option accepts an array of PEM buffers, so we
  // collect each source and only set `crl` when at least one was read.
  const crls: Buffer[] = [];
  if (fileOpts.sslcrl !== undefined && fileOpts.sslcrl !== '') {
    crls.push(await readPem('sslcrl', fileOpts.sslcrl));
  }
  if (fileOpts.sslcrldir !== undefined && fileOpts.sslcrldir !== '') {
    crls.push(...(await readCrlDir(fileOpts.sslcrldir)));
  }
  if (crls.length === 1) {
    merged.crl = crls[0];
  } else if (crls.length > 1) {
    merged.crl = crls;
  }
  // sslpassword is plumbed through verbatim — OpenSSL applies it when it
  // sees an encrypted key. Empty string is "no passphrase" (libpq's
  // convention) so we skip it.
  if (fileOpts.sslpassword !== undefined && fileOpts.sslpassword !== '') {
    merged.passphrase = fileOpts.sslpassword;
  }

  // sslkeylogfile is not a tls.connect option; the keylog listener is wired
  // in `upgradeToTls`. We pre-check it here (the home of file diagnostics)
  // by opening it for append, so an unwritable path fails fast at connect
  // time with `could not open sslkeylogfile "<path>": <reason>` rather than
  // silently dropping keys mid-handshake.
  if (fileOpts.sslkeylogfile !== undefined && fileOpts.sslkeylogfile !== '') {
    await assertKeyLogFileWritable(fileOpts.sslkeylogfile);
  }

  return merged;
}

/**
 * Pre-flight the `sslkeylogfile` target by opening it for append (creating
 * it if absent) and immediately closing the handle. Surfaces libpq-style
 * `could not open sslkeylogfile "<path>": <reason>` on any failure (e.g. an
 * unwritable directory) before the handshake starts.
 */
async function assertKeyLogFileWritable(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, 'a');
    await handle.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not open sslkeylogfile "${filePath}": ${reason}`);
  }
}

/**
 * PEM armor label for a DER blob that {@link readPem} auto-detected. libpq
 * accepts `sslcert`/`sslkey`/`sslrootcert` in either PEM or DER (binary) form
 * and sniffs the format; Node's `tls.connect` only understands PEM, so we
 * wrap a raw DER blob ourselves:
 *   - `'CERTIFICATE'` for certs and CA roots (`sslcert` / `sslrootcert`).
 *   - `'PRIVATE KEY'` for client keys (`sslkey`). A DER key is assumed to be
 *     PKCS#8 (`-----BEGIN PRIVATE KEY-----`), which is what `openssl pkcs8`
 *     and every modern key-export tool emits. Legacy bare PKCS#1 / SEC1 DER
 *     keys (rare) would need a different armor; libpq leans on OpenSSL's
 *     auto-detection there, which Node does not expose, so we document the
 *     PKCS#8 assumption rather than silently mislabel.
 */
type DerArmor = 'CERTIFICATE' | 'PRIVATE KEY';

/** True when the bytes already carry a `-----BEGIN ...-----` PEM header. */
function isPemArmored(bytes: Buffer): boolean {
  // A PEM file is ASCII text; scan a bounded prefix (skipping leading
  // whitespace libpq tolerates) for the armor marker. DER is binary and will
  // not contain this token at the front.
  const head = bytes.subarray(0, 64).toString('latin1');
  return head.includes('-----BEGIN');
}

/**
 * Wrap raw DER bytes in the requested PEM armor: base64 the DER, split into
 * 64-char lines (the PEM convention), and bracket with the BEGIN/END markers.
 */
function derToPem(der: Buffer, armor: DerArmor): Buffer {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  const body = lines.join('\n');
  const pem = `-----BEGIN ${armor}-----\n${body}\n-----END ${armor}-----\n`;
  return Buffer.from(pem, 'ascii');
}

/**
 * Read a libpq SSL file, returning PEM bytes ready for `tls.connect`. If the
 * file is already PEM-armored it's returned verbatim; otherwise it's treated
 * as DER and converted in-memory using {@link derToPem} with `derArmor`
 * (matching libpq's PEM-or-DER auto-detection). When `derArmor` is omitted the
 * file is returned as-is even if not PEM (used for CRLs, where DER conversion
 * is out of scope).
 */
async function readPem(
  label: string,
  filePath: string,
  derArmor?: DerArmor,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read ${label} "${filePath}": ${reason}`);
  }
  if (derArmor !== undefined && !isPemArmored(bytes)) {
    return derToPem(bytes, derArmor);
  }
  return bytes;
}

/**
 * libpq-style permission guard for the client private key (`sslkey`). libpq
 * (`fe-secure-openssl.c`) `stat()`s the key file and refuses to load it when
 * it is a regular file with any group or world access bits set, unless it is
 * root-owned with at most `u=rw,g=r` (0640). Mirroring that keeps an
 * accidentally world-readable key from being used silently.
 *
 * The check is a no-op on Windows, where the POSIX mode bits are not
 * meaningful (matching libpq, which `#ifndef WIN32`-guards the same check),
 * and when the key path is a directory / special file (only regular files
 * carry a private key here).
 */
async function assertKeyPermissions(keyPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(keyPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read sslkey "${keyPath}": ${reason}`);
  }
  if (!stat.isFile()) return;
  // Low 9 mode bits: rwx for user/group/other.
  const mode = stat.mode & 0o777;
  const groupOrWorld = mode & 0o077;
  if (groupOrWorld === 0) return;
  // Root-owned keys are allowed to be u=rw,g=r (0640) or less, matching
  // libpq's relaxed allowance for system-managed keys: no bits outside the
  // 0640 mask may be set.
  if (stat.uid === 0 && (mode & ~0o640) === 0) {
    return;
  }
  throw new Error(`private key file "${keyPath}" has group or world access`);
}

/**
 * Read every regular file in an `sslcrldir` directory and return their PEM
 * bytes. Subdirectories are skipped (libpq's c_rehash-style directory only
 * holds hashed CRL files). A failure to list the directory or read any file
 * surfaces with the `sslcrldir` label so the caller sees which option was
 * misconfigured.
 */
async function readCrlDir(dirPath: string): Promise<Buffer[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read sslcrldir "${dirPath}": ${reason}`);
  }
  const out: Buffer[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    out.push(await readPem('sslcrldir', path.join(dirPath, entry.name)));
  }
  return out;
}

/**
 * Read every regular file in an OpenSSL `$SSL_CERT_DIR` (the hashed-dir
 * convention honoured by `sslrootcert=system`) and return their PEM bytes.
 * Mirrors {@link readCrlDir}: subdirectories are skipped and a DER-format
 * file is auto-converted to PEM. A failure to list the directory or read any
 * file surfaces as `could not read SSL_CERT_DIR "<path>": <reason>`.
 *
 * Exported for tests.
 */
export async function readCaDir(dirPath: string): Promise<Buffer[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read SSL_CERT_DIR "${dirPath}": ${reason}`);
  }
  const out: Buffer[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    out.push(
      await readPem(
        'SSL_CERT_DIR',
        path.join(dirPath, entry.name),
        'CERTIFICATE',
      ),
    );
  }
  return out;
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

/**
 * Translate a Node/OpenSSL TLS handshake error into libpq-style wording so
 * our diagnostics match upstream psql/libpq exactly (the cases asserted by
 * upstream `001_ssltests.pl`). Unrecognised errors pass through unchanged.
 * The original error is preserved on `cause` for callers that introspect.
 *
 *   - Chain-verification failures (`ERR_TLS_CERT_ALTNAME_INVALID` excluded)
 *     → `certificate verify failed` (libpq's `SSL error: certificate verify
 *     failed`).
 *   - Hostname mismatch (`ERR_TLS_CERT_ALTNAME_INVALID`, Node's
 *     "Hostname/IP does not match certificate's altnames") →
 *     `server certificate for "<host>" does not match host name "<host>"`.
 *   - Encrypted-key decrypt failures (`ERR_OSSL_BAD_DECRYPT`, or an OpenSSL
 *     message containing `bad decrypt`) → libpq's
 *     `could not load private key file "<path>": <openssl text>` shape. The
 *     raw OpenSSL text (which carries the `bad decrypt` token upstream's
 *     `001_ssltests.pl` matches on) is preserved in the message tail. When the
 *     key path is unknown the path segment is omitted but the `bad decrypt`
 *     token is still surfaced.
 *
 * `keyPath`, when supplied, is the configured `sslkey` path — used only to
 * fill libpq's `private key file "<path>"` phrasing on a decrypt failure.
 *
 * Exported for unit tests.
 */
export function mapTlsHandshakeError(
  err: Error,
  servername?: string,
  keyPath?: string,
): Error {
  const code = (err as NodeJS.ErrnoException).code;
  const msg = err.message;

  // Encrypted client-key decrypt failure (wrong / missing `sslpassword`).
  // OpenSSL throws this synchronously out of `tls.connect`; reshape it to
  // libpq's `could not load private key file "<path>": ... bad decrypt`.
  if (code === 'ERR_OSSL_BAD_DECRYPT' || /bad decrypt/i.test(msg)) {
    const where =
      keyPath !== undefined && keyPath !== ''
        ? `private key file "${keyPath}"`
        : 'private key file';
    const mapped = new Error(`could not load ${where}: ${msg}`);
    (mapped as Error & { cause?: unknown }).cause = err;
    return mapped;
  }

  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    const host = servername ?? '';
    const mapped = new Error(
      `server certificate for "${host}" does not match host name "${host}"`,
    );
    (mapped as Error & { cause?: unknown }).cause = err;
    return mapped;
  }

  // OpenSSL chain-verification failures surface with a `code` like
  // `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `DEPTH_ZERO_SELF_SIGNED_CERT`,
  // `SELF_SIGNED_CERT_IN_CHAIN`, `CERT_HAS_EXPIRED`, etc. libpq collapses
  // them all to `certificate verify failed`.
  const isVerifyFailure =
    code !== undefined &&
    code !== 'ERR_TLS_CERT_ALTNAME_INVALID' &&
    /CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO|CHAIN|EXPIRED|NOT_YET_VALID|INVALID_CA/.test(
      code,
    );
  if (isVerifyFailure || /certificate verify failed/i.test(msg)) {
    const mapped = new Error('certificate verify failed');
    (mapped as Error & { cause?: unknown }).cause = err;
    return mapped;
  }

  return err;
}

/** Pull the SNI `servername` from the TLS options for error messages. */
function getServername(tlsOpts: tls.ConnectionOptions): string | undefined {
  return typeof tlsOpts.servername === 'string'
    ? tlsOpts.servername
    : undefined;
}

function upgradeToTls(
  socket: net.Socket,
  tlsOpts: tls.ConnectionOptions,
  sslkeylogfile?: string,
  keyPath?: string,
): Promise<TlsResult> {
  return new Promise((resolve, reject) => {
    let tlsSocket: tls.TLSSocket | undefined;
    const cleanup = (): void => {
      tlsSocket?.removeListener('error', onError);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(mapTlsHandshakeError(err, getServername(tlsOpts), keyPath));
    };
    // OpenSSL surfaces an un-decryptable client key (wrong / missing
    // `sslpassword`) by throwing synchronously out of `tls.connect` rather
    // than emitting `'error'`. Catch it here so it flows through the same
    // libpq-wording mapper as asynchronous handshake failures.
    try {
      tlsSocket = tls.connect(
        {
          ...tlsOpts,
          socket,
        },
        () => {
          cleanup();
          // `tlsSocket` is always assigned by the time this async handshake
          // callback fires (tls.connect returns it synchronously above); the
          // guard simply narrows the `| undefined` for the type checker.
          const established = tlsSocket;
          if (established === undefined) return;
          let channelBindingData: Buffer | null = null;
          try {
            // Prefer the modern X509Certificate API (Node 15.6+): it returns a
            // proper `X509Certificate` instance whose `.raw` is the
            // DER-encoded cert. Falls back to the legacy
            // `getPeerCertificate(true)` for compatibility.
            const x509 = (
              established as unknown as {
                getPeerX509Certificate?: () => { raw: Buffer } | undefined;
              }
            ).getPeerX509Certificate?.();
            if (x509?.raw && x509.raw.length > 0) {
              channelBindingData = createHash('sha256')
                .update(x509.raw)
                .digest();
            } else {
              // `detailed = true` gets us the full peer cert chain. Some
              // Node/OpenSSL combinations leave `.raw` undefined on the legacy
              // API when `rejectUnauthorized: false`; in that case we have to
              // accept that channel binding is unavailable.
              const peerCert = established.getPeerCertificate(true);
              if (peerCert?.raw && peerCert.raw.length > 0) {
                channelBindingData = computeChannelBindingData(peerCert);
              }
            }
          } catch {
            // Best-effort: a missing peer cert => no channel binding. SASL
            // path will fall back to SCRAM-SHA-256 (non-PLUS).
            channelBindingData = null;
          }
          resolve({ kind: 'tls', socket: established, channelBindingData });
        },
      );
    } catch (err) {
      reject(
        mapTlsHandshakeError(
          err instanceof Error ? err : new Error(String(err)),
          getServername(tlsOpts),
          keyPath,
        ),
      );
      return;
    }
    tlsSocket.on('error', onError);

    // libpq `sslkeylogfile`: append each emitted key-log line so the
    // handshake can be decrypted offline. The path was pre-checked for
    // writability in loadTlsFileOptions.
    if (sslkeylogfile !== undefined && sslkeylogfile !== '') {
      attachKeyLogListener(tlsSocket, sslkeylogfile);
    }
  });
}

/**
 * Wire a TLSSocket's `'keylog'` event to append each emitted key-log line to
 * `filePath`. Node emits one already-newline-terminated Buffer per event. A
 * write that fails after the pre-check (e.g. the directory was removed
 * mid-session) is re-emitted as a socket `'error'` rather than crashing the
 * process.
 *
 * Accepts a minimal event-emitter shape so it can be unit-tested against a
 * fake socket without a real TLS handshake. Exported for tests.
 */
export function attachKeyLogListener(
  socket: {
    on: (event: 'keylog', listener: (line: Buffer) => void) => unknown;
    emit: (event: 'error', err: Error) => unknown;
  },
  filePath: string,
): void {
  socket.on('keylog', (line: Buffer) => {
    try {
      appendFileSync(filePath, line);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  });
}
