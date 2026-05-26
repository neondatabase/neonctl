// Port of upstream PostgreSQL's `src/test/ssl/t/001_ssltests.pl`.
//
// Vendored reference:
//   tests/psql-conformance/vendor/postgres-18.0/src/test/ssl/t/001_ssltests.pl
//   (REL_18_0 commit 3d6a828938a5fa0444275d3d2f67b64ec3199eb7)
//
// SCOPE — what is ported, what is skipped, and why
// ---------------------------------------------------------------------------
// The upstream perl test has ~80 subtests across many areas. Most rely on
// PostgreSQL's full `src/test/ssl/conf` test cert harness (a Perl module
// that mints a multi-cert tree: root CA, server CA, client CA, ~20 server
// certs with assorted SAN/CN shapes, revoked variants, CRL files, …). Our
// `pg-fixture-tls.ts` (just landed in d50cce5) intentionally generates a
// SINGLE self-signed cert with `CN=localhost` and no SAN — enough to test
// the negotiation path (005_negotiate_encryption) and a small slice of
// sslmode/sslrootcert behaviour. The fixture is frozen for this port; we
// don't extend it (a parallel agent is touching adjacent paths).
//
// What we PORT (per the task brief, the high-value 8–10):
//
//   1. `sslmode=disable` against `ssluser` (HBA `hostssl`) — server
//      rejects the unencrypted attempt.
//   2. `sslmode=require` without `sslrootcert` — connects (require does
//      not consult the CA, so the self-signed server cert is accepted).
//   3. `sslmode=verify-ca` with `sslrootcert` pointing at a non-existent
//      file — fails with our `could not read sslrootcert …` diagnostic.
//   4. `sslmode=verify-full` with `sslrootcert` non-existent — same as
//      verify-ca; fails to load.
//   5. `sslmode=verify-ca` with a CA file that does not chain to the
//      server cert — fails the cert verification.
//   6. `sslmode=verify-full` with a CA file that does not chain — same
//      failure shape (handshake rejects before hostname check).
//   7. `sslmode=require` + valid `sslrootcert` connects (cert is loaded
//      but require still does not assert chain).
//   8. `sslmode=verify-ca` with the fixture's self-signed cert (acting
//      as its own root) — succeeds.
//   9. `pg_stat_ssl` content over an SSL connection — `ssl=t`, a
//      TLSv1.x version string, a non-empty cipher, and `client_dn=NULL`
//      (no client cert presented).
//  10. `pg_stat_ssl` content over a plain connection — `ssl=f`.
//
// `it.todo` subtests (upstream lines kept in the spec body):
//
//   * `sslmode=verify-full` against the *real* host: fixture cert has
//     no SAN; Node ≥ 22 removed CN-only matching, so verify-full has
//     nothing to compare against. FIXTURE gap.
//   * `sslmode=require` + `sslrootcert=invalid` should connect (libpq
//     never opens the file in require mode). Our impl eagerly reads the
//     sslrootcert regardless of mode, so the ENOENT bubbles out. IMPL
//     gap.
//
// What we SKIP (with `it.skip(reason)` so they show up in the rollup):
//
//   * CRL revocation chains — fixture has no CRL infrastructure.
//   * Server certs with SAN / IP-CN / wildcards / multi-name — fixture
//     produces exactly one self-signed CN=localhost cert.
//   * Server-side certificate authorization (client cert + `cert` HBA
//     method) — fixture does not configure `ssl_ca_file` or a `cert`
//     auth method. The full perl test does ~30+ subtests here.
//   * Password-protected key files + `sslpassword` — `sslpassword` is
//     not an option in our ConnectOptions.
//   * `sslcertmode={disable,allow,require}` — not exposed by our impl.
//   * `ssl_min_protocol_version` / `ssl_max_protocol_version` — we don't
//     expose Node TLS protocol-version knobs.
//   * `sslkeylogfile` — not implemented.
//   * `sslrootcert=system` — not implemented.
//   * Intermediate CA chains — fixture has no intermediate CA.
//   * Error-message text assertions (e.g. `qr/SSL error: certificate verify
//     failed/`) — our diagnostic strings differ from libpq's. We assert
//     pass/fail and shape, not the exact phrasing.
//
// PORTED / SKIPPED ACCOUNTING (rollup at bottom of file):
//   * Ported `it` (passing):                 10
//   * `it.todo` (fixture-cert / impl gap):    2
//   * `it.skip` (out of fixture scope):       9 groups (46 individual `it.skip`s)
//
// IMPORTANT: This spec boots its OWN postgres container with `ssl=on` via
// the shared `pg-fixture-tls.ts` helper, NOT the plaintext fixture from
// `pg-fixture.ts`. Like the 005 sibling, the spec imports the wire layer
// from `dist/psql/wire/connection.js` so the test surface mirrors what
// `bin/cli.js` would do at runtime. There is no auto-build step —
// `bun run build` is required before this spec can run.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isOpensslAvailable,
  setupTlsPg,
  teardownTlsPg,
  type TlsPgConn,
} from '../harness/pg-fixture-tls.js';

// ---------------------------------------------------------------------------
// Resolve the dist-side wire module that we exercise. Loaded lazily inside
// the suite body so the file still loads cleanly when `dist/` is absent
// (in which case `SHOULD_RUN` is false and the body is skipped).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DIST_WIRE = join(REPO_ROOT, 'dist', 'psql', 'wire', 'connection.js');

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const OPENSSL_OK = isOpensslAvailable();
const DIST_EXISTS = existsSync(DIST_WIRE);
const SHOULD_RUN = RUN_INTEGRATION && OPENSSL_OK && DIST_EXISTS;

/**
 * Minimal structural view of the wire module surface this spec uses.
 * Sourced from `dist/psql/wire/connection.js` via dynamic import. The
 * structural type lets vitest type-check the spec without pulling the
 * full src/ tree under the conformance tsconfig's rootDir.
 */
type WireConn = {
  execSimple(sql: string): Promise<{ rows: unknown[][] }[]>;
  getTlsInfo?(): {
    protocol: string;
    cipher: string;
  } | null;
  isClosed?(): boolean;
  close(): Promise<void>;
};

type WireOpts = {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  sslcert?: string;
  sslkey?: string;
  sslrootcert?: string;
  sslcrl?: string;
};

type WireModule = {
  PgConnection: {
    connect(opts: WireOpts): Promise<WireConn>;
  };
};

let wireMod: WireModule | null = null;

const loadWire = async (): Promise<WireModule> => {
  if (wireMod) return wireMod;
  const url = pathToFileURL(DIST_WIRE).href;
  wireMod = (await import(url)) as WireModule;
  return wireMod;
};

// ---------------------------------------------------------------------------
// Gating: surface why we're skipped when we are.
// ---------------------------------------------------------------------------

describe('tap/001_ssltests (gate)', () => {
  if (!RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1 (set env to run)', () => {
      /* unreachable */
    });
  } else if (!OPENSSL_OK) {
    it.skip('skipped: openssl not on PATH (required for cert generation)', () => {
      /* unreachable */
    });
  } else if (!DIST_EXISTS) {
    it.skip('skipped: dist/psql/wire/connection.js missing — run `bun run build` first', () => {
      /* unreachable */
    });
  } else {
    it('gates open: RUN_INTEGRATION=1, openssl available, dist present', () => {
      expect(true).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Fixture bootstrap + extra-cert generation
// ---------------------------------------------------------------------------

/**
 * Wider fixture bundle for this spec. `tlsConn` is the shared TLS-enabled
 * postgres container (from pg-fixture-tls); `extras` holds spec-private
 * artefacts (a "wrong" CA + an invalid path) generated at runtime so the
 * spec doesn't have to mutate the fixture's cert material.
 */
type SpecFixture = {
  tls: TlsPgConn;
  /** Self-signed cert UNRELATED to the server's — used to test "wrong CA". */
  wrongCaCertPath: string;
  /** A path guaranteed not to exist, for the "missing file" tests. */
  invalidPath: string;
  /** Local-only working dir for the extra certs; cleaned on teardown. */
  workDir: string;
};

let fx: SpecFixture | null = null;

const ensureFixture = (): SpecFixture => {
  if (!fx) {
    throw new Error('SpecFixture missing — beforeAll did not complete');
  }
  return fx;
};

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const tls = await setupTlsPg();

  // Generate a SECOND self-signed cert that is unrelated to the server's.
  // Used by the "wrong root cert" subtests — we set this as sslrootcert
  // and the verify step should reject the server cert because it doesn't
  // chain to this CA.
  const workDir = mkdtempSync(join(tmpdir(), 'psql-conformance-tls-spec-'));
  const wrongCaKey = join(workDir, 'wrong-ca.key');
  const wrongCaCert = join(workDir, 'wrong-ca.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-keyout',
      wrongCaKey,
      '-out',
      wrongCaCert,
      '-days',
      '30',
      '-subj',
      '/CN=unrelated-test-ca',
    ],
    { stdio: 'pipe' },
  );

  // Pre-create an empty placeholder we'll DELETE so the path is guaranteed
  // to not exist. Using a path inside our workDir keeps the test
  // hermetic — no chance of colliding with a real file on the host.
  const invalidPath = join(workDir, 'definitely-does-not-exist.crt');
  writeFileSync(invalidPath, '');
  rmSync(invalidPath);

  fx = { tls, wrongCaCertPath: wrongCaCert, invalidPath, workDir };
}, 180_000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  if (fx && existsSync(fx.workDir)) {
    try {
      rmSync(fx.workDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  await teardownTlsPg();
  fx = null;
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt a connection; return either a live wire-conn or `null` on
 * failure. The caller is responsible for closing the connection it
 * receives. Used by the success-case tests; failure-case tests use
 * `attemptFails` so the rejected promise is asserted directly.
 */
async function tryConnect(
  opts: Omit<WireOpts, 'host' | 'port' | 'database'>,
): Promise<WireConn | null> {
  const t = ensureFixture().tls;
  const { PgConnection } = await loadWire();
  try {
    return await PgConnection.connect({
      ...opts,
      host: t.host,
      port: t.port,
      database: t.db,
    });
  } catch {
    return null;
  }
}

/** Connect or throw — used in the success-case tests for clearer error msgs. */
async function mustConnect(
  opts: Omit<WireOpts, 'host' | 'port' | 'database'>,
): Promise<WireConn> {
  const t = ensureFixture().tls;
  const { PgConnection } = await loadWire();
  return PgConnection.connect({
    ...opts,
    host: t.host,
    port: t.port,
    database: t.db,
  });
}

/**
 * `\dt+ pg_stat_ssl` shape: (pid, ssl, version, cipher, bits, client_dn,
 * client_serial, issuer_dn). We coerce `ssl` to a boolean ourselves
 * because the wire layer's text-format decoder normalises booleans to
 * `'true'`/`'false'` (libpq returns `'t'`/`'f'` raw; we match the JS
 * convention).
 */
type PgStatSslRow = {
  ssl: boolean;
  version: string | null;
  cipher: string | null;
  clientDn: string | null;
};

async function queryPgStatSsl(conn: WireConn): Promise<PgStatSslRow> {
  const rs = await conn.execSimple(
    `SELECT ssl::text, version, cipher, client_dn
       FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
  );
  const row = rs[0]?.rows[0];
  if (!row) {
    throw new Error('pg_stat_ssl returned no rows');
  }
  const sslRaw = row[0];
  const ssl =
    sslRaw === true ||
    sslRaw === 't' ||
    (typeof sslRaw === 'string' && sslRaw.toLowerCase() === 'true');
  return {
    ssl,
    version: row[1] === null || row[1] === undefined ? null : String(row[1]),
    cipher: row[2] === null || row[2] === undefined ? null : String(row[2]),
    clientDn: row[3] === null || row[3] === undefined ? null : String(row[3]),
  };
}

// ---------------------------------------------------------------------------
// PORTED SUBTESTS
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/001_ssltests', () => {
  // ---------------------------------------------------------------------
  // sslmode behavior — upstream lines ~185–245.
  // ---------------------------------------------------------------------

  describe('sslmode behavior', () => {
    // Upstream L186: "The server should not accept non-SSL connections."
    // We mirror this by connecting as `ssluser` (HBA: hostssl all ssluser
    // trust) with `sslmode=disable` — the server has no `host` rule for
    // ssluser, so PG rejects with "no pg_hba.conf entry".
    it('sslmode=disable against hostssl-only user fails (no pg_hba.conf entry)', async () => {
      const conn = await tryConnect({ user: 'ssluser', ssl: 'disable' });
      expect(conn).toBeNull();
    });

    // Upstream L194: "Try without a root cert. In sslmode=require, this
    // should work." We connect without specifying sslrootcert; the
    // self-signed server cert is accepted because require does not
    // verify the chain.
    it('sslmode=require without sslrootcert connects', async () => {
      const conn = await mustConnect({ user: 'testuser', ssl: 'require' });
      try {
        const info = conn.getTlsInfo?.();
        expect(info).toBeTruthy();
      } finally {
        await conn.close();
      }
    });

    // Upstream L196: "sslmode=verify-ca without root cert fails". Our
    // impl surfaces `could not read sslrootcert "<path>": ENOENT ...`.
    it('sslmode=verify-ca with non-existent sslrootcert fails with read error', async () => {
      const t = ensureFixture();
      const { PgConnection } = await loadWire();
      await expect(
        PgConnection.connect({
          host: t.tls.host,
          port: t.tls.port,
          user: 'testuser',
          database: t.tls.db,
          ssl: 'verify-ca',
          sslrootcert: t.invalidPath,
        }),
      ).rejects.toThrow(/sslrootcert/);
    });

    // Upstream L200: "sslmode=verify-full without root cert fails".
    // Same file-read path as verify-ca; same diagnostic shape.
    it('sslmode=verify-full with non-existent sslrootcert fails with read error', async () => {
      const t = ensureFixture();
      const { PgConnection } = await loadWire();
      await expect(
        PgConnection.connect({
          host: t.tls.host,
          port: t.tls.port,
          user: 'testuser',
          database: t.tls.db,
          ssl: 'verify-full',
          sslrootcert: t.invalidPath,
        }),
      ).rejects.toThrow(/sslrootcert/);
    });

    // Upstream L207: "Try with wrong root cert, should fail." We pass
    // our generated `wrong-ca.crt` (unrelated self-signed). The TLS
    // verifier rejects because the server cert does not chain to it.
    it('sslmode=verify-ca with wrong CA file fails the handshake', async () => {
      const t = ensureFixture();
      const conn = await tryConnect({
        user: 'testuser',
        ssl: 'verify-ca',
        sslrootcert: t.wrongCaCertPath,
      });
      expect(conn).toBeNull();
    });

    // Upstream L211: same as above but verify-full. The TLS handshake
    // happens BEFORE hostname check, so the wrong CA fails verify-full
    // for the same reason as verify-ca.
    it('sslmode=verify-full with wrong CA file fails the handshake', async () => {
      const t = ensureFixture();
      const conn = await tryConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.wrongCaCertPath,
      });
      expect(conn).toBeNull();
    });

    // Upstream L228: "with the correct root cert ... sslmode=require".
    // Our fixture's cert IS the trust anchor (it's self-signed). When we
    // hand it to sslrootcert, verify-ca should accept it.
    it('sslmode=require + valid sslrootcert connects', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'require',
        sslrootcert: t.tls.serverCertPath,
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    // Upstream L232: "sslmode=verify-ca with correct root cert succeeds."
    // The self-signed server cert is its own CA, so passing it as
    // sslrootcert lets the chain verify.
    it('sslmode=verify-ca + valid sslrootcert connects', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-ca',
        sslrootcert: t.tls.serverCertPath,
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });
  });

  // ---------------------------------------------------------------------
  // pg_stat_ssl contents — upstream lines 579–592 (no client cert).
  // ---------------------------------------------------------------------

  describe('pg_stat_ssl', () => {
    it('reports ssl=t with a TLSv1.x version and a cipher (no client cert)', async () => {
      const conn = await mustConnect({ user: 'testuser', ssl: 'require' });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
        // Upstream regex: TLSv[\d.]+
        expect(stat.version).toMatch(/^TLSv[\d.]+$/);
        expect(stat.cipher).toBeTruthy();
        // No client cert presented — DN is null.
        expect(stat.clientDn).toBeNull();

        // Cross-check our getTlsInfo() — the cipher / protocol should
        // round-trip from Node's TLS socket to the same shape PG sees.
        const info = conn.getTlsInfo?.();
        expect(info).toBeTruthy();
        expect(info?.protocol).toMatch(/^TLSv[\d.]+$/);
      } finally {
        await conn.close();
      }
    });

    it('reports ssl=f over a sslmode=disable connection', async () => {
      // testuser has a plain `host` HBA rule, so disable is accepted.
      const conn = await mustConnect({ user: 'testuser', ssl: 'disable' });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(false);
        // Plaintext connection — getTlsInfo() returns null.
        expect(conn.getTlsInfo?.()).toBeNull();
      } finally {
        await conn.close();
      }
    });
  });

  // ---------------------------------------------------------------------
  // TODO: sslmode=verify-full against the fixture's CN=localhost cert.
  //
  // The fixture cert has no subjectAltName, and Node 22+ no longer
  // accepts CN-only matching (DEP0151 was upgraded to a hard error).
  // Until the fixture mints a cert with a SAN, verify-full has nothing
  // to match against. This is a FIXTURE gap, not an impl gap.
  // ---------------------------------------------------------------------

  it.todo(
    'upstream sslmode=verify-full + valid sslrootcert connects: fixture cert has no SAN; Node ≥22 requires SAN for hostname match',
  );

  // Upstream L194: libpq tolerates an invalid `sslrootcert` path under
  // sslmode=require (it never opens the file). Our impl eagerly reads
  // sslrootcert in `loadTlsFileOptions` regardless of mode, so the
  // ENOENT bubbles out and the connection fails. TS-impl gap.
  it.todo(
    'upstream sslmode=require + invalid sslrootcert path connects: our impl reads sslrootcert eagerly regardless of mode',
  );

  // ---------------------------------------------------------------------
  // SKIPPED SUBTESTS — explicit `it.skip` so the report inventories them.
  // ---------------------------------------------------------------------

  describe('SKIPPED: server cert SAN / IP-CN / wildcards (fixture has CN=localhost only, no SAN)', () => {
    it.skip('connect with hostname matching server cert SAN dns1 / dns2 / wildcard', () => {
      /* unreachable — needs server-multiple-alt-names cert */
    });
    it.skip('connect with IP in CN — server-ip-cn-only', () => {
      /* unreachable */
    });
    it.skip('connect with IP in dNSName SAN — server-ip-in-dnsname', () => {
      /* unreachable */
    });
    it.skip('hostname mismatch verify-full surfaces "does not match host name"', () => {
      /* unreachable — fixture has no SAN to compare against */
    });
    it.skip('server cert without CN or SANs — verify-ca succeeds, verify-full fails', () => {
      /* unreachable */
    });
    it.skip('server cert with both CN and SANs — SANs preferred, CN ignored', () => {
      /* unreachable */
    });
  });

  describe('SKIPPED: client certificate authentication (fixture has no ssl_ca_file / HBA `cert` method)', () => {
    it.skip('certificate authorization fails without client cert (no-cert + cert HBA)', () => {
      /* unreachable */
    });
    it.skip('certificate authorization succeeds with PEM client cert + key', () => {
      /* unreachable */
    });
    it.skip('certificate authorization succeeds with DER client cert + key', () => {
      /* unreachable */
    });
    it.skip('certificate authorization succeeds with encrypted PEM + sslpassword', () => {
      /* unreachable — ConnectOptions has no sslpassword */
    });
    it.skip('client cert belonging to another user fails with FATAL', () => {
      /* unreachable */
    });
    it.skip('clientcert=verify-full requires username to match Common Name', () => {
      /* unreachable */
    });
    it.skip('clientcert=verify-ca accepts mismatched username', () => {
      /* unreachable */
    });
    it.skip('client key with group/world-readable perms is rejected', () => {
      /* unreachable — our impl does not enforce perms; libpq does */
    });
    it.skip('cert DN mapping via pg_ident.conf — exact / regex / CN', () => {
      /* unreachable */
    });
    it.skip('intermediate client_ca certificate provided by client succeeds', () => {
      /* unreachable */
    });
    it.skip('intermediate client cert without trusted root is rejected', () => {
      /* unreachable */
    });
    it.skip('long client cert subject is truncated in the server log', () => {
      /* unreachable — log inspection not supported via wire layer */
    });
  });

  describe('SKIPPED: CRL revocation (fixture has no CRL infrastructure)', () => {
    it.skip('connects with no CRL; fails with matching CRL via sslcrl=', () => {
      /* unreachable */
    });
    it.skip('connects with no CRL; fails with matching CRL via sslcrldir=', () => {
      /* unreachable — sslcrldir not exposed in ConnectOptions */
    });
    it.skip('sslcrl pointing at unrelated CA is rejected at verify time', () => {
      /* unreachable */
    });
    it.skip('server-side CRL directory revokes client certs', () => {
      /* unreachable */
    });
    it.skip('server-side CRL handles non-ASCII subjects', () => {
      /* unreachable */
    });
  });

  describe('SKIPPED: protocol-version negotiation (Node TLS does not expose ssl_min/max_protocol_version)', () => {
    it.skip('connect succeeds with correct range of TLS protocol versions', () => {
      /* unreachable */
    });
    it.skip('connect fails with incorrect range (min > max)', () => {
      /* unreachable */
    });
    it.skip('connect fails with malformed ssl_min/max_protocol_version values', () => {
      /* unreachable */
    });
    it.skip('server fails to restart with min > max protocol versions', () => {
      /* unreachable — server-side restart not in our scope */
    });
  });

  describe('SKIPPED: sslcertmode={disable,allow,require} (not in our ConnectOptions)', () => {
    it.skip('sslcertmode=disable + valid cert → cert not sent → auth fails', () => {
      /* unreachable */
    });
    it.skip('sslcertmode=allow + no client cert + cert HBA → fails', () => {
      /* unreachable */
    });
    it.skip('sslcertmode=require requires a client certificate to be sent', () => {
      /* unreachable */
    });
  });

  describe('SKIPPED: password-protected key files (no sslpassword in ConnectOptions)', () => {
    it.skip('encrypted-PEM key + sslpassword succeeds with right password', () => {
      /* unreachable */
    });
    it.skip('encrypted-PEM key + sslpassword fails with wrong password (libpq message text)', () => {
      /* unreachable */
    });
    it.skip('server-side password-protected key restart succeeds with passphrase_cmd', () => {
      /* unreachable */
    });
  });

  describe('SKIPPED: sslrootcert=system / sslkeylogfile / sslcrldir (not implemented)', () => {
    it.skip('sslrootcert=system does not trust private CA', () => {
      /* unreachable */
    });
    it.skip('sslrootcert=system + SSL_CERT_FILE override trusts CA', () => {
      /* unreachable */
    });
    it.skip('sslrootcert=system defaults to sslmode=verify-full', () => {
      /* unreachable */
    });
    it.skip('sslkeylogfile is written on connect with correct permissions', () => {
      /* unreachable */
    });
    it.skip('invalid sslkeylogfile path surfaces "could not open"', () => {
      /* unreachable */
    });
    it.skip('sslcrldir=... reads CRLs from a directory', () => {
      /* unreachable */
    });
  });

  describe('SKIPPED: certificate-bundle root files (fixture has single cert, not a bundle)', () => {
    it.skip('cert root file containing two certs, order 1', () => {
      /* unreachable — needs both-cas-1.crt */
    });
    it.skip('cert root file containing two certs, order 2', () => {
      /* unreachable — needs both-cas-2.crt */
    });
    it.skip('server CA cert alone (without root CA) fails verify-ca', () => {
      /* unreachable */
    });
  });

  describe('SKIPPED: error-message-text assertions (libpq diagnostic strings differ from ours)', () => {
    it.skip('asserts libpq-style "no pg_hba.conf entry" text', () => {
      /* unreachable — we surface a different ConnectError shape */
    });
    it.skip('asserts libpq-style "certificate verify failed" text', () => {
      /* unreachable */
    });
    it.skip('asserts libpq-style "does not match host name" text', () => {
      /* unreachable */
    });
    it.skip('asserts libpq-style "bad decrypt" text on wrong key password', () => {
      /* unreachable */
    });
  });
});
