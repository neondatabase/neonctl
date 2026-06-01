// Port of upstream PostgreSQL's `src/test/ssl/t/002_scram.pl`.
//
// Upstream reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/test/ssl/t/002_scram.pl
//
// What this spec verifies
// ---------------------------------------------------------------------------
// SCRAM authentication combined with TLS channel binding. Concretely:
//
//   1. `channel_binding=invalid_value` is rejected at URI/conninfo parse
//      time (libpq parity: `invalid channel_binding value: "..."`).
//   2. SCRAM-SHA-256 over SSL with `channel_binding=disable` succeeds —
//      the auth layer falls back to plain SCRAM-SHA-256 and ignores
//      channel binding entirely.
//   3. SCRAM-SHA-256 over SSL with `channel_binding=require` succeeds —
//      the auth layer negotiates SCRAM-SHA-256-PLUS with the
//      `tls-server-end-point` binding type and the handshake completes.
//   4. MD5 over SSL with `channel_binding=require` fails — MD5 cannot
//      channel-bind, so a require-mode client must error out.
//   5. Cert authentication + `channel_binding=require` succeeds (the
//      `cert` HBA method skips password auth entirely; channel binding
//      is moot but the connection should not error on the flag).
//
// What's deferred (`it.todo`)
// ---------------------------------------------------------------------------
//   * `require_auth=<method>` combinations — our wire layer has no
//     `require_auth` plumbing yet. Engine gap, not test gap.
//   * RSA-PSS server cert + channel binding — `X509_get_signature_info`
//     branch in libpq, exercises a different OpenSSL surface. Out of
//     scope for now.
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
// (`scramuser`, `md5user`) and matching `hostssl` HBA rules were added
// to that fixture in this PR — see the INIT_SQL block there.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isOpensslAvailable,
  setupTlsPg,
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
  //    MD5 has no channel-binding capability. The client must reject
  //    instead of silently downgrading. Upstream asserts a specific
  //    error pattern; we assert the connection FAILED — the engine's
  //    diagnostic wording may differ from libpq's verbatim ("channel
  //    binding required but not supported by server's authentication
  //    request"), so we don't pin the exact string.
  // -------------------------------------------------------------------------
  it('MD5 + SSL + channel_binding=require fails', async () => {
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
    ).rejects.toBeInstanceOf(Error);
  });

  // -------------------------------------------------------------------------
  // 5. Cert auth + channel_binding=require succeeds.
  //
  //    The `cert` HBA method (clientcert=verify-full) skips password
  //    authentication entirely — channel binding has no SCRAM flow to
  //    attach to. The connection should NOT error on the flag.
  // -------------------------------------------------------------------------
  it('cert auth + SSL + channel_binding=require succeeds', async () => {
    const wire = await loadWire();
    const t = ensureTls();
    const userCert = t.vault.getClientCert('ssltestuser');
    const conn = await wire.PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'ssltestuser',
      database: t.db,
      ssl: 'require',
      sslcert: userCert.cert,
      sslkey: userCert.key,
      sslrootcert: t.vault.getRootServerBundle(),
      channelBinding: 'require',
    });
    try {
      const rs = await conn.execSimple("SELECT 'cert-require'");
      expect(rs.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // Deferred — require_auth not implemented in our wire layer yet. Each
  // upstream subtest carries a precise reason so the next pass can pick
  // up exactly the right thread.
  // -------------------------------------------------------------------------

  it.todo(
    'require_auth=scram-sha-256 + channel_binding=disable — wire layer has no `require_auth` plumbing yet',
  );
  it.todo('require_auth=md5 + channel_binding=require — same gap as above');
  it.todo(
    'require_auth=scram-sha-256 + channel_binding=require — same gap as above',
  );

  // -------------------------------------------------------------------------
  // RSA-PSS server certificate + channel binding.
  //
  // Upstream gates this on `HAVE_X509_GET_SIGNATURE_INFO` and only runs
  // when the build's OpenSSL is recent enough. Our fixture mints only
  // RSA-PKCS1 certs today; minting an RSA-PSS leaf would require a
  // separate vault entry. Out of scope until someone needs it.
  // -------------------------------------------------------------------------

  it.todo(
    'SCRAM + SSL + channel_binding=require with an RSA-PSS server cert — requires fixture extension to mint an RSA-PSS leaf',
  );
});
