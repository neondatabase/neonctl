// "Real-DNS" companion to `004_load_balance_dns.spec.ts`.
//
// The sibling spec exercises the DNS fan-out engine logic with the
// `_dnsLookupAll` test seam — portable across the whole matrix because
// it doesn't depend on the host's resolver OR on binding to
// 127.0.0.{1,2,3}. This file exercises the SAME assertions with the
// REAL `dns.lookup` against the custom docker fixture at
// `tests/psql-conformance/fixtures/loadbalance-dns/`:
//
//   - The fixture container runs 3 independent postgres clusters bound
//     to 127.0.0.1 / 127.0.0.2 / 127.0.0.3 on port 5432.
//   - The CI runner's `/etc/hosts` maps `pg-loadbalancetest` to all
//     three addresses.
//   - Our wire layer's `expandHostsViaDns` calls Node's `dns.lookup` and
//     fans the hostname out to those three IPs; the iterator hits each
//     in turn.
//
// Gates
// ---------------------------------------------------------------------------
// Off by default. Only runs when:
//
//   - `LOAD_BALANCE_REAL=1` is set in the env (the CI job exports it).
//   - The runner is Linux (the fixture binds to 127.0.0.2 / 127.0.0.3,
//     which works without alias setup on Linux only).
//
// This separation keeps the matrix portable on macOS/Windows. The CI
// pipeline opts in explicitly via `LOAD_BALANCE_REAL=1` in a dedicated
// `loadbalance-dns` job (see `.github/workflows/psql-conformance.yml`).
//
// External infrastructure assumed:
//
//   1. The fixture container is already running with `--network=host`
//      (so its postgres processes bind to the host's 127.0.0.{1,2,3}).
//   2. `/etc/hosts` on the runner has the three `pg-loadbalancetest`
//      entries — that's what `dns.lookup(host, {all: true})` reads.
//
// Both bits live in the CI job that runs this spec, not in the spec
// itself. Keeps test setup / teardown matched to its environment.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as dns from 'node:dns/promises';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DIST_WIRE = join(REPO_ROOT, 'dist', 'psql', 'wire', 'connection.js');

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const DIST_EXISTS = existsSync(DIST_WIRE);
const LOAD_BALANCE_REAL = process.env.LOAD_BALANCE_REAL === '1';
const IS_LINUX = process.platform === 'linux';

const SHOULD_RUN =
  RUN_INTEGRATION && DIST_EXISTS && LOAD_BALANCE_REAL && IS_LINUX;

const HOSTNAME = 'pg-loadbalancetest';
const PORT = 5432;

// ---------------------------------------------------------------------------
// Wire-layer module surface (same shape as the sibling spec).
// ---------------------------------------------------------------------------

type WireConn = {
  port: number;
  host: string;
  execSimple(sql: string): Promise<{ rows: unknown[][] }[]>;
  close(): Promise<void>;
};

type WireOpts = {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl: 'disable';
  loadBalanceHosts?: 'disable' | 'random';
};

type WireModule = {
  PgConnection: {
    connect(opts: WireOpts): Promise<WireConn>;
    _loadBalanceRng: (() => number) | null;
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
// Gate suite.
// ---------------------------------------------------------------------------

describe('tap/004_load_balance_dns_real (gate)', () => {
  if (!LOAD_BALANCE_REAL) {
    it.skip('skipped: LOAD_BALANCE_REAL != 1 (real-DNS spec only runs in the dedicated CI job)', () => {
      /* unreachable */
    });
  } else if (!IS_LINUX) {
    it.skip('skipped: real-DNS spec needs Linux for 127.0.0.2/3 loopback bindings', () => {
      /* unreachable */
    });
  } else if (!RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1', () => {
      /* unreachable */
    });
  } else if (!DIST_EXISTS) {
    it.skip('skipped: dist/psql/wire/connection.js missing', () => {
      /* unreachable */
    });
  } else {
    it('gates open: real-DNS load-balance suite is enabled', () => {
      expect(SHOULD_RUN).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Pre-flight: verify the runner's resolver actually sees the three IPs.
// If /etc/hosts wasn't seeded the rest of the suite would fail in confusing
// ways, so we surface a diagnostic at the very first test.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/004_load_balance_dns_real', () => {
  it('precondition: /etc/hosts resolves pg-loadbalancetest to 3 distinct IPs', async () => {
    const addrs = await dns.lookup(HOSTNAME, { all: true });
    const ips = new Set(addrs.map((a) => a.address));
    expect(
      ips.size,
      `pg-loadbalancetest should resolve to 3 distinct IPs; got ${JSON.stringify(
        [...ips],
      )}`,
    ).toBe(3);
    expect(ips.has('127.0.0.1')).toBe(true);
    expect(ips.has('127.0.0.2')).toBe(true);
    expect(ips.has('127.0.0.3')).toBe(true);
  });

  it('precondition: each of the 3 IPs has a reachable postgres on port 5432', async () => {
    const wire = await loadWire();
    for (const ip of ['127.0.0.1', '127.0.0.2', '127.0.0.3']) {
      const conn = await wire.PgConnection.connect({
        host: ip,
        port: PORT,
        user: 'postgres',
        database: 'postgres',
        ssl: 'disable',
      });
      try {
        const rs = await conn.execSimple("SELECT 'ok'");
        expect(rs.length).toBeGreaterThan(0);
      } finally {
        await conn.close();
      }
    }
  });

  // -------------------------------------------------------------------------
  // Upstream `connect1`: load_balance_hosts=disable lands on the first
  // DNS-returned IP (libpq's getaddrinfo result order is implementation-
  // defined but stable across calls; we don't pin which IP comes first,
  // only that exactly one is hit and `conn.host` reports the hostname).
  // -------------------------------------------------------------------------
  it('load_balance_hosts=disable connects to one of the DNS IPs (upstream connect1)', async () => {
    const wire = await loadWire();
    const conn = await wire.PgConnection.connect({
      host: HOSTNAME,
      port: PORT,
      user: 'postgres',
      database: 'postgres',
      ssl: 'disable',
      loadBalanceHosts: 'disable',
    });
    try {
      // `conn.host` is the original hostname (TLS-stable identity), not
      // the resolved IP.
      expect(conn.host).toBe(HOSTNAME);
      expect(conn.port).toBe(PORT);
      // Sanity: a query goes through.
      const rs = await conn.execSimple("SELECT 'connect1'");
      expect(rs.length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // Upstream `connect2`: load_balance_hosts=random distributes across
  // the 3 IPs. Upstream's perl test runs 50 random connections and
  // asserts each node sees at least one (p ≈ 1.6e-9 of a miss). We
  // mirror that property with the SAME 50-sample approach — fast enough
  // on a CI runner (each connect is ~5 ms over loopback) and faithful
  // to upstream's distribution claim.
  //
  // To prove a connection actually landed on a specific IP we run
  // `SELECT inet_server_addr()` on each session — the backend reports
  // its listen address, so we KNOW which IP we hit. Three distinct
  // values across 50 trials = pass.
  // -------------------------------------------------------------------------
  it('load_balance_hosts=random distributes 50 connections across all 3 IPs (upstream connect2)', async () => {
    const wire = await loadWire();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const conn = await wire.PgConnection.connect({
        host: HOSTNAME,
        port: PORT,
        user: 'postgres',
        database: 'postgres',
        ssl: 'disable',
        loadBalanceHosts: 'random',
      });
      try {
        const rs = await conn.execSimple(
          'SELECT inet_server_addr()::text AS ip',
        );
        const ip = String(rs[0].rows[0][0]);
        seen.add(ip);
      } finally {
        await conn.close();
      }
      // Short-circuit once we've hit all three; keeps the test cheap.
      if (seen.size === 3) break;
    }
    expect(
      seen.size,
      `expected to hit all 3 IPs across 50 random connections; ` +
        `actually saw: ${JSON.stringify([...seen])}`,
    ).toBe(3);
  }, 60_000);
});
