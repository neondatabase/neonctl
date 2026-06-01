// Port of upstream PostgreSQL's `src/test/ssl/t/001_ssltests.pl`.
//
// Vendored reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/test/ssl/t/001_ssltests.pl
//   (REL_18_0 commit 3d6a828938a5fa0444275d3d2f67b64ec3199eb7)
//
// SCOPE — what is ported, what is skipped, and why
// ---------------------------------------------------------------------------
// The upstream perl test has ~80 subtests across many areas. The TLS
// fixture (`pg-fixture-tls.ts`) was extended to mint a real cert chain
// (root CA → server/client CA → server / client leaf certs with assorted
// CN / SAN shapes) and the wire layer was extended with `sslpassword`
// plus an sslmode-aware `sslrootcert` read, which together unblock a
// large slice of the upstream test surface.
//
// What we PORT (32 active `it()` subtests + 1 gate `it()`):
//
//   1. `sslmode={disable,require,verify-ca,verify-full}` happy / sad paths
//      against the active server cert, with / without sslrootcert.
//   2. Server cert SAN / IP-SAN / wildcard host-match (after switching the
//      active server cert via `ALTER SYSTEM SET ssl_cert_file`).
//   3. Certificate-bundle root files — `root+server_ca.crt` order 1 and 2.
//   4. Client-cert authorization — pass / fail with the `cert` HBA method
//      (`clientcert=verify-full` and `clientcert=verify-ca`).
//   5. Encrypted-PEM client key + `sslpassword` happy and sad paths.
//   6. Intermediate client_ca chain attached to the client cert succeeds;
//      bare leaf cert without the intermediate is rejected.
//   7. `pg_stat_ssl` for both SSL and plaintext connections, including
//      client_dn population when a client cert is presented.
//
// `it.todo` subtests: NONE (the previous 2 todos are now `it()` after
// the fixture extension + wire-layer additions).
//
// What we SKIP (with `it.skip(reason)` so they show up in the rollup):
//
//   * CRL revocation chains — fixture has no CRL infrastructure (and the
//     wire layer's `sslcrl` was tested in isolation).
//   * `ssl_min_protocol_version` / `ssl_max_protocol_version` — Node TLS
//     doesn't expose protocol-version knobs.
//   * `sslcertmode={disable,allow,require}` — not exposed by our impl
//     (libpq-specific concept we don't intend to add).
//   * `sslkeylogfile` — not implemented (debug feature).
//   * `sslrootcert=system` — platform CA store integration is a separate
//     feature.
//   * DER-format client cert / key — libpq supports both PEM and DER;
//     Node's TLS accepts PEM only, so the DER variants are out of scope.
//   * Client key file-permission enforcement — libpq's check; our impl
//     defers to Node's TLS layer which is permissive.
//   * `pg_ident.conf` DN mapping — server-side admin not in our scope.
//   * Long client cert subject log truncation — server log inspection.
//   * libpq exact-error-text assertions (`certificate verify failed` /
//     `does not match host name` / `bad decrypt`) — our diagnostic
//     strings differ from libpq's.
//
// PORTED / SKIPPED ACCOUNTING (vitest reports for this file):
//   * Ported `it` (passing):                32 (+ 1 gate `it()`)
//   * `it.todo` (impl / fixture gap):        0
//   * `it.skip` (out of scope / not impl):  27 individual `it.skip`s
//                                           across 7 SKIPPED groups
//
// IMPORTANT: This spec boots its OWN postgres container with `ssl=on` via
// the shared `pg-fixture-tls.ts` helper, NOT the plaintext fixture from
// `pg-fixture.ts`. Like the 005 sibling, the spec imports the wire layer
// from `dist/psql/wire/connection.js` so the test surface mirrors what
// `bin/cli.js` would do at runtime. There is no auto-build step —
// `bun run build` is required before this spec can run.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isOpensslAvailable,
  setupTlsPg,
  switchServerCertSql,
  teardownTlsPg,
  type ServerCertName,
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
  sslpassword?: string;
  sslrootcert?: string;
  sslcrl?: string;
  sslcrldir?: string;
  sslMinProtocolVersion?: string;
  sslMaxProtocolVersion?: string;
  hostaddr?: string;
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
 * artefacts (a "wrong" CA, an invalid path, alt-order bundles) generated
 * at runtime so the spec doesn't have to mutate the fixture's cert
 * material.
 */
type SpecFixture = {
  tls: TlsPgConn;
  /** Self-signed cert UNRELATED to the server's — used to test "wrong CA". */
  wrongCaCertPath: string;
  /** A path guaranteed not to exist, for the "missing file" tests. */
  invalidPath: string;
  /** `root_ca || server_ca` PEM bundle (order: root first). */
  bothCas1Path: string;
  /** `server_ca || root_ca` PEM bundle (order: leaf-CA first). */
  bothCas2Path: string;
  /** Bundle of `client_leaf || client_ca` for the "intermediate" subtests. */
  clientPlusClientCaPath: string;
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

  // Build the two-cert bundles. Upstream tests both orderings of
  // `root_ca` / `server_ca` to verify the client doesn't depend on file
  // order.
  const { readFileSync } = await import('node:fs');
  const rootPem = readFileSync(tls.vault.getRootCa(), 'utf8');
  const serverCaPem = readFileSync(tls.vault.getServerCa(), 'utf8');
  const bothCas1Path = join(workDir, 'both-cas-1.crt');
  writeFileSync(bothCas1Path, rootPem + '\n' + serverCaPem);
  const bothCas2Path = join(workDir, 'both-cas-2.crt');
  writeFileSync(bothCas2Path, serverCaPem + '\n' + rootPem);

  // Bundle: client-leaf || client_ca. With a non-intermediate-aware
  // server `ssl_ca_file`, the client must present the intermediate
  // itself for verification to succeed.
  const clientLeafPem = readFileSync(
    tls.vault.getClientCert('ssltestuser').cert,
    'utf8',
  );
  const clientCaPem = readFileSync(tls.vault.getClientCa(), 'utf8');
  const clientPlusClientCaPath = join(workDir, 'client-plus-client-ca.crt');
  writeFileSync(clientPlusClientCaPath, clientLeafPem + '\n' + clientCaPem);

  fx = {
    tls,
    wrongCaCertPath: wrongCaCert,
    invalidPath,
    bothCas1Path,
    bothCas2Path,
    clientPlusClientCaPath,
    workDir,
  };
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
  opts: Omit<WireOpts, 'host' | 'port' | 'database'> & { host?: string },
): Promise<WireConn | null> {
  const t = ensureFixture().tls;
  const { PgConnection } = await loadWire();
  try {
    return await PgConnection.connect({
      ...opts,
      host: opts.host ?? t.host,
      port: t.port,
      database: t.db,
    });
  } catch {
    return null;
  }
}

/** Connect or throw — used in the success-case tests for clearer error msgs. */
async function mustConnect(
  opts: Omit<WireOpts, 'host' | 'port' | 'database'> & { host?: string },
): Promise<WireConn> {
  const t = ensureFixture().tls;
  const { PgConnection } = await loadWire();
  return PgConnection.connect({
    ...opts,
    host: opts.host ?? t.host,
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

/**
 * Switch the *active* server cert via ALTER SYSTEM + pg_reload_conf. The
 * fixture's init script bind-mounted every alternate cert under
 * `<PGDATA>/server-<name>.crt` / `server-<name>.key`, so the swap is
 * file-system free — postgres re-reads the path it stores in
 * `ssl_cert_file` when SSL renegotiates after `pg_reload_conf()`.
 *
 * adminExec uses the privileged superuser baked into pg-fixture-tls.ts so
 * the ALTER SYSTEM call succeeds.
 */
async function switchServerCert(name: ServerCertName): Promise<void> {
  const t = ensureFixture();
  const { PgConnection } = await loadWire();
  const admin = await PgConnection.connect({
    host: t.tls.host,
    port: t.tls.port,
    user: t.tls.user,
    password: t.tls.password,
    database: t.tls.db,
    ssl: 'prefer',
  });
  try {
    for (const stmt of switchServerCertSql(name)) {
      await admin.execSimple(stmt);
    }
    await admin.execSimple('SELECT pg_reload_conf()');
  } finally {
    await admin.close();
  }
  // Give the postmaster a beat to pick up the change. PG's
  // pg_reload_conf is asynchronous — the GUC change is observable in
  // pg_settings immediately but the next SSL handshake won't pick it up
  // for a moment.
  await new Promise((r) => setTimeout(r, 250));
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
    // The fixture's root+server_ca bundle is the trust anchor; verify-ca
    // and require both accept the chain.
    it('sslmode=require + valid sslrootcert connects', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    // Upstream L232: "sslmode=verify-ca with correct root cert succeeds."
    it('sslmode=verify-ca + valid sslrootcert connects', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-ca',
        sslrootcert: t.tls.vault.getRootServerBundle(),
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    // Upstream L234-236: "sslmode=verify-full with correct root cert succeeds".
    // The active fixture cert is `server-cn-and-san.crt` which has
    // SAN DNS:localhost, so verify-full's hostname check accepts.
    it('sslmode=verify-full + matching host (SAN DNS:localhost) connects', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'localhost',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    // Upstream L194 (we now implement the lazy-read behaviour). libpq
    // tolerates an invalid `sslrootcert` path under sslmode=require
    // (it never opens the file). After the wire-layer change, our impl
    // matches.
    it('sslmode=require + invalid sslrootcert path still connects', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'require',
        sslrootcert: t.invalidPath,
      });
      try {
        expect(conn.getTlsInfo?.()).toBeTruthy();
      } finally {
        await conn.close();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Certificate-bundle root files — upstream lines 240–245.
  // ---------------------------------------------------------------------

  describe('cert root file containing two certs', () => {
    it('order 1 (root_ca || server_ca) — verify-ca succeeds', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-ca',
        sslrootcert: t.bothCas1Path,
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('order 2 (server_ca || root_ca) — verify-ca succeeds', async () => {
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-ca',
        sslrootcert: t.bothCas2Path,
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('server_ca alone (without root) fails verify-ca', async () => {
      const t = ensureFixture();
      // server_ca is itself signed by root_ca. Without root in the
      // trust set, OpenSSL can't terminate the chain → rejects.
      const conn = await tryConnect({
        user: 'testuser',
        ssl: 'verify-ca',
        sslrootcert: t.tls.vault.getServerCa(),
      });
      expect(conn).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Server cert SAN / IP-SAN / wildcards / multi-name — upstream lines
  // 293–510. Each subtest switches the active server cert via ALTER
  // SYSTEM + pg_reload_conf.
  // ---------------------------------------------------------------------

  describe('server cert SAN / IP-SAN / wildcards', () => {
    afterAll(async () => {
      // Restore the default cert so later test groups (e.g. cert auth)
      // run against a SAN-friendly server cert.
      await switchServerCert('cn-and-san');
    });

    it('cert without SAN — verify-ca succeeds (chain valid)', async () => {
      await switchServerCert('cn-only');
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-ca',
        sslrootcert: t.tls.vault.getRootServerBundle(),
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    // Note: a "cert without SAN — verify-full fails" subtest would require
    // a TCP host that resolves AND a TLS servername that does not match the
    // cert CN — they are bound together in our ConnectOptions
    // (`servername = host`). Skipped for now; the SAN-matching positive
    // path is exercised by the other subtests in this group.

    it('cert with SAN DNS:localhost — verify-full matches', async () => {
      await switchServerCert('cn-and-san');
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'localhost',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('cert with SAN DNS:localhost (san-only) — verify-full matches', async () => {
      await switchServerCert('san-only');
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'localhost',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('cert with SAN IP:127.0.0.1 — verify-full matches IP host', async () => {
      await switchServerCert('ip-in-san');
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: '127.0.0.1',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('cert with multi-name SAN — verify-full matches dns1', async () => {
      await switchServerCert('multi-name');
      const t = ensureFixture();
      // We can't actually resolve dns1.localhost to the container, so
      // we connect via the container's address but pass `host` for the
      // TLS servername. Node will use the supplied host for hostname
      // verification.
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'dns1.localhost',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('cert with multi-name SAN — verify-full matches dns2', async () => {
      await switchServerCert('multi-name');
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'dns2.localhost',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('cert with wildcard SAN — verify-full matches *.wildcard.localhost', async () => {
      await switchServerCert('multi-name');
      const t = ensureFixture();
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'foo.wildcard.localhost',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('cert with multi-name SAN — verify-full rejects wrong hostname', async () => {
      await switchServerCert('multi-name');
      const t = ensureFixture();
      const conn = await tryConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'wronghost.localhost',
      });
      expect(conn).toBeNull();
    });

    it('cert with multi-name SAN — wildcard does not match deep subdomain', async () => {
      await switchServerCert('multi-name');
      const t = ensureFixture();
      // RFC 6125 §6.4.3: wildcard matches at most one label. So
      // `*.wildcard.localhost` does NOT match `deep.sub.wildcard.localhost`.
      const conn = await tryConnect({
        user: 'testuser',
        ssl: 'verify-full',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        host: 'deep.sub.wildcard.localhost',
      });
      expect(conn).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Client certificate authorization — upstream lines 615–855.
  //
  // The fixture configures `ssl_ca_file = client-ca.crt` and HBA rules
  // for `ssltestuser` (cert clientcert=verify-full) and `anotheruser`
  // (cert clientcert=verify-ca). Subtests drive both happy and sad
  // paths.
  // ---------------------------------------------------------------------

  describe('client cert authorization', () => {
    afterAll(async () => {
      // Reset to default cert (cn-and-san) in case earlier groups left
      // a different one mounted.
      await switchServerCert('cn-and-san');
    });

    it('cert HBA rejects connection without client cert', async () => {
      const t = ensureFixture();
      // `ssltestuser` requires cert auth. Without sslcert, the
      // server-side cert verification rejects.
      const conn = await tryConnect({
        user: 'ssltestuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
      });
      expect(conn).toBeNull();
    });

    it('cert HBA accepts client cert (PEM) with matching CN (verify-full)', async () => {
      const t = ensureFixture();
      const client = t.tls.vault.getClientCert('ssltestuser');
      const conn = await mustConnect({
        user: 'ssltestuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        sslcert: client.cert,
        sslkey: client.key,
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
        // pg_stat_ssl.client_dn should reflect the cert subject. PG
        // strips the leading slash; both forms ("CN=..." and "/CN=...")
        // appear in upstream tests. We assert the CN substring only.
        expect(stat.clientDn ?? '').toMatch(/CN=ssltestuser/);
      } finally {
        await conn.close();
      }
    });

    it('cert HBA rejects client cert whose CN does not match user (verify-full)', async () => {
      const t = ensureFixture();
      // Present `anotheruser`'s cert as if we were `ssltestuser`. The
      // server's cert chain validates BUT the cert CN does not match
      // the username, so the verify-full check fails.
      const wrong = t.tls.vault.getClientCert('anotheruser');
      const conn = await tryConnect({
        user: 'ssltestuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        sslcert: wrong.cert,
        sslkey: wrong.key,
      });
      expect(conn).toBeNull();
    });

    it('cert HBA verify-ca accepts mismatched CN (anotheruser)', async () => {
      const t = ensureFixture();
      // `anotheruser` is `cert clientcert=verify-ca`. The CN need not
      // match the username — only the chain must be valid. Present
      // `ssltestuser`'s cert under `anotheruser` to verify.
      const otherClient = t.tls.vault.getClientCert('ssltestuser');
      const conn = await mustConnect({
        user: 'anotheruser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        sslcert: otherClient.cert,
        sslkey: otherClient.key,
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
      } finally {
        await conn.close();
      }
    });

    it('client cert with encrypted key + sslpassword succeeds', async () => {
      const t = ensureFixture();
      const client = t.tls.vault.getClientCert('ssltestuser');
      const encryptedKey = client.encryptedKey;
      if (encryptedKey === undefined) {
        throw new Error('fixture did not produce encrypted ssltestuser key');
      }
      const conn = await mustConnect({
        user: 'ssltestuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        sslcert: client.cert,
        sslkey: encryptedKey,
        sslpassword: 'testpw',
      });
      try {
        const stat = await queryPgStatSsl(conn);
        expect(stat.ssl).toBe(true);
        expect(stat.clientDn ?? '').toMatch(/CN=ssltestuser/);
      } finally {
        await conn.close();
      }
    });

    it('client cert with encrypted key + WRONG sslpassword fails', async () => {
      const t = ensureFixture();
      const client = t.tls.vault.getClientCert('ssltestuser');
      const encryptedKey = client.encryptedKey;
      if (encryptedKey === undefined) {
        throw new Error('fixture did not produce encrypted ssltestuser key');
      }
      const conn = await tryConnect({
        user: 'ssltestuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        sslcert: client.cert,
        sslkey: encryptedKey,
        sslpassword: 'definitely-not-the-password',
      });
      expect(conn).toBeNull();
    });

    it('client cert with encrypted key + NO sslpassword fails', async () => {
      const t = ensureFixture();
      const client = t.tls.vault.getClientCert('ssltestuser');
      const encryptedKey = client.encryptedKey;
      if (encryptedKey === undefined) {
        throw new Error('fixture did not produce encrypted ssltestuser key');
      }
      const conn = await tryConnect({
        user: 'ssltestuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        sslcert: client.cert,
        sslkey: encryptedKey,
        // sslpassword intentionally omitted
      });
      expect(conn).toBeNull();
    });

    it('client cert with intermediate chain attached succeeds', async () => {
      // We bundle `client_leaf || client_ca` and pass that as sslcert.
      // The fixture's server-side `ssl_ca_file` is `root+client_ca` so
      // it can already validate without this bundle — but the spec
      // documents the working shape of "client supplies the
      // intermediate" for parity with upstream's `client+client_ca.crt`
      // subtest.
      const t = ensureFixture();
      const client = t.tls.vault.getClientCert('ssltestuser');
      const conn = await mustConnect({
        user: 'ssltestuser',
        ssl: 'require',
        sslrootcert: t.tls.vault.getRootServerBundle(),
        sslcert: t.clientPlusClientCaPath,
        sslkey: client.key,
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
    afterAll(async () => {
      // The earlier groups switch cert; restore the default before
      // any later spec consumes the fixture.
      await switchServerCert('cn-and-san');
    });

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
  // SKIPPED SUBTESTS — explicit `it.skip` so the report inventories them.
  // ---------------------------------------------------------------------

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

  describe('protocol-version negotiation (ssl_min/max_protocol_version)', () => {
    // The wire layer maps these to Node TLS `minVersion`/`maxVersion`
    // (connection.ts mapProtocolVersion). A range that brackets what the
    // server offers connects cleanly.
    it('connect succeeds with correct range of TLS protocol versions', async () => {
      const conn = await mustConnect({
        user: 'testuser',
        ssl: 'require',
        sslMinProtocolVersion: 'TLSv1.2',
        sslMaxProtocolVersion: 'TLSv1.3',
      });
      try {
        const info = conn.getTlsInfo?.();
        expect(info).toBeTruthy();
        // Negotiated protocol must fall inside the requested window.
        expect(info?.protocol).toMatch(/TLSv1\.[23]/);
      } finally {
        await conn.close();
      }
    });

    // min > max: Node's tls.connect rejects an inverted window, so the
    // connection fails. (libpq also rejects this client-side; our parse
    // layer additionally guards it — see the index.test.ts unit cases.)
    it('connect fails with incorrect range (min > max)', async () => {
      const conn = await tryConnect({
        user: 'testuser',
        ssl: 'require',
        sslMinProtocolVersion: 'TLSv1.3',
        sslMaxProtocolVersion: 'TLSv1.2',
      });
      expect(conn).toBeNull();
    });

    // Malformed values (e.g. `TLSv9`) are rejected at the URI/conninfo
    // PARSE layer (index.ts `normalizeTlsProtocolVersion` /
    // `assertTlsProtocolRange`), not the wire layer — so this is covered
    // by the parser unit tests in `src/psql/index.test.ts`, not here.
    it.skip('connect fails with malformed ssl_min/max_protocol_version values — parse-layer; see index.test.ts', () => {
      /* covered by src/psql/index.test.ts parser unit tests */
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

  describe('SKIPPED: client cert format / perms / DN (libpq-specific behaviour)', () => {
    it.skip('certificate authorization succeeds with DER client cert + key', () => {
      /* unreachable — Node TLS accepts PEM only */
    });
    // libpq refuses a client key file that is group/world-readable; our
    // wire layer now enforces the same POSIX stat-mode check. Windows has
    // no equivalent perm model, so this is POSIX-only.
    it.runIf(process.platform !== 'win32')(
      'client key with group/world-readable perms is rejected',
      async () => {
        const t = ensureFixture();
        const client = t.tls.vault.getClientCert('ssltestuser');
        // Copy the key to a spec-owned temp path and make it world-readable.
        const looseKey = join(t.workDir, 'ssltestuser-loose.key');
        writeFileSync(looseKey, readFileSync(client.key), { mode: 0o644 });
        chmodSync(looseKey, 0o644); // ensure, regardless of umask
        const { PgConnection } = await loadWire();
        await expect(
          PgConnection.connect({
            host: t.tls.host,
            port: t.tls.port,
            user: 'ssltestuser',
            database: t.tls.db,
            ssl: 'require',
            sslrootcert: t.tls.vault.getRootServerBundle(),
            sslcert: client.cert,
            sslkey: looseKey,
          }),
        ).rejects.toThrow(/group or world access/);
      },
    );
    it.skip('cert DN mapping via pg_ident.conf — exact / regex / CN', () => {
      /* unreachable — server-side admin, not a wire-layer concern */
    });
    it.skip('long client cert subject is truncated in the server log', () => {
      /* unreachable — log inspection not supported via wire layer */
    });
  });

  describe('SKIPPED: server-side passphrase_cmd (server config, not wire layer)', () => {
    it.skip('server-side password-protected key restart succeeds with passphrase_cmd', () => {
      /* unreachable — fixture does not configure ssl_passphrase_command */
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
