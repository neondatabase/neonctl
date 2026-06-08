// Port of upstream PostgreSQL's
// `src/interfaces/libpq/t/004_load_balance_dns.pl`.
//
// Upstream reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/interfaces/libpq/t/004_load_balance_dns.pl
//
// What this test verifies
// ---------------------------------------------------------------------------
// libpq, given a SINGLE hostname whose DNS lookup returns multiple A
// records, iterates ALL returned IPs (sequentially with `load_balance_
// hosts=disable`, randomly with `load_balance_hosts=random`):
//
//   host=pg-loadbalancetest load_balance_hosts=random
//   ^^^^^^^^^^^^^^^^^^^^^^^^ one hostname → multiple IPs from DNS
//
// Our wire layer's `expandHostsViaDns` (added in commit a5cf5ec) calls
// `dns.lookup(host, { all: true })` and fans out to one candidate per
// returned address. The `_dnsLookupAll` test seam lets this spec drive
// a known address set without touching the real resolver — pivotal for
// the macOS matrix slot, where binding to 127.0.0.2/3 isn't a thing.
//
// Upstream's own test setup
// ---------------------------------------------------------------------------
// Upstream skips by default (PG_TEST_EXTRA=load_balance + root /etc/hosts
// edits + 3 postgres clusters bound to 127.0.0.{1,2,3}:5432, all on the
// same port). We diverge from that topology to keep the matrix portable:
// 3 testcontainer postgres on different PORTS on 127.0.0.1, and the DNS
// seam returns IPs that — combined with the user-supplied (host, port)
// pairs — exercise the same code path (`expandHostsViaDns` →
// shuffleInPlace → connect loop). The remaining DIVERGENCE from the
// upstream test is the "one hostname, multiple A records, all same
// port" topology; we have the wire infrastructure ready for that day
// (custom Dockerfile + entrypoint at `fixtures/loadbalance-dns/`) but
// the matrix exercises the fan-out code via the seam.
//
// Why a real-server integration spec on top of the unit tests
// ---------------------------------------------------------------------------
// `connection.test.ts` covers the fan-out logic against a mock server
// with `_dnsLookupAll` injected. This spec re-exercises the same code
// path against a LIVE postgres so the round-trip (`expandHostsViaDns`
// → openSocket → TLS skip (sslmode=disable) → startup + auth) is
// validated as a whole. Catches the kind of breakage a unit test would
// miss — e.g. the candidate-address-host getting mishandled inside
// `connectSingle`.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DIST_WIRE = join(REPO_ROOT, 'dist', 'psql', 'wire', 'connection.js');

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const DIST_EXISTS = existsSync(DIST_WIRE);
const SHOULD_RUN = RUN_INTEGRATION && DIST_EXISTS;

const PG_IMAGE_DEFAULT = 'postgres:18.0';
const HOSTNAME = 'pg-loadbalancetest';

// ---------------------------------------------------------------------------
// Wire-layer module surface — same dynamic-import pattern as 003.
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
  hosts?: { host: string; port: number }[];
  loadBalanceHosts?: 'disable' | 'random';
};

type DnsResult = { address: string; family: number };
type DnsLookupAll = ((host: string) => Promise<DnsResult[]>) | null;

type WireModule = {
  PgConnection: {
    connect(opts: WireOpts): Promise<WireConn>;
    _loadBalanceRng: (() => number) | null;
    _dnsLookupAll: DnsLookupAll;
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
// Gate suite — explains the closed gate when conditions aren't met.
// ---------------------------------------------------------------------------

describe('tap/004_load_balance_dns (gate)', () => {
  if (!RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1 (set env to run)', () => {
      /* unreachable */
    });
  } else if (!DIST_EXISTS) {
    it.skip('skipped: dist/psql/wire/connection.js missing — run `bun run build` first', () => {
      /* unreachable */
    });
  } else {
    it('gates open: RUN_INTEGRATION=1, dist present', () => {
      expect(SHOULD_RUN).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// testcontainers boot — mirrors the 003 spec's pattern. We boot 3
// independent postgres on different ports (all on 127.0.0.1) so the
// matrix doesn't need /etc/hosts edits OR Linux loopback aliases. The
// DNS seam below makes our wire layer "see" the same hostname for all
// three connections, which is what triggers the DNS fan-out code path.
// ---------------------------------------------------------------------------

type NodeInfo = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

type StartedContainer = {
  getHost(): string;
  getPort(): number;
  getUsername(): string;
  getPassword(): string;
  getDatabase(): string;
  stop(): Promise<unknown>;
};

type ContainerCtor = new (image: string) => Builder;

type Builder = {
  start(): Promise<StartedContainer>;
};

let nodeContainers: StartedContainer[] = [];
let nodes: NodeInfo[] = [];

const bootThreeNodes = async (): Promise<NodeInfo[]> => {
  const moduleName = '@testcontainers/postgresql';
  let mod: { PostgreSqlContainer?: unknown };
  try {
    mod = (await import(moduleName)) as { PostgreSqlContainer?: unknown };
  } catch {
    throw new Error(
      '004_load_balance_dns: @testcontainers/postgresql is not installed.',
    );
  }
  const ctor = mod.PostgreSqlContainer as ContainerCtor | undefined;
  if (typeof ctor !== 'function') {
    throw new Error(
      '004_load_balance_dns: @testcontainers/postgresql does not export PostgreSqlContainer.',
    );
  }
  const image = process.env.PGCONFORMANCE_PG_IMAGE ?? PG_IMAGE_DEFAULT;
  const builders: Builder[] = [
    new ctor(image),
    new ctor(image),
    new ctor(image),
  ];
  const started: StartedContainer[] = await Promise.all(
    builders.map((b) => b.start()),
  );
  nodeContainers = started;
  return started.map((c) => {
    // testcontainers' `getHost()` is `localhost` on local docker.
    // Normalise so the spec's port-distribution assertions don't depend
    // on the OS's IPv4/IPv6 resolution order.
    const rawHost = c.getHost();
    const host = rawHost === 'localhost' ? '127.0.0.1' : rawHost;
    return {
      host,
      port: c.getPort(),
      user: c.getUsername(),
      password: c.getPassword(),
      database: c.getDatabase(),
    };
  });
};

// ---------------------------------------------------------------------------
// DNS seam helpers. The wire layer fans `pg-loadbalancetest` out to the
// addresses we return here. Combined with the user-supplied port
// (passed in `opts.port`), each address becomes one (address, port)
// candidate.
// ---------------------------------------------------------------------------

/** Install a `_dnsLookupAll` that resolves HOSTNAME to the given addresses. */
const installDnsSeam = (
  wire: WireModule,
  addresses: readonly string[],
): void => {
  wire.PgConnection._dnsLookupAll = (host) => {
    if (host !== HOSTNAME) {
      throw new Error(`unexpected dns.lookup(${host})`);
    }
    return Promise.resolve(
      addresses.map((address) => ({ address, family: 4 })),
    );
  };
};

const clearDnsSeam = (wire: WireModule): void => {
  wire.PgConnection._dnsLookupAll = null;
};

const setRng = (wire: WireModule, value: number | null): void => {
  wire.PgConnection._loadBalanceRng =
    value === null ? null : (): number => value;
};

// ---------------------------------------------------------------------------
// Suite body — each test mirrors one upstream `connect_ok` / `ok(...)`.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/004_load_balance_dns', () => {
  beforeAll(async () => {
    nodes = await bootThreeNodes();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      nodeContainers.map(async (c) => {
        try {
          await c.stop();
        } catch {
          // ignore
        }
      }),
    );
    nodeContainers = [];
    nodes = [];
  }, 60_000);

  // Upstream `connect1`: load_balance_hosts=disable on a hostname with
  // multiple DNS results — the first IP (== first A record) is tried,
  // and since it accepts the connection, the client lands on it.
  it('load_balance_hosts=disable connects to the first DNS-returned IP (upstream connect1)', async () => {
    const wire = await loadWire();
    // DNS seam returns one address (127.0.0.1) per lookup — each entry
    // in `hosts` fans to a single (host=HOSTNAME, address=127.0.0.1,
    // port) candidate. The list order in `opts.hosts` IS the iteration
    // order under `disable`, so the spec verifies the wire layer
    // connects to the FIRST.
    installDnsSeam(wire, ['127.0.0.1']);
    try {
      const conn = await wire.PgConnection.connect({
        host: HOSTNAME,
        port: nodes[0].port,
        user: nodes[0].user,
        password: nodes[0].password,
        database: nodes[0].database,
        ssl: 'disable',
        hosts: nodes.map((n) => ({ host: HOSTNAME, port: n.port })),
        loadBalanceHosts: 'disable',
      });
      try {
        // `conn.host` reports the original hostname (TLS-stable identity).
        // The actual TCP connect went to 127.0.0.1 via the address
        // override.
        expect(conn.host).toBe(HOSTNAME);
        expect(conn.port).toBe(nodes[0].port);
      } finally {
        await conn.close();
      }
    } finally {
      clearDnsSeam(wire);
    }
  });

  // Upstream `connect2`: load_balance_hosts=random spreads connections
  // across the DNS-returned IPs. Upstream uses 50 random samples and
  // asserts each node sees at least one. We replace that with a
  // deterministic-RNG check that proves the shuffle is wired up.
  //
  // Fisher-Yates with `Math.floor(rng() * (i+1))` and `rng() = 0` walks
  // i from n-1 down to 1, picking j=0 each step (swaps the current
  // element with index 0). For n=3 the trace is:
  //   start    [A, B, C]
  //   i=2, j=0 [C, B, A]   (swap 2 and 0)
  //   i=1, j=0 [B, C, A]   (swap 1 and 0)
  // Head is B → `nodes[1].port`.
  it('load_balance_hosts=random shuffles the DNS-fanned candidate set (upstream connect2)', async () => {
    const wire = await loadWire();
    installDnsSeam(wire, ['127.0.0.1']);
    setRng(wire, 0);
    try {
      const conn = await wire.PgConnection.connect({
        host: HOSTNAME,
        port: nodes[0].port,
        user: nodes[0].user,
        password: nodes[0].password,
        database: nodes[0].database,
        ssl: 'disable',
        hosts: nodes.map((n) => ({ host: HOSTNAME, port: n.port })),
        loadBalanceHosts: 'random',
      });
      try {
        expect(conn.host).toBe(HOSTNAME);
        expect(conn.port).toBe(nodes[1].port);
      } finally {
        await conn.close();
      }
    } finally {
      clearDnsSeam(wire);
      setRng(wire, null);
    }
  });

  // Upstream `connect2` distribution check (each node sees ≥1 connection
  // out of 50). We exercise the same property with a finite, deterministic
  // permutation: iterate Fisher-Yates with three distinct RNG values that
  // land on each node, asserting the wire layer actually connected to all
  // three. Captures the round-trip from shuffle → connect for every node.
  it('each of node1/node2/node3 receives at least one random-balanced connection', async () => {
    const wire = await loadWire();
    installDnsSeam(wire, ['127.0.0.1']);
    try {
      // For n=3 with `Math.floor(rng() * (i+1))` Fisher-Yates, walk i
      // from 2 down to 1. The RNG is called once per step (so two
      // calls total). We use a STATEFUL RNG returning a predetermined
      // sequence per scenario, picking sequences that put each node at
      // head:
      //
      //   nodes[0] (head=A): rng=0.999 each step.
      //     i=2: j=floor(0.999*3)=2 → swap [2,2] (no-op) → [A,B,C]
      //     i=1: j=floor(0.999*2)=1 → swap [1,1] (no-op) → [A,B,C]
      //
      //   nodes[1] (head=B): rng=0 each step.
      //     i=2: j=floor(0*3)=0 → swap [2,0] → [C,B,A]
      //     i=1: j=floor(0*2)=0 → swap [1,0] → [B,C,A]
      //
      //   nodes[2] (head=C): rng=0.0/0.999.
      //     i=2: j=floor(0.0*3)=0 → swap [2,0] → [C,B,A]
      //     i=1: j=floor(0.999*2)=1 → swap [1,1] (no-op) → [C,B,A]
      type SeqRng = { values: number[]; index: number };
      const setSeqRng = (seq: number[]): void => {
        const state: SeqRng = { values: seq, index: 0 };
        wire.PgConnection._loadBalanceRng = (): number => {
          const v = state.values[state.index] ?? 0;
          state.index += 1;
          return v;
        };
      };
      const scenarios: { name: string; seq: number[]; expectIdx: number }[] = [
        { name: 'head=nodes[0]', seq: [0.999, 0.999], expectIdx: 0 },
        { name: 'head=nodes[1]', seq: [0, 0], expectIdx: 1 },
        { name: 'head=nodes[2]', seq: [0, 0.999], expectIdx: 2 },
      ];
      const seenPorts = new Set<number>();
      for (const { name, seq, expectIdx } of scenarios) {
        setSeqRng(seq);
        const conn = await wire.PgConnection.connect({
          host: HOSTNAME,
          port: nodes[0].port,
          user: nodes[0].user,
          password: nodes[0].password,
          database: nodes[0].database,
          ssl: 'disable',
          hosts: nodes.map((n) => ({ host: HOSTNAME, port: n.port })),
          loadBalanceHosts: 'random',
        });
        try {
          expect(
            conn.port,
            `scenario ${name}: head should be nodes[${String(expectIdx)}]`,
          ).toBe(nodes[expectIdx].port);
          seenPorts.add(conn.port);
        } finally {
          await conn.close();
        }
      }
      // The three RNG sequences produced three distinct head ports —
      // the upstream `connect2` distribution property in deterministic
      // form: each node is reachable through DNS fan-out + shuffle.
      expect(seenPorts.size).toBe(3);
    } finally {
      clearDnsSeam(wire);
      setRng(wire, null);
    }
  });

  // Upstream `connect3`: load_balance_hosts=disable falls through to a
  // working node when earlier ones are down. Stop node1 and node2 first,
  // then connect with `disable` — the iteration order is preserved and
  // the connect lands on node3.
  it('load_balance_hosts=disable falls through to a working node when earlier ones are down (upstream connect3)', async () => {
    const wire = await loadWire();
    await nodeContainers[0].stop();
    await nodeContainers[1].stop();
    installDnsSeam(wire, ['127.0.0.1']);
    try {
      const conn = await wire.PgConnection.connect({
        host: HOSTNAME,
        port: nodes[2].port,
        user: nodes[2].user,
        password: nodes[2].password,
        database: nodes[2].database,
        ssl: 'disable',
        hosts: nodes.map((n) => ({ host: HOSTNAME, port: n.port })),
        loadBalanceHosts: 'disable',
      });
      try {
        expect(conn.port).toBe(nodes[2].port);
      } finally {
        await conn.close();
      }
    } finally {
      clearDnsSeam(wire);
    }
  }, 60_000);

  // Upstream `connect4`: load_balance_hosts=random also falls through.
  // Five attempts, all succeeding via node3 since node1 and node2 are
  // stopped. We assert ONE successful attempt — sufficient to prove the
  // fall-through path, and avoids needlessly stressing the timer set on
  // the unreachable IPs.
  it('load_balance_hosts=random falls through when earlier nodes are down (upstream connect4)', async () => {
    const wire = await loadWire();
    // node1 and node2 already stopped in the previous test; the
    // afterAll's `Promise.all` tolerates already-stopped containers.
    installDnsSeam(wire, ['127.0.0.1']);
    setRng(wire, 0);
    try {
      const conn = await wire.PgConnection.connect({
        host: HOSTNAME,
        port: nodes[2].port,
        user: nodes[2].user,
        password: nodes[2].password,
        database: nodes[2].database,
        ssl: 'disable',
        hosts: nodes.map((n) => ({ host: HOSTNAME, port: n.port })),
        loadBalanceHosts: 'random',
      });
      try {
        expect(conn.port).toBe(nodes[2].port);
      } finally {
        await conn.close();
      }
    } finally {
      clearDnsSeam(wire);
      setRng(wire, null);
    }
  }, 60_000);
});
