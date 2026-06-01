// Opt-in TLS-enabled Postgres fixture for the conformance harness.
//
// This is a sibling of `pg-fixture.ts` that boots a separate postgres
// container with `ssl=on` and a minted cert chain (root CA → server CA /
// client CA → server/client leaf certs). It is consumed by both
// `tap/001_ssltests.spec.ts` (which exercises the cert vault directly) and
// `tap/005_negotiate_encryption.spec.ts` (which only cares about the
// happy-path `host`/`hostssl`/`hostnossl` rules).
//
// Each call to `setupTlsPg()` boots a fresh container (no caching across
// tests) because the negotiation / cert-switch tests need to toggle server
// state by reaching for a different fixture instance. `teardownTlsPg()`
// stops the container and frees the tmp dir.
//
// The fixture lays down a custom `pg_hba.conf` so the suite can exercise
// the upstream `hostssl` / `hostnossl` / `host` rules plus the `cert`
// authentication method (`clientcert=verify-full` / `verify-ca`). Five
// users are pre-created in the init script:
//
//   - `testuser`   — `host all testuser ...` (default, plaintext or SSL)
//   - `ssluser`    — `hostssl all ssluser ...` (TLS required)
//   - `nossluser`  — `hostnossl all nossluser ...` (TLS forbidden)
//   - `ssltestuser` / `anotheruser` — used by the cert-auth subtests; only
//     reachable via a matching client certificate under the `cert` HBA
//     rules.
//
// Cert chain generation: we shell out to `openssl` rather than implement
// X.509 encoding in Node. The {@link CertVault} class owns the workflow:
// mint a self-signed root CA, mint server / client intermediate CAs signed
// by the root, then mint individual leaf certs with assorted CN / SAN
// shapes. Accessors expose the absolute file paths to the spec.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log } from './util-log.js';

export type TlsPgConn = {
  host: string;
  port: number;
  db: string;
  /**
   * Default `testuser` (host all all trust). Other usernames
   * (`ssluser`, `nossluser`, `ssltestuser`, `anotheruser`) are created at
   * startup and have different HBA rules — use them by overriding `user`
   * on the {@link PgConnection.connect} options.
   */
  user: string;
  password: string;
  /**
   * Path to the *active* server cert on the host filesystem (initially the
   * CN-and-SAN variant). Preserved for backward compatibility with the 005
   * spec which uses this as the self-signed root for `sslrootcert`.
   */
  serverCertPath: string;
  /** Path to the active server private key on the host filesystem. */
  serverKeyPath: string;
  /** Working directory used for cert generation; cleaned up on teardown. */
  workDir: string;
  /**
   * Full cert vault. Cert vault accessors expose the individual leaf
   * certs minted by {@link CertVault}; the 001 spec drives the cert-shape
   * subtests through this. Always present.
   */
  vault: CertVault;
};

type StoppableContainer = { stop(): Promise<unknown> };

let containerRef: StoppableContainer | null = null;
let workDirRef: string | null = null;

const PG_IMAGE_DEFAULT = 'postgres:18.0';

// ---------------------------------------------------------------------------
// CertVault — openssl-driven mint workflow for the upstream-style cert tree.
//
// Layout (paths returned by the accessors are absolute):
//
//   root_ca.crt                 self-signed Test CA Root
//   server_ca.crt               signed by root_ca, "Test Server CA"
//   client_ca.crt               signed by root_ca, "Test Client CA"
//   root+server_ca.crt          root_ca || server_ca (PEM bundle the spec
//                               passes as sslrootcert for verify-ca/full)
//   root+client_ca.crt          root_ca || client_ca (server-side
//                               ssl_ca_file for cert auth)
//   server-cn-only.crt          CN=localhost (no SAN) — verify-full fails
//   server-cn-and-san.crt       CN=localhost, SAN DNS:localhost +
//                               DNS:127.0.0.1 + DNS:*.localhost (the
//                               active default — used by 005)
//   server-san-only.crt         no CN, SAN DNS:localhost
//   server-ip-in-san.crt        SAN IP:127.0.0.1
//   server-multi-name.crt       SAN DNS:dns1.localhost +
//                               DNS:dns2.localhost +
//                               DNS:*.wildcard.localhost
//   client-ssltestuser.crt      CN=ssltestuser, signed by client_ca
//   client-anotheruser.crt      CN=anotheruser, signed by client_ca
//   client-ssltestuser-enc.key  same key as ssltestuser but encrypted
//                               with passphrase "testpw" (PKCS#8 AES-256)
//
// The "switch server cert" workflow is handled by the spec via ALTER
// SYSTEM + pg_reload_conf — see {@link CertVault.switchServerCert} which
// returns the SQL fragment the spec must run.
// ---------------------------------------------------------------------------

/** Identifier for a server cert that the spec can mount onto the server. */
export type ServerCertName =
  | 'cn-only'
  | 'cn-and-san'
  | 'san-only'
  | 'ip-in-san'
  | 'multi-name'
  /**
   * RSA-PSS keyed leaf, signed by the (RSA-PKCS1) server CA. Exists so
   * the 002_scram spec can verify that SCRAM-SHA-256-PLUS channel
   * binding works against a server presenting an `rsassaPss`-signed
   * certificate (upstream bug #17760 + the `HAVE_X509_GET_SIGNATURE_INFO`
   * branch in libpq). SAN matches `cn-and-san` so verify-full works.
   */
  | 'pss';

/** Identifier for a client cert the spec can pass via sslcert/sslkey. */
export type ClientCertName = 'ssltestuser' | 'anotheruser';

/**
 * Container-side paths the server reads its TLS material from. The init
 * shell script preloads these as <PGDATA>/server.crt and <PGDATA>/server.key
 * (and copies the client CA into PGDATA so `ssl_ca_file` can validate
 * client certs). Switching cert at runtime is done by `ALTER SYSTEM SET
 * ssl_cert_file = '<other.crt>'` + pg_reload_conf().
 */
const SERVER_CERT_TARGET_DIR = '/etc/postgresql-tls';

/**
 * In-container path the server reads to validate client certificates.
 * Populated by `ssl_ca_file` in postgresql.conf. Generated by the init
 * script from the host-side `root+client_ca.crt`.
 */
const CLIENT_CA_CONTAINER_PATH = '/etc/postgresql-tls/client-ca.crt';

/**
 * Manage the cert tree for the TLS fixture. One instance owns a tmp
 * directory; calling {@link mint} writes the full cert tree there. The
 * spec then reads files via the accessors (or by joining workDir/<name>).
 */
export class CertVault {
  public readonly workDir: string;

  private readonly serverCerts = new Map<
    ServerCertName,
    { cert: string; key: string }
  >();
  private readonly clientCerts = new Map<
    ClientCertName,
    { cert: string; key: string; encryptedKey?: string }
  >();
  private rootCaCertPath: string | null = null;
  private serverCaCertPath: string | null = null;
  private clientCaCertPath: string | null = null;
  private bundleRootServerPath: string | null = null;
  private bundleRootClientPath: string | null = null;
  private serverCrlPath: string | null = null;

  public constructor(workDir: string) {
    this.workDir = workDir;
  }

  /** Mint every cert in the vault. Idempotent — calling twice overwrites. */
  public mint(): void {
    // 1. Root CA — self-signed.
    const rootKey = this.path('root_ca.key');
    const rootCert = this.path('root_ca.crt');
    runOpenssl([
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-keyout',
      rootKey,
      '-out',
      rootCert,
      '-days',
      '30',
      '-subj',
      '/CN=Test CA Root',
    ]);
    this.rootCaCertPath = rootCert;

    // 2. Server CA — signed by the root.
    const serverCaCert = this.signCa('server_ca', 'Test Server CA');
    this.serverCaCertPath = serverCaCert;

    // 3. Client CA — signed by the root.
    const clientCaCert = this.signCa('client_ca', 'Test Client CA');
    this.clientCaCertPath = clientCaCert;

    // 4. PEM bundles — `root+server_ca.crt` is what the client passes as
    // `sslrootcert` for verify-ca/full; `root+client_ca.crt` is what the
    // server reads via `ssl_ca_file` to validate incoming client certs.
    this.bundleRootServerPath = this.path('root+server_ca.crt');
    writeFileSync(
      this.bundleRootServerPath,
      readUtf8(rootCert) + '\n' + readUtf8(serverCaCert),
    );
    this.bundleRootClientPath = this.path('root+client_ca.crt');
    writeFileSync(
      this.bundleRootClientPath,
      readUtf8(rootCert) + '\n' + readUtf8(clientCaCert),
    );

    // 5. Server leaf certs — signed by the server CA.
    this.mintServerCert('cn-only', '/CN=localhost', []);
    this.mintServerCert('cn-and-san', '/CN=localhost', [
      'DNS:localhost',
      'DNS:127.0.0.1',
      'DNS:*.localhost',
    ]);
    this.mintServerCert('san-only', '/CN=server-with-no-cn', ['DNS:localhost']);
    this.mintServerCert('ip-in-san', '/CN=server-ip', ['IP:127.0.0.1']);
    this.mintServerCert('multi-name', '/CN=server-multi', [
      'DNS:dns1.localhost',
      'DNS:dns2.localhost',
      'DNS:*.wildcard.localhost',
    ]);
    this.mintRsaPssServerCert();

    // 6. Client leaf certs — signed by the client CA.
    this.mintClientCert('ssltestuser', '/CN=ssltestuser');
    this.mintClientCert('anotheruser', '/CN=anotheruser');

    // 7. Encrypted variant of ssltestuser's key. PKCS#8 AES-256, passphrase
    // "testpw". We don't keep the unencrypted key path under a different
    // name — the spec passes the *encrypted* key as sslkey + sslpassword
    // to exercise the wire-layer passphrase path.
    const userCert = this.clientCerts.get('ssltestuser');
    if (!userCert) throw new Error('CertVault: ssltestuser was not minted');
    const encryptedKey = this.path('client-ssltestuser-encrypted.key');
    runOpenssl([
      'pkcs8',
      '-topk8',
      '-in',
      userCert.key,
      '-out',
      encryptedKey,
      '-passout',
      'pass:testpw',
      '-v2',
      'aes-256-cbc',
    ]);
    userCert.encryptedKey = encryptedKey;

    // 8. A CRL signed by the server CA that revokes the active server leaf
    // cert (cn-and-san). The client passes this via `sslcrl` to prove that
    // a revoked server certificate is rejected at verify time.
    this.mintServerCrl();
  }

  /**
   * Generate a CRL signed by the server CA that lists the active server
   * leaf cert (`cn-and-san`) as revoked. Uses the `openssl ca -gencrl`
   * workflow, which needs a tiny CA database (index + crlnumber) and a
   * config naming the issuing cert/key. Stored at `server_ca.crl`.
   */
  private mintServerCrl(): void {
    if (!this.serverCaCertPath) throw new Error('CertVault: server CA missing');
    const serverLeaf = this.serverCerts.get('cn-and-san');
    if (!serverLeaf) throw new Error('CertVault: cn-and-san cert not minted');

    const indexPath = this.path('crl-index.txt');
    const crlNumberPath = this.path('crl-number.txt');
    const serialPath = this.path('crl-serial.txt');
    const configPath = this.path('crl-ca.cnf');
    const crlPath = this.path('server_ca.crl');

    writeFileSync(indexPath, '');
    writeFileSync(crlNumberPath, '1000\n');
    writeFileSync(serialPath, '1000\n');
    // Minimal `openssl ca` config: just enough for -revoke and -gencrl.
    writeFileSync(
      configPath,
      [
        '[ca]',
        'default_ca = CA_default',
        '',
        '[CA_default]',
        `dir = ${this.workDir}`,
        `database = ${indexPath}`,
        `crlnumber = ${crlNumberPath}`,
        `serial = ${serialPath}`,
        `new_certs_dir = ${this.workDir}`,
        `certificate = ${this.serverCaCertPath}`,
        `private_key = ${this.path('server_ca.key')}`,
        'default_md = sha256',
        'default_crl_days = 30',
        'default_days = 30',
        'policy = policy_any',
        '',
        '[policy_any]',
        'commonName = optional',
        'countryName = optional',
        'stateOrProvinceName = optional',
        'organizationName = optional',
        'organizationalUnitName = optional',
      ].join('\n') + '\n',
    );

    // Mark the server leaf revoked in the CA database, then emit the CRL.
    runOpenssl(['ca', '-config', configPath, '-revoke', serverLeaf.cert]);
    runOpenssl(['ca', '-config', configPath, '-gencrl', '-out', crlPath]);
    this.serverCrlPath = crlPath;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  public getRootCa(): string {
    if (!this.rootCaCertPath) throw new Error('CertVault: not minted');
    return this.rootCaCertPath;
  }
  public getServerCa(): string {
    if (!this.serverCaCertPath) throw new Error('CertVault: not minted');
    return this.serverCaCertPath;
  }
  public getClientCa(): string {
    if (!this.clientCaCertPath) throw new Error('CertVault: not minted');
    return this.clientCaCertPath;
  }
  /** PEM bundle of root_ca + server_ca — the spec's `sslrootcert`. */
  public getRootServerBundle(): string {
    if (!this.bundleRootServerPath) throw new Error('CertVault: not minted');
    return this.bundleRootServerPath;
  }
  /** CRL (signed by server CA) revoking the active `cn-and-san` server cert. */
  public getServerCrl(): string {
    if (!this.serverCrlPath) throw new Error('CertVault: CRL not minted');
    return this.serverCrlPath;
  }
  /** PEM bundle of root_ca + client_ca — the server's `ssl_ca_file`. */
  public getRootClientBundle(): string {
    if (!this.bundleRootClientPath) throw new Error('CertVault: not minted');
    return this.bundleRootClientPath;
  }
  public getServerCert(name: ServerCertName): { cert: string; key: string } {
    const entry = this.serverCerts.get(name);
    if (!entry) throw new Error(`CertVault: server cert "${name}" not minted`);
    return entry;
  }
  public getClientCert(name: ClientCertName): {
    cert: string;
    key: string;
    /** Encrypted variant if minted (only for `ssltestuser`). */
    encryptedKey?: string;
  } {
    const entry = this.clientCerts.get(name);
    if (!entry) throw new Error(`CertVault: client cert "${name}" not minted`);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Resolve a filename relative to {@link workDir}. */
  private path(name: string): string {
    return join(this.workDir, name);
  }

  /**
   * Mint a CA cert signed by the root: generate a CSR, then x509 -req
   * against the root with the v3_ca extension so the cert is usable as a
   * signer. Returns the absolute path to the produced cert.
   */
  private signCa(slug: string, cn: string): string {
    const csr = this.path(`${slug}.csr`);
    const key = this.path(`${slug}.key`);
    const cert = this.path(`${slug}.crt`);
    runOpenssl([
      'req',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      `/CN=${cn}`,
    ]);
    const ext = this.path(`${slug}.ext`);
    writeFileSync(
      ext,
      [
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        'keyUsage=critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid,issuer',
      ].join('\n') + '\n',
    );
    runOpenssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      this.getRootCa(),
      '-CAkey',
      this.path('root_ca.key'),
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '30',
      '-extfile',
      ext,
    ]);
    return cert;
  }

  /**
   * Mint a server leaf cert signed by the server CA. `sanEntries` is a
   * list of openssl-style entries like `'DNS:localhost'` /
   * `'IP:127.0.0.1'`. Empty list means "no SAN extension".
   */
  private mintServerCert(
    name: ServerCertName,
    subj: string,
    sanEntries: string[],
  ): void {
    const slug = `server-${name}`;
    const key = this.path(`${slug}.key`);
    const csr = this.path(`${slug}.csr`);
    const cert = this.path(`${slug}.crt`);
    runOpenssl([
      'req',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      subj,
    ]);
    const ext = this.path(`${slug}.ext`);
    const extLines = [
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
    ];
    if (sanEntries.length > 0) {
      extLines.push(`subjectAltName=${sanEntries.join(',')}`);
    }
    writeFileSync(ext, extLines.join('\n') + '\n');
    if (!this.serverCaCertPath) throw new Error('CertVault: server CA missing');
    runOpenssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      this.serverCaCertPath,
      '-CAkey',
      this.path('server_ca.key'),
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '30',
      '-extfile',
      ext,
    ]);
    this.serverCerts.set(name, { cert, key });
  }

  /**
   * Mint an RSA-PSS keyed server leaf cert (`rsassaPss` signature algorithm
   * on the public key — the issuing CA still uses RSA-PKCS1, which is a
   * valid X.509 mix). Used by 002_scram to verify that SCRAM-SHA-256-PLUS
   * channel binding works against an RSA-PSS server certificate.
   *
   * Key generation uses `openssl genpkey` because `openssl req -newkey
   * rsa-pss` exists but is finicky about pkeyopt parsing across versions
   * (and silently falls back to RSA-PKCS1 on older OpenSSL builds). A
   * separate keygen step is explicit and portable.
   *
   * SAN matches `cn-and-san` so the cert satisfies `sslmode=verify-full`.
   */
  private mintRsaPssServerCert(): void {
    const slug = 'server-pss';
    const key = this.path(`${slug}.key`);
    const csr = this.path(`${slug}.csr`);
    const cert = this.path(`${slug}.crt`);

    // 1. Generate an RSA-PSS keypair. `rsa_pss_keygen_md:sha256` pins the
    // permitted digest so the cert's signature algorithm is rsassaPss
    // with SHA-256 — the exact shape libpq's HAVE_X509_GET_SIGNATURE_INFO
    // path expects to detect for channel-binding hash selection.
    runOpenssl([
      'genpkey',
      '-algorithm',
      'rsa-pss',
      '-pkeyopt',
      'rsa_keygen_bits:2048',
      '-pkeyopt',
      'rsa_pss_keygen_md:sha256',
      '-pkeyopt',
      'rsa_pss_keygen_saltlen:32',
      '-out',
      key,
    ]);

    // 2. Build a CSR against the RSA-PSS key. The signature on the CSR
    // itself will be rsassaPss (since the key is rsa-pss); openssl picks
    // the digest from `rsa_pss_keygen_md`.
    runOpenssl([
      'req',
      '-new',
      '-key',
      key,
      '-out',
      csr,
      '-subj',
      '/CN=localhost',
    ]);

    // 3. Sign the CSR with the existing server CA (still RSA-PKCS1).
    // The resulting cert has an rsassaPss SubjectPublicKeyInfo but its
    // issuer-signature uses the CA's signature algorithm — that's a
    // valid X.509 mix and matches the upstream test fixture's setup.
    const ext = this.path(`${slug}.ext`);
    writeFileSync(
      ext,
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid,issuer',
        'subjectAltName=DNS:localhost,DNS:127.0.0.1,DNS:*.localhost',
      ].join('\n') + '\n',
    );
    if (!this.serverCaCertPath) throw new Error('CertVault: server CA missing');
    runOpenssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      this.serverCaCertPath,
      '-CAkey',
      this.path('server_ca.key'),
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '30',
      '-extfile',
      ext,
    ]);
    this.serverCerts.set('pss', { cert, key });
  }

  /** Mint a client leaf cert signed by the client CA. */
  private mintClientCert(name: ClientCertName, subj: string): void {
    const slug = `client-${name}`;
    const key = this.path(`${slug}.key`);
    const csr = this.path(`${slug}.csr`);
    const cert = this.path(`${slug}.crt`);
    runOpenssl([
      'req',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      subj,
    ]);
    const ext = this.path(`${slug}.ext`);
    writeFileSync(
      ext,
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=clientAuth',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid,issuer',
      ].join('\n') + '\n',
    );
    if (!this.clientCaCertPath) throw new Error('CertVault: client CA missing');
    runOpenssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      this.clientCaCertPath,
      '-CAkey',
      this.path('client_ca.key'),
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '30',
      '-extfile',
      ext,
    ]);
    this.clientCerts.set(name, { cert, key });
  }
}

function runOpenssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'pipe' });
}

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Generate a single self-signed RSA-2048 cert + key in `workDir`. Kept as
 * a named export for backward compat with the original fixture API. The
 * extended {@link CertVault} now generates a full chain in addition to
 * this helper, but the export shape is unchanged.
 *
 * Uses the host's `openssl` CLI; throws if `openssl` is not on PATH. The
 * spec is expected to detect this up-front and `it.skip` the suite when
 * the dependency is missing.
 */
export function generateSelfSignedCert(workDir: string): {
  certPath: string;
  keyPath: string;
} {
  const keyPath = join(workDir, 'server.key');
  const certPath = join(workDir, 'server.crt');
  runOpenssl([
    'req',
    '-x509',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '30',
    '-subj',
    '/CN=localhost',
  ]);
  return { certPath, keyPath };
}

/**
 * Init script that we drop into `/docker-entrypoint-initdb.d/`. The
 * postgres entrypoint runs every `.sql` file there after the cluster is
 * initialised but BEFORE the server starts accepting client traffic — so
 * the `CREATE USER` + `pg_hba.conf` rewrite are applied before the first
 * test connection.
 */
const INIT_SQL = `
-- Negotiation + cert-auth suite users. The pg_hba.conf rules below select
-- between them based on the negotiated transport (host = any; hostssl =
-- TLS only; hostnossl = plaintext only) and the cert HBA method.
CREATE USER testuser;
CREATE USER ssluser;
CREATE USER nossluser;
CREATE USER ssltestuser;
CREATE USER anotheruser;
-- Target of the pg_ident.conf "certmap" mapping: a client presenting the
-- ssltestuser cert (CN=ssltestuser) may authenticate AS mappeduser.
CREATE USER mappeduser;

-- Password-auth users for the 002_scram suite. The cluster default
-- \`password_encryption\` is scram-sha-256 (PG 14+), so the SCRAM user
-- ends up with a SCRAM verifier; we explicitly flip the GUC to 'md5'
-- around the md5user's CREATE so it gets an MD5-hashed password
-- instead. Both share the same plaintext to keep the spec simple.
SET password_encryption = 'scram-sha-256';
CREATE USER scramuser WITH PASSWORD 'pencil';
SET password_encryption = 'md5';
CREATE USER md5user WITH PASSWORD 'pencil';
RESET password_encryption;
`;

/**
 * pg_hba.conf used by the TLS suite. Order matters — postgres scans the
 * file top-down and uses the FIRST matching rule.
 *
 *   - ssluser:      only `hostssl` matches (plaintext rejected at the
 *                   rule level with "no pg_hba.conf entry"). SSL trust.
 *   - nossluser:    only `hostnossl` matches.
 *   - ssltestuser:  `hostssl … cert clientcert=verify-full` — the
 *                   `cert` HBA method validates the client cert chain
 *                   AND requires the cert's CN to equal the username.
 *                   PG 18 rejects `cert clientcert=verify-ca` outright
 *                   (the `cert` method already implies chain validation,
 *                   so `verify-ca` would be redundant). For verify-ca
 *                   semantics — "validate the chain but accept any CN"
 *                   — we use `trust clientcert=verify-ca` instead, which
 *                   requires the chain via TLS but skips the
 *                   user-mapping pass.
 *   - anotheruser:  `hostssl … trust clientcert=verify-ca` — a valid
 *                   client cert chain is required (the TLS handshake
 *                   verifies it via ssl_ca_file) but the cert CN need
 *                   not match the username. Used by the cert-CN-mismatch
 *                   subtest.
 *   - testuser:     `host` matches both encryptions (trust).
 *   - The default superuser (`test` from POSTGRES_USER) keeps `local` +
 *     a `host all all` catch-all so the entrypoint's bootstrap continues
 *     to work AND so adminExec() can reach the cluster from the spec.
 *
 * IMPORTANT: the trailing `host all all 0.0.0.0/0 trust` rule MUST come
 * AFTER the user-specific `hostssl` / `hostnossl` rules — otherwise it
 * would catch ssluser / nossluser before their narrower rules fire and
 * the suite would silently misreport pass/fail.
 */
const HBA_CONF = `
# pg-fixture-tls.ts HBA — see harness/pg-fixture-tls.ts.
# Order is significant: first matching rule wins.
# TYPE         DATABASE  USER         ADDRESS         METHOD
hostssl        all       ssluser      0.0.0.0/0       trust
hostssl        all       ssluser      ::/0            trust
hostnossl      all       nossluser    0.0.0.0/0       trust
hostnossl      all       nossluser    ::/0            trust
# Cert-based authentication for the 001 spec. The cert HBA method
# validates the client cert chain AND checks CN==username (verify-full).
# For chain-only auth (libpq verify-ca semantics) we use the trust
# method with the clientcert=verify-ca option, which requires the cert
# chain at the TLS layer but does not run the user-mapping pass.
hostssl        all       ssltestuser  0.0.0.0/0       cert clientcert=verify-full
hostssl        all       ssltestuser  ::/0            cert clientcert=verify-full
hostssl        all       anotheruser  0.0.0.0/0       trust clientcert=verify-ca
hostssl        all       anotheruser  ::/0            trust clientcert=verify-ca
# Cert auth with a pg_ident.conf username map: the cert's CN (the system
# name) is mapped to the requested PG role via map=certmap. mappeduser is
# reachable by presenting the ssltestuser cert (CN=ssltestuser).
hostssl        all       mappeduser   0.0.0.0/0       cert clientcert=verify-full map=certmap
hostssl        all       mappeduser   ::/0            cert clientcert=verify-full map=certmap
# Password-auth users for the 002_scram suite. Both are TLS-only so
# the auth flow exercises SCRAM channel binding when channel_binding
# is requested. The methods are per-user (not catch-all) so plaintext
# transport falls through to a "no pg_hba.conf entry" rejection,
# preserving the contract that 002_scram only tests TLS-mediated auth.
hostssl        all       scramuser    0.0.0.0/0       scram-sha-256
hostssl        all       scramuser    ::/0            scram-sha-256
hostssl        all       md5user      0.0.0.0/0       md5
hostssl        all       md5user      ::/0            md5
host           all       testuser     0.0.0.0/0       trust
host           all       testuser     ::/0            trust
# Default rules for the testcontainers superuser ("test" by default;
# both md5 and trust are accepted so the entrypoint bootstrap and the
# spec's adminExec helper both work).
local          all       all                          trust
host           all       test         0.0.0.0/0       trust
host           all       test         ::/0            trust
`;

/** In-container target for the *initially active* server cert. */
const ACTIVE_CERT_TARGET = '/etc/postgresql-tls/server.crt';
/** In-container target for the *initially active* server key. */
const ACTIVE_KEY_TARGET = '/etc/postgresql-tls/server.key';

/**
 * Init script that rewrites pg_hba.conf with the suite's ruleset AND
 * enables SSL via postgresql.conf (NOT via the postmaster command line,
 * which would prevent `ALTER SYSTEM SET ssl=off` from taking effect at
 * runtime).
 *
 * Why a `.sh` init script and not `.sql`?
 *   - pg_hba.conf is a filesystem rewrite, not a SQL command.
 *   - The key file needs to be chowned to the postgres user and
 *     chmodded to 0600 before postgres will accept it (or postgres
 *     refuses to start with `permissions are too liberal`).
 *
 * The script:
 *   1. Copies every bind-mounted server cert + key into PGDATA so the
 *      file owner is the postgres user (avoids permission issues with
 *      bind-mounted host files owned by root). Names mirror the host:
 *        server-cn-only.crt   →  $PGDATA/server-cn-only.crt
 *        server-cn-and-san.crt → $PGDATA/server-cn-and-san.crt
 *        … and so on.
 *      Also copies the active cert/key as `server.crt` / `server.key`,
 *      which postgresql.conf points at by default. Switching at runtime
 *      is done via `ALTER SYSTEM SET ssl_cert_file = '<alt.crt>'` +
 *      pg_reload_conf().
 *   2. Sets restrictive perms on every key (0600).
 *   3. Copies the client-CA bundle into PGDATA so `ssl_ca_file` can
 *      validate the certs presented by clients with the `cert` HBA method.
 *   4. Appends `ssl=on` + `ssl_cert_file=` + `ssl_key_file=` +
 *      `ssl_ca_file=` to postgresql.conf.
 *   5. Rewrites pg_hba.conf with the suite's ruleset.
 *
 * The init script runs after `initdb` and BEFORE the server starts
 * accepting client connections, so all of this is in place by the time
 * the harness opens its first connection.
 */
const HBA_INIT_SH = `#!/bin/sh
set -eu

# Copy every bind-mounted .crt / .key under ${SERVER_CERT_TARGET_DIR}
# into PGDATA where they will be owned by the postgres user.
for f in ${SERVER_CERT_TARGET_DIR}/*.crt; do
  cp "$f" "$PGDATA/$(basename "$f")"
done
for f in ${SERVER_CERT_TARGET_DIR}/*.key; do
  cp "$f" "$PGDATA/$(basename "$f")"
done
chown postgres:postgres "$PGDATA"/*.crt "$PGDATA"/*.key 2>/dev/null || true
chmod 600 "$PGDATA"/*.key
chmod 644 "$PGDATA"/*.crt

# Enable SSL via postgresql.conf so it is the default but can be
# overridden at runtime via ALTER SYSTEM (which writes to
# postgresql.auto.conf, applied AFTER postgresql.conf).
cat >> "$PGDATA/postgresql.conf" <<'__CONF_EOF__'
# pg-fixture-tls.ts — TLS material loaded from PGDATA.
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
ssl_ca_file = 'client-ca.crt'
__CONF_EOF__

# Rewrite pg_hba.conf with the suite's narrow ruleset.
cat > "$PGDATA/pg_hba.conf" <<'__HBA_EOF__'
${HBA_CONF.trim()}
__HBA_EOF__

# pg_ident.conf — maps the ssltestuser cert CN to the mappeduser role for
# the map=certmap HBA rule above. PG reads \$PGDATA/pg_ident.conf by default.
cat > "$PGDATA/pg_ident.conf" <<'__IDENT_EOF__'
# MAPNAME   SYSTEM-USERNAME   PG-USERNAME
certmap     ssltestuser       mappeduser
__IDENT_EOF__
`;

/**
 * Boot a fresh postgres container with TLS enabled. Returns the connection
 * info plus the host-side cert paths so the test can validate them. The
 * fixture mints a real cert chain (root CA → server/client CA → leaves)
 * and the spec can switch which server leaf cert is active at runtime via
 * {@link switchServerCert} (which the fixture exposes for tests).
 */
export async function setupTlsPg(): Promise<TlsPgConn> {
  const workDir = mkdtempSync(join(tmpdir(), 'psql-conformance-tls-'));
  workDirRef = workDir;

  // Mint the cert vault.
  const vault = new CertVault(workDir);
  vault.mint();
  // Active server cert = CN+SAN variant. It satisfies both `verify-ca`
  // (chain) and `verify-full` (SAN DNS:localhost), and is also a SAN
  // superset of the 005 spec's expectations (which only need a working
  // server cert — it never reads the chain).
  const active = vault.getServerCert('cn-and-san');

  const initSqlPath = join(workDir, 'init-users.sql');
  writeFileSync(initSqlPath, INIT_SQL, 'utf8');
  const initHbaPath = join(workDir, 'init-hba.sh');
  writeFileSync(initHbaPath, HBA_INIT_SH, { mode: 0o755 });

  // The testcontainers builder is fluent; every `with*` returns `this`.
  type ContentToCopy = {
    content: string;
    target: string;
    mode?: number;
  };
  type Builder = {
    withCopyFilesToContainer(
      files: { source: string; target: string; mode?: number }[],
    ): Builder;
    withCopyContentToContainer(contents: ContentToCopy[]): Builder;
    start(): Promise<StartedContainer>;
  };
  type StartedContainer = {
    stop(): Promise<void>;
    getHost(): string;
    getPort(): number;
    getDatabase(): string;
    getUsername(): string;
    getPassword(): string;
  };

  // Dynamic import so the harness still loads when @testcontainers/postgresql
  // is absent (mirrors pg-fixture.ts).
  const moduleName = '@testcontainers/postgresql';
  let mod: { PostgreSqlContainer?: unknown };
  try {
    mod = (await import(moduleName)) as { PostgreSqlContainer?: unknown };
  } catch {
    throw new Error(
      'pg-fixture-tls: @testcontainers/postgresql is not installed. ' +
        'Install with `bun add -d @testcontainers/postgresql` (one-time).',
    );
  }
  type ContainerCtor = new (image: string) => Builder;
  const ctor = mod.PostgreSqlContainer as ContainerCtor | undefined;
  if (typeof ctor !== 'function') {
    throw new Error(
      'pg-fixture-tls: @testcontainers/postgresql is installed but does not ' +
        'export PostgreSqlContainer — your version is incompatible.',
    );
  }
  const image = process.env.PGCONFORMANCE_PG_IMAGE ?? PG_IMAGE_DEFAULT;
  log(`pg-fixture-tls: booting ${image} with TLS enabled...`);

  // Bind-mount the full minted cert tree. Every leaf server cert + key,
  // every CA bundle, plus the active cert/key under the `server.crt` /
  // `server.key` filenames postgresql.conf will read. The init script
  // copies these into PGDATA and chown's them to the postgres user.
  const filesToCopy: { source: string; target: string; mode?: number }[] = [
    // Active cert as `server.crt` / `server.key` (what postgresql.conf
    // initially points at). Keeping backward-compat with the 005 spec's
    // assumption that the fixture exposes ONE server.crt / server.key.
    { source: active.cert, target: ACTIVE_CERT_TARGET, mode: 0o644 },
    { source: active.key, target: ACTIVE_KEY_TARGET, mode: 0o644 },
    // Every alternate server cert + key the spec might switch to.
    ...allServerCertFiles(vault).map((p) => ({
      source: p.host,
      target: p.container,
      mode: 0o644,
    })),
    // Client CA bundle so the server can validate client certs.
    {
      source: vault.getRootClientBundle(),
      target: CLIENT_CA_CONTAINER_PATH,
      mode: 0o644,
    },
    // Init scripts run in alphabetical order — `01-users.sql` creates
    // the suite users via SQL; `02-hba.sh` then rewrites pg_hba.conf
    // and enables SSL via postgresql.conf.
    {
      source: initSqlPath,
      target: '/docker-entrypoint-initdb.d/01-users.sql',
      mode: 0o644,
    },
    {
      source: initHbaPath,
      target: '/docker-entrypoint-initdb.d/02-hba.sh',
      mode: 0o755,
    },
  ];

  const builder: Builder = new ctor(image).withCopyFilesToContainer(
    filesToCopy,
  );
  const started = await builder.start();
  containerRef = started;
  const conn: TlsPgConn = {
    host: started.getHost(),
    port: started.getPort(),
    db: started.getDatabase(),
    user: started.getUsername(),
    password: started.getPassword(),
    serverCertPath: active.cert,
    serverKeyPath: active.key,
    workDir,
    vault,
  };
  log(`pg-fixture-tls: ready at ${conn.host}:${conn.port} (db=${conn.db})`);
  return conn;
}

/**
 * Enumerate every alternate server cert + key path. Used to build the
 * testcontainers bind-mount list so the spec can `ALTER SYSTEM SET
 * ssl_cert_file = 'server-<name>.crt'` at runtime without a container
 * restart. The names mirror the host filenames; the init script copies
 * each pair into PGDATA so the postgres user owns the files.
 */
function allServerCertFiles(
  vault: CertVault,
): { host: string; container: string }[] {
  const names: ServerCertName[] = [
    'cn-only',
    'cn-and-san',
    'san-only',
    'ip-in-san',
    'multi-name',
    'pss',
  ];
  const out: { host: string; container: string }[] = [];
  for (const n of names) {
    const c = vault.getServerCert(n);
    out.push({
      host: c.cert,
      container: `${SERVER_CERT_TARGET_DIR}/server-${n}.crt`,
    });
    out.push({
      host: c.key,
      container: `${SERVER_CERT_TARGET_DIR}/server-${n}.key`,
    });
  }
  return out;
}

/**
 * SQL fragments to atomically switch the server's active cert/key. The
 * spec is expected to wrap these in adminExec() + pg_reload_conf() — see
 * the 001 spec for the helper.
 */
export function switchServerCertSql(name: ServerCertName): string[] {
  return [
    `ALTER SYSTEM SET ssl_cert_file = 'server-${name}.crt'`,
    `ALTER SYSTEM SET ssl_key_file = 'server-${name}.key'`,
  ];
}

/** Tear down the container and remove the temp dir. */
export async function teardownTlsPg(): Promise<void> {
  if (containerRef) {
    try {
      await containerRef.stop();
    } catch (err) {
      log(`pg-fixture-tls: stop() failed (${String(err)}); continuing`);
    }
    containerRef = null;
  }
  if (workDirRef && existsSync(workDirRef)) {
    try {
      rmSync(workDirRef, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    workDirRef = null;
  }
}

/** True iff `openssl` is on PATH (the cert-generation prerequisite). */
export function isOpensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
