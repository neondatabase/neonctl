// Port of upstream PostgreSQL's `src/test/ssl/t/003_sslinfo.pl`.
//
// Upstream reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/test/ssl/t/003_sslinfo.pl
//
// Why this is a CLIENT test, not a server-extension test
// ---------------------------------------------------------------------------
// The `sslinfo` contrib extension is server-side, but it is the OBSERVABILITY
// mechanism, not the subject: each query asserts something about what *our
// client* negotiated and presented over TLS — the negotiated protocol
// version (proves `ssl_min/max_protocol_version` was honored), the cipher
// (consistent with `pg_stat_ssl`), whether a client cert was sent (proves
// `sslcertmode` and cert presentation), and the cert's CN / serial / issuer.
// So this exercises the wire layer's TLS + client-cert behavior end-to-end,
// from the server's authoritative point of view.
//
// `sslinfo` ships in the `postgres:18.0` image's contrib set; the spec
// creates it in beforeAll (superuser) so the fixture's shared init isn't
// affected for the other TLS specs.

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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DIST_WIRE = join(REPO_ROOT, 'dist', 'psql', 'wire', 'connection.js');

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const OPENSSL_OK = isOpensslAvailable();
const DIST_EXISTS = existsSync(DIST_WIRE);
const SHOULD_RUN = RUN_INTEGRATION && OPENSSL_OK && DIST_EXISTS;

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
  sslcert?: string;
  sslkey?: string;
  sslrootcert?: string;
  sslcertmode?: 'disable' | 'allow' | 'require';
  sslMinProtocolVersion?: string;
  sslMaxProtocolVersion?: string;
};

type WireModule = {
  PgConnection: { connect(opts: WireOpts): Promise<WireConn> };
};

let wireMod: WireModule | null = null;
const loadWire = async (): Promise<WireModule> => {
  if (wireMod) return wireMod;
  wireMod = (await import(pathToFileURL(DIST_WIRE).href)) as WireModule;
  return wireMod;
};

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('tap/003_sslinfo (gate)', () => {
  if (!RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1 (set env to run)', () => {});
  } else if (!OPENSSL_OK) {
    it.skip('skipped: openssl not on PATH (required for cert generation)', () => {});
  } else if (!DIST_EXISTS) {
    it.skip('skipped: dist/psql/wire/connection.js missing — run `bun run build` first', () => {});
  } else {
    it('gates open', () => {
      expect(true).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tls: TlsPgConn | null = null;
const ensureTls = (): TlsPgConn => {
  if (!tls) throw new Error('tap/003_sslinfo: tls fixture missing');
  return tls;
};

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  tls = await setupTlsPg();
  // Create the sslinfo extension (superuser) in the test database. Scoped
  // here so the shared fixture init stays untouched for the other specs.
  const { PgConnection } = await loadWire();
  const admin = await PgConnection.connect({
    host: tls.host,
    port: tls.port,
    user: tls.user,
    password: tls.password,
    database: tls.db,
    ssl: 'prefer',
  });
  try {
    await admin.execSimple('CREATE EXTENSION IF NOT EXISTS sslinfo');
  } finally {
    await admin.close();
  }
}, 180_000);

afterAll(async () => {
  if (!SHOULD_RUN) return;
  await teardownTlsPg();
  tls = null;
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Connect as ssltestuser presenting its client cert (cert HBA). */
const connectWithCert = async (
  extra: Partial<WireOpts> = {},
): Promise<WireConn> => {
  const t = ensureTls();
  const cert = t.vault.getClientCert('ssltestuser');
  const { PgConnection } = await loadWire();
  return PgConnection.connect({
    host: t.host,
    port: t.port,
    user: 'ssltestuser',
    database: t.db,
    ssl: 'require',
    sslrootcert: t.vault.getRootServerBundle(),
    sslcert: cert.cert,
    sslkey: cert.key,
    ...extra,
  });
};

/** Run a single-column / single-row query and return the scalar as a string. */
const scalar = async (conn: WireConn, sql: string): Promise<string> => {
  const rs = await conn.execSimple(sql);
  const v = rs[rs.length - 1]?.rows[0]?.[0];
  return v === null || v === undefined ? '' : String(v);
};

// ---------------------------------------------------------------------------
// Subtests
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/003_sslinfo', () => {
  it('ssl_is_used() is true over a TLS connection', async () => {
    const conn = await connectWithCert();
    try {
      expect(await scalar(conn, 'SELECT ssl_is_used()')).toBe('t');
    } finally {
      await conn.close();
    }
  });

  it('ssl_version() reflects the client-requested protocol bounds', async () => {
    // Pin both bounds to TLSv1.2 — proves the wire layer honored
    // ssl_min/max_protocol_version (the negotiated version is observed
    // server-side).
    const conn = await connectWithCert({
      sslMinProtocolVersion: 'TLSv1.2',
      sslMaxProtocolVersion: 'TLSv1.2',
    });
    try {
      expect(await scalar(conn, 'SELECT ssl_version()')).toBe('TLSv1.2');
    } finally {
      await conn.close();
    }
  });

  it('ssl_cipher() agrees with pg_stat_ssl', async () => {
    const conn = await connectWithCert();
    try {
      const eq = await scalar(
        conn,
        'SELECT ssl_cipher() = cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      );
      expect(eq).toBe('t');
    } finally {
      await conn.close();
    }
  });

  it('ssl_client_cert_present() is true when a client cert is sent', async () => {
    const conn = await connectWithCert();
    try {
      expect(await scalar(conn, 'SELECT ssl_client_cert_present()')).toBe('t');
    } finally {
      await conn.close();
    }
  });

  it('ssl_client_cert_present() is false without a client cert', async () => {
    const t = ensureTls();
    const { PgConnection } = await loadWire();
    // testuser matches a non-cert HBA rule, so a TLS connection without a
    // client cert authenticates and reports no peer cert.
    const conn = await PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'testuser',
      database: t.db,
      ssl: 'require',
      sslrootcert: t.vault.getRootServerBundle(),
    });
    try {
      expect(await scalar(conn, 'SELECT ssl_client_cert_present()')).toBe('f');
    } finally {
      await conn.close();
    }
  });

  it('ssl_client_serial() agrees with pg_stat_ssl', async () => {
    const conn = await connectWithCert();
    try {
      const eq = await scalar(
        conn,
        'SELECT ssl_client_serial() = client_serial FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      );
      expect(eq).toBe('t');
    } finally {
      await conn.close();
    }
  });

  it('ssl_client_dn_field(commonName) is the cert CN', async () => {
    const conn = await connectWithCert();
    try {
      expect(
        await scalar(conn, "SELECT ssl_client_dn_field('commonName')"),
      ).toBe('ssltestuser');
    } finally {
      await conn.close();
    }
  });

  it('ssl_issuer_dn() agrees with pg_stat_ssl', async () => {
    const conn = await connectWithCert();
    try {
      const eq = await scalar(
        conn,
        'SELECT ssl_issuer_dn() = issuer_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      );
      expect(eq).toBe('t');
    } finally {
      await conn.close();
    }
  });

  it('ssl_extension_info() extracts basicConstraints from the client cert', async () => {
    const conn = await connectWithCert();
    try {
      // Assert the extracted VALUE (a leaf cert is CA:FALSE). Criticality is
      // a cert-minting detail of our fixture, not a client behavior.
      expect(
        await scalar(
          conn,
          "SELECT value FROM ssl_extension_info() WHERE name = 'basicConstraints'",
        ),
      ).toBe('CA:FALSE');
    } finally {
      await conn.close();
    }
  });

  // sslcertmode sanity, observed via ssl_client_cert_present() — directly
  // validates our client's cert-sending decision per mode.
  it('sslcertmode=allow sends the cert (present)', async () => {
    const conn = await connectWithCert({ sslcertmode: 'allow' });
    try {
      expect(await scalar(conn, 'SELECT ssl_client_cert_present()')).toBe('t');
    } finally {
      await conn.close();
    }
  });

  it('sslcertmode=require sends the cert (present)', async () => {
    const conn = await connectWithCert({ sslcertmode: 'require' });
    try {
      expect(await scalar(conn, 'SELECT ssl_client_cert_present()')).toBe('t');
    } finally {
      await conn.close();
    }
  });

  it('sslcertmode=disable withholds the cert (absent)', async () => {
    // ssltestuser requires a cert (verify-full HBA), so disabling the cert
    // makes auth fail — connect as testuser instead and confirm no cert is
    // sent even though one is configured.
    const t = ensureTls();
    const cert = t.vault.getClientCert('ssltestuser');
    const { PgConnection } = await loadWire();
    const conn = await PgConnection.connect({
      host: t.host,
      port: t.port,
      user: 'testuser',
      database: t.db,
      ssl: 'require',
      sslrootcert: t.vault.getRootServerBundle(),
      sslcert: cert.cert,
      sslkey: cert.key,
      sslcertmode: 'disable',
    });
    try {
      expect(await scalar(conn, 'SELECT ssl_client_cert_present()')).toBe('f');
    } finally {
      await conn.close();
    }
  });
});
