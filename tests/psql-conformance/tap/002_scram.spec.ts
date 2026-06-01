// Port of upstream PostgreSQL's `src/test/ssl/t/002_scram.pl`.
//
// Upstream reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/test/ssl/t/002_scram.pl
//
// What this spec verifies
// ---------------------------------------------------------------------------
// SCRAM authentication combined with TLS channel binding and
// `require_auth`. Concretely:
//
//   1. `channel_binding=invalid_value` rejected at URI/conninfo parse
//      (libpq parity: `invalid channel_binding value: "..."`).
//   2. SCRAM-SHA-256 + SSL + `channel_binding=disable` connects (plain
//      SCRAM, no PLUS).
//   3. SCRAM-SHA-256 + SSL + `channel_binding=require` connects
//      (auto-negotiates SCRAM-SHA-256-PLUS, `tls-server-end-point`).
//   4. MD5 + SSL + `channel_binding=require` FAILS — libpq wording:
//      "channel binding required but not supported by server's
//      authentication request".
//   5. cert auth + SSL + `channel_binding=require` FAILS — libpq wording:
//      "channel binding required, but server authenticated client
//      without channel binding" (the `cert` HBA method skips SASL
//      entirely, so cb=require has nothing to attach to).
//   6. `require_auth=scram-sha-256` + `channel_binding=disable` connects.
//   7. `require_auth=md5` (satisfied) + `channel_binding=require` FAILS
//      with the cb wording — cb check fires before require_auth would
//      have been validated, so the cb error wins.
//   8. `require_auth=scram-sha-256` + `channel_binding=require` connects.
//   9. SCRAM + SSL + `channel_binding=require` against an RSA-PSS server
//      cert connects (upstream bug #17760 / HAVE_X509_GET_SIGNATURE_INFO
//      branch — we mint an rsassaPss leaf in CertVault and swap the
//      active cert at runtime).
//
// What's covered by sibling unit tests (NOT re-run here)
// ---------------------------------------------------------------------------
//   * SCRAM-SHA-256 / SCRAM-SHA-256-PLUS message round-trips: RFC 7677
//     vectors in `src/psql/wire/sasl.test.ts`.
//   * `tls-server-end-point` channel-binding-material extraction:
//     `src/psql/wire/tls.test.ts`.
//
// Fixture
// ---------------------------------------------------------------------------
// Uses the shared `pg-fixture-tls.ts` container. Two additional users
// (`scramuser`, `md5user`) and matching `hostssl` HBA rules are wired
// into that fixture, along with an RSA-PSS server leaf cert (`pss`) in
// the CertVault.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isOpensslAvailable,
  setupTlsPg,
  switchServerCertSql,
  teardownTlsPg,
  type TlsPgConn,
} from '../harness/pg-fixture-tls.js';

import { makeLauncher, runChild } from './_helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DIST_WIRE = join(REPO_ROOT, 'dist', 'psql', 'wire', 'connection.js');

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const OPENSSL_OK = isOpensslAvailable();
const DIST_EXISTS = existsSync(DIST_WIRE);
const SHOULD_RUN = RUN_INTEGRATION && OPENSSL_OK && DIST_EXISTS;

// ---------------------------------------------------------------------------
// Wire-layer module surface (mirrors 001_ssltests).
// ---------------------------------------------------------------------------

type WireConn = {
  execSimple(sql: string): Promise<{ rows: unknown[][] }[]>;
  close(): Promise<void>;
};

type WireOpts = {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  channelBinding?: 'disable' | 'prefer' | 'require';
  /**
   * Structural mirror of `RequireAuthPolicy` from the wire types — kept
   * inline so the conformance tsconfig doesn't need to extend its
   * rootDir into src/.
   */
  requireAuth?: { methods: ReadonlySet<string>; negated: boolean };
  sslcert?: string;
  sslkey?: string;
  sslrootcert?: string;
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
// Gate suite — same pattern as 001_ssltests.
// ---------------------------------------------------------------------------

describe('tap/002_scram (gate)', () => {
  if (!RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1 (set env to run)', () => {
      /* unreachable */
    });
  } else if (!OPENSSL_OK) {
    it.skip('skipped: openssl not on PATH (required for fixture cert generation)', () => {
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
// Fixture bootstrap.
// ---------------------------------------------------------------------------

let tls: TlsPgConn | null = null;

const ensureTls = (): TlsPgConn => {
  if (!tls) {
    throw new Error(
      'tap/002_scram: tls fixture missing — beforeAll did not complete',
    );
  }
  return tls;
};

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  tls = await setupTlsPg();
}, 180_000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  await teardownTlsPg();
  tls = null;
}, 60_000);

// ---------------------------------------------------------------------------
// Subtests.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/002_scram', () => {
  // -------------------------------------------------------------------------
  // 1. `channel_binding=invalid_value` rejected at URI parse time.
  //
  //    Upstream wording: `invalid channel_binding value: "invalid_value"`.
  //    Our `normalizeChannelBinding` now throws with that exact message.
  //    Drive through `dist/psql/cli.js` so we exercise the full URI/conninfo
  //    parse pathway and observe the diagnostic on stderr, mirroring
  //    upstream's `connect_fails`.
  // -------------------------------------------------------------------------
  it('channel_binding=invalid_value is rejected with the libpq diagnostic', async () => {
    const t = ensureTls();
    const uri =
      `postgresql://${encodeURIComponent(t.user)}:${encodeURIComponent(t.password)}` +
      `@${t.host}:${String(t.port)}/${encodeURIComponent(t.db)}` +
      `?sslmode=require&channel_binding=invalid_value`;
    const launcher = makeLauncher('002-scram-invalid').launcher;
    const r = await runChild({
      launcher,
      argv: [uri, '-c', 'SELECT 1'],
      timeoutMs: 30_000,
    });
    expect(r.exitCode, `exit (stderr=${r.stderr})`).not.toBe(0);
    expect(r.stderr).toMatch(/invalid channel_binding value: "invalid_value"/);
  });

  // -------------------------------------------------------------------------
  // 2. SCRAM-SHA-256 + SSL + channel_binding=disable connects.
  //
  //    The auth layer should ignore channel binding entirely and complete
  //    plain SCRAM-SHA-256. Verifies the explicit `disable` opt-out works.
  // -------------------------------------------------------------------------
  it('SCRAM + SSL + channel_binding=disable connects', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    const conn = await wire.PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'scramuser',
      password: 'pencil',
      database: t.db,
      ssl: 'require',
      channelBinding: 'disable',
    });
    try {
      const rs = await conn.execSimple("SELECT 'scram-disable'");
      expect(rs.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // 3. SCRAM-SHA-256 + SSL + channel_binding=require connects.
  //
  //    The wire layer auto-negotiates SCRAM-SHA-256-PLUS with the
  //    `tls-server-end-point` binding type when TLS is in effect AND the
  //    server advertises the mechanism. With `channel_binding=require`,
  //    the client must NOT downgrade to plain SCRAM — succeeding here
  //    proves the PLUS handshake reached the verifier-comparison step.
  // -------------------------------------------------------------------------
  it('SCRAM + SSL + channel_binding=require connects (uses SCRAM-SHA-256-PLUS)', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    const conn = await wire.PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'scramuser',
      password: 'pencil',
      database: t.db,
      ssl: 'require',
      channelBinding: 'require',
    });
    try {
      const rs = await conn.execSimple("SELECT 'scram-require'");
      expect(rs.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // 4. MD5 + SSL + channel_binding=require fails.
  //
  //    MD5 has no channel-binding capability. With cb=require the client
  //    must refuse the AuthenticationMD5Password request before sending
  //    credentials. Upstream wording (asserted verbatim): "channel binding
  //    required but not supported by server's authentication request".
  // -------------------------------------------------------------------------
  it('MD5 + SSL + channel_binding=require fails with libpq wording', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    await expect(
      wire.PgConnection.connect({
        host: t.host,
        port: t.port,
        user: 'md5user',
        password: 'pencil',
        database: t.db,
        ssl: 'require',
        channelBinding: 'require',
      }),
    ).rejects.toThrow(
      /channel binding required but not supported by server's authentication request/,
    );
  });

  // -------------------------------------------------------------------------
  // 5. Cert auth + channel_binding=require FAILS (upstream parity).
  //
  //    The `cert` HBA method (clientcert=verify-full) authenticates the
  //    client via the TLS-layer cert and the server sends AuthenticationOk
  //    without any SASL exchange. With cb=require the client must refuse —
  //    no SCRAM channel binding actually took place. Upstream wording:
  //    "channel binding required, but server authenticated client without
  //    channel binding" (note the comma — libpq has it, MD5 wording does
  //    not).
  // -------------------------------------------------------------------------
  it('cert auth + SSL + channel_binding=require fails (no SCRAM took place)', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    const userCert = t.vault.getClientCert('ssltestuser');
    await expect(
      wire.PgConnection.connect({
        host: t.host,
        port: t.port,
        user: 'ssltestuser',
        database: t.db,
        ssl: 'require',
        sslcert: userCert.cert,
        sslkey: userCert.key,
        sslrootcert: t.vault.getRootServerBundle(),
        channelBinding: 'require',
      }),
    ).rejects.toThrow(
      /channel binding required, but server authenticated client without channel binding/,
    );
  });

  // -------------------------------------------------------------------------
  // 6. require_auth=scram-sha-256 + channel_binding=disable connects.
  //
  //    require_auth=scram-sha-256 demands a SASL exchange; the server
  //    sends AuthenticationSASL for scramuser, the wire-level check
  //    permits it, channel binding is opted out, and the plain SCRAM
  //    handshake completes.
  // -------------------------------------------------------------------------
  it('require_auth=scram-sha-256 + channel_binding=disable connects', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    const conn = await wire.PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'scramuser',
      password: 'pencil',
      database: t.db,
      ssl: 'require',
      channelBinding: 'disable',
      requireAuth: { methods: new Set(['scram-sha-256']), negated: false },
    });
    try {
      const rs = await conn.execSimple("SELECT 'scram-require-auth-disable'");
      expect(rs.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // 7. require_auth=md5 (satisfied) + channel_binding=require (cannot be
  //    satisfied) — the channel-binding error fires *even though*
  //    require_auth was met.
  //
  //    Mirrors upstream `channel_binding can fail even when require_auth
  //    succeeds`. Asserts the cb wording wins over the require_auth
  //    wording — the ordering matters: cb check runs first in the
  //    AuthenticationMD5Password branch.
  // -------------------------------------------------------------------------
  it('require_auth=md5 + channel_binding=require fails on cb (require_auth satisfied)', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    await expect(
      wire.PgConnection.connect({
        host: t.host,
        port: t.port,
        user: 'md5user',
        password: 'pencil',
        database: t.db,
        ssl: 'require',
        channelBinding: 'require',
        requireAuth: { methods: new Set(['md5']), negated: false },
      }),
    ).rejects.toThrow(
      /channel binding required but not supported by server's authentication request/,
    );
  });

  // -------------------------------------------------------------------------
  // 8. require_auth=scram-sha-256 + channel_binding=require connects.
  //
  //    Combination of #3 and #6 — the strictest viable case. The server
  //    must offer SCRAM-SHA-256-PLUS (TLS is up + scram-sha-256 password
  //    encryption), the wire layer negotiates PLUS, require_auth permits
  //    scram-sha-256, and the connection completes.
  // -------------------------------------------------------------------------
  it('require_auth=scram-sha-256 + channel_binding=require connects', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    const conn = await wire.PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'scramuser',
      password: 'pencil',
      database: t.db,
      ssl: 'require',
      channelBinding: 'require',
      requireAuth: { methods: new Set(['scram-sha-256']), negated: false },
    });
    try {
      const rs = await conn.execSimple("SELECT 'scram-require-auth-require'");
      expect(rs.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // 9. SCRAM + SSL + channel_binding=require with an RSA-PSS server cert.
  //
  //    Verifies that the wire layer doesn't choke on a server cert whose
  //    SubjectPublicKeyInfo is `rsassaPss` (upstream bug #17760). Channel
  //    binding uses `tls-server-end-point`, which hashes the server cert
  //    via the signature algorithm's digest — Node's TLS layer must
  //    expose the correct hash for RSA-PSS, otherwise PLUS verification
  //    fails.
  //
  //    Switches the active server cert to the RSA-PSS leaf, then connects.
  //    Runs LAST in this file so the cert swap doesn't leak to other
  //    subtests. (Each spec gets its own fixture instance via
  //    `setupTlsPg()`, but the cert state still mutates on disk + GUC
  //    within the lifetime of this one.)
  // -------------------------------------------------------------------------
  it('SCRAM + SSL + channel_binding=require connects against an RSA-PSS server cert', async () => {
    const wire = await loadWire();
    const t = ensureTls();

    // Switch the active server cert via ALTER SYSTEM + pg_reload_conf.
    // Connect as the testcontainers superuser (default `testuser`) over
    // sslmode=prefer so the switch itself isn't blocked by a half-loaded
    // cert state.
    const admin = await wire.PgConnection.connect({
      host: t.host,
      port: t.port,
      user: t.user,
      password: t.password,
      database: t.db,
      ssl: 'prefer',
    });
    try {
      for (const stmt of switchServerCertSql('pss')) {
        await admin.execSimple(stmt);
      }
      await admin.execSimple('SELECT pg_reload_conf()');
    } finally {
      await admin.close();
    }
    // pg_reload_conf is async; the next SSL handshake picks up the new
    // cert after a beat.
    await new Promise((r) => setTimeout(r, 250));

    const conn = await wire.PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'scramuser',
      password: 'pencil',
      database: t.db,
      ssl: 'require',
      channelBinding: 'require',
    });
    try {
      const rs = await conn.execSimple("SELECT 'pss-cert-require'");
      expect(rs.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });
});
