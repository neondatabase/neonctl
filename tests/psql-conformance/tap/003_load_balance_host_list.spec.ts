// Port of upstream PostgreSQL's
// `src/interfaces/libpq/t/003_load_balance_host_list.pl`.
//
// Upstream reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/interfaces/libpq/t/003_load_balance_host_list.pl
//
// SCOPE — what is ported, what is skipped, and why
// ---------------------------------------------------------------------------
// Upstream's perl test exercises the libpq multi-host iteration logic
// across four scenarios:
//
//   1. `load_balance_hosts=doesnotexist` is rejected with the message
//      "invalid load_balance_hosts value: ...". (Negative case.)
//   2. `load_balance_hosts=disable` connects to the FIRST host in the
//      list.
//   3. `load_balance_hosts=random` distributes across N hosts. Upstream
//      runs 50 random samples and trusts the (2/3)^50 statistical
//      argument that all three nodes will be hit; we instead inject a
//      deterministic RNG via the wire layer's `_loadBalanceRng` seam
//      (mirrors the unit test at
//      `src/psql/wire/connection.test.ts::'load_balance_hosts=random
//      shuffles the candidate list (deterministic RNG)'`).
//   4. `target_session_attrs=read-write` skips a "standby" host and
//      lands on the writable one even when the standby is listed
//      first. (Upstream uses physical replication; we install a SQL
//      shadow of `pg_is_in_recovery()` that returns `true` for the
//      test user — semantically equivalent to a standby from the
//      multi-host iterator's point of view, since the iterator's
//      sole signal is `SELECT pg_is_in_recovery()`. Physical
//      replication would be heavy and is unnecessary to validate the
//      iterator's branch logic.)
//
// What we PORT (subtests in this spec):
//
//   * "load_balance_hosts=doesnotexist is rejected" — driven through
//     the launcher (dist/psql/cli) so we observe the full URI-parse
//     pathway, matching upstream's libpq surface.
//   * "load_balance_hosts=disable connects to the first node" — drives
//     `PgConnection.connect` directly (the wire layer is the
//     iterator).
//   * "load_balance_hosts=random shuffles the list (deterministic
//     RNG)" — replaces upstream's 50-sample statistical assertion
//     with a deterministic RNG that reverses the list.
//   * "target_session_attrs=read-write skips a read-only host" — the
//     read-only host is the cheat-standby (pg_is_in_recovery() = true)
//     described above.
//
// What we SKIP / DEFER (with reasons):
//
//   * Upstream's second `load_balance_hosts=disable` case after
//     stopping node1 + node2 (asserts the iterator falls through to
//     node3): the wire-layer unit test `connection.test.ts::'falls
//     through to the second host when the first refuses the
//     connection'` already covers this branch exhaustively with fake
//     servers. Repeating it here would add ~10s of container start /
//     stop choreography (or rely on stopping containers mid-run) for
//     no new coverage of the iterator's logic. Skipped at integration
//     level.
//   * Upstream's `load_balance_hosts=random` x5 follow-up with two
//     nodes down: same reason — the falls-through-on-refuse case is
//     covered by the wire unit test, and random ordering is covered
//     by this spec's deterministic-RNG subtest.
//
// IMPORTANT: This spec boots its OWN three postgres containers (one
// per "node" in the host list), NOT the shared plaintext fixture from
// `pg-fixture.ts`. The shared fixture is not consumed here — but the
// vitest `globalSetup` still boots it because we don't set
// `PSQL_CONFORMANCE_SKIP_PG=1`. That's fine: it costs one extra
// container boot for the whole `vitest run` invocation, which the
// rest of the matrix needs anyway.
//
// Like the sibling TAP specs, the body imports from the built
// `dist/psql/wire/connection.js` (rather than from `src/`), so the
// test surface mirrors what `bin/cli.js` would do at runtime.
// `bun run build` is required before this spec can run.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeLauncher, runChild } from './_helpers.js';

// ---------------------------------------------------------------------------
// Resolve the dist-side wire module that we exercise. Loaded lazily inside
// the suite body so the file still loads cleanly when `dist/` is absent
// (in which case `SHOULD_RUN` is false and the body is skipped).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DIST_WIRE = join(REPO_ROOT, 'dist', 'psql', 'wire', 'connection.js');
const DIST_PSQL = join(REPO_ROOT, 'dist', 'psql', 'index.js');

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const DIST_EXISTS = existsSync(DIST_WIRE) && existsSync(DIST_PSQL);
const SHOULD_RUN = RUN_INTEGRATION && DIST_EXISTS;

/**
 * Minimal subset of the wire-layer surface that this spec exercises.
 * Sourced from `dist/psql/wire/connection.js` via dynamic import. The
 * structural type lets vitest type-check the spec without pulling the
 * full src/ tree under the conformance tsconfig's rootDir.
 */
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
  targetSessionAttrs?:
    | 'any'
    | 'read-write'
    | 'read-only'
    | 'primary'
    | 'standby'
    | 'prefer-standby';
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
  // file:// URL keeps the dynamic import platform-portable.
  const url = pathToFileURL(DIST_WIRE).href;
  wireMod = (await import(url)) as WireModule;
  return wireMod;
};

// ---------------------------------------------------------------------------
// Gating: surface why we're skipped when we are. The visible "(gate)"
// describe is always emitted so the report tells the reader what's
// missing without having to grok the spec's source.
// ---------------------------------------------------------------------------

describe('tap/003_load_balance_host_list (gate)', () => {
  if (!RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1 (set env to run)', () => {
      /* unreachable */
    });
  } else if (!DIST_EXISTS) {
    it.skip('skipped: dist/psql/{wire/connection,index}.js missing — run `bun run build` first', () => {
      /* unreachable */
    });
  } else {
    // All gates green: emit a placeholder `it` so vitest doesn't error
    // out with "No test found in suite" when the body's `describe.skipIf`
    // is reached and the matrix tests fire below.
    it('gates open: RUN_INTEGRATION=1, dist present', () => {
      expect(true).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Container types (loosely typed so the file compiles whether or not
// @testcontainers/postgresql is installed — mirrors pg-fixture.ts).
// ---------------------------------------------------------------------------

type ExecResult = {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};
type StartedContainer = {
  stop(): Promise<void>;
  getHost(): string;
  getPort(): number;
  getDatabase(): string;
  getUsername(): string;
  getPassword(): string;
  exec(
    command: string | string[],
    opts?: { workingDir?: string; user?: string },
  ): Promise<ExecResult>;
};
type Builder = {
  start(): Promise<StartedContainer>;
};
type ContainerCtor = new (image: string) => Builder;

const PG_IMAGE_DEFAULT = 'postgres:18.0';

let nodeContainers: StartedContainer[] = [];

type NodeInfo = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

let nodes: NodeInfo[] = [];

/**
 * Boot three independent postgres containers. Each gets a unique
 * testcontainers-allocated TCP port; the host is `127.0.0.1` (we
 * normalise from `getHost()` which already returns localhost on the
 * macOS / Linux dev paths).
 */
const bootThreeNodes = async (): Promise<NodeInfo[]> => {
  const moduleName = '@testcontainers/postgresql';
  let mod: { PostgreSqlContainer?: unknown };
  try {
    mod = (await import(moduleName)) as { PostgreSqlContainer?: unknown };
  } catch {
    throw new Error(
      '003_load_balance_host_list: @testcontainers/postgresql is not ' +
        'installed. Run `bun add -d @testcontainers/postgresql`.',
    );
  }
  const ctor = mod.PostgreSqlContainer as ContainerCtor | undefined;
  if (typeof ctor !== 'function') {
    throw new Error(
      '003_load_balance_host_list: @testcontainers/postgresql does not ' +
        'export PostgreSqlContainer — your version is incompatible.',
    );
  }
  const image = process.env.PGCONFORMANCE_PG_IMAGE ?? PG_IMAGE_DEFAULT;

  // Boot the three containers in parallel so the spec's beforeAll
  // doesn't pay 3 x ~5s sequentially.
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
    // testcontainers' `getHost()` returns `localhost` on local docker.
    // We normalise to `127.0.0.1` so the wire's DNS fan-out (only fires
    // for `load_balance_hosts=random`, but worth being explicit) doesn't
    // expand `localhost` to both `::1` and `127.0.0.1` and change the
    // deterministic-shuffle test's first-pick port. Docker port mapping
    // is on `127.0.0.1` only; `::1` would refuse the connection.
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

/**
 * On the third container, replace `pg_is_in_recovery()` with a shadow
 * function in the `public` schema that returns true, then push `public`
 * ahead of `pg_catalog` in the user's `search_path`. After this, the
 * wire layer's `target_session_attrs` probe (`SELECT
 * pg_is_in_recovery()`) sees `true` and treats the node as a standby —
 * the same effect as upstream's physical-replication setup, but
 * achieved in <100 ms without a replication slot.
 *
 * Performed via `psql` inside the container as the superuser so we
 * don't have to worry about GRANTs.
 *
 * The setup runs three statements:
 *   1. `CREATE OR REPLACE FUNCTION public.pg_is_in_recovery()` — the
 *      shadow that returns true.
 *   2. `ALTER USER <u> SET search_path = 'public, pg_catalog'` —
 *      ensures the shadow wins resolution on future logins.
 *   3. `ALTER DATABASE <d> SET search_path = 'public, pg_catalog'` —
 *      belt-and-braces for the case where the wire layer might
 *      explicitly set its own search_path on login (it doesn't today,
 *      but DB-level defaults also apply, and combining the two makes
 *      the shadow uniformly visible regardless of who the wire layer
 *      ends up logged in as).
 *
 * A final verification step opens a fresh session via the same psql
 * we used to seed the function, and asserts `pg_is_in_recovery() ::
 * text = 't'`. If the shadow isn't being resolved we want to fail
 * loudly in `beforeAll` rather than silently on the assertion in the
 * target_session_attrs subtest.
 */
const installStandbyShadow = async (
  container: StartedContainer,
  user: string,
  db: string,
): Promise<void> => {
  const shadowSql = [
    // 1) Shadow function in `public`. Wrapped in IMMUTABLE / LANGUAGE
    //    sql so the planner caches the result.
    `CREATE OR REPLACE FUNCTION public.pg_is_in_recovery()`,
    `  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;`,
    // 2) Put `public` before `pg_catalog` in the user's permanent
    //    search_path so the shadow wins name resolution.
    //
    //    NOTE on syntax: `SET search_path TO public, pg_catalog`
    //    (identifier list) — NOT `SET search_path = 'public,
    //    pg_catalog'` (single quoted string). The quoted form stores
    //    the entire literal as one search_path entry, which doesn't
    //    match any real schema and silently falls back to pg_catalog
    //    only. The `TO id, id, ...` form is what GUC parsing expects
    //    for list-typed GUCs. (Verified by `SHOW search_path` after
    //    both forms.)
    `ALTER USER ${user} SET search_path TO public, pg_catalog;`,
    // 3) Same at the database level so we win regardless of login
    //    path. (User-level + DB-level are merged at session start;
    //    user-level wins when both set, but having DB-level too means
    //    a stray ALTER ROLE RESET won't quietly turn the shadow off.)
    `ALTER DATABASE ${db} SET search_path TO public, pg_catalog;`,
  ].join('\n');

  const r = await container.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    user,
    '-d',
    db,
    '-c',
    shadowSql,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(
      `installStandbyShadow failed (exit ${String(r.exitCode)}):\n${r.output}`,
    );
  }

  // Verify the shadow is observable from a fresh session. -At gives us
  // tuples-only unaligned output so the single bool comes back as 't'.
  const verify = await container.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    user,
    '-d',
    db,
    '-tA',
    '-c',
    'SELECT pg_is_in_recovery()::text',
  ]);
  if (verify.exitCode !== 0) {
    throw new Error(
      `installStandbyShadow verify failed (exit ${String(verify.exitCode)}):\n` +
        verify.output,
    );
  }
  const got = (verify.stdout ?? '').trim();
  if (got !== 't' && got !== 'true') {
    throw new Error(
      `installStandbyShadow: pg_is_in_recovery() should return true after ` +
        `shadow install; got "${got}". output=${verify.output}`,
    );
  }
};

// ---------------------------------------------------------------------------
// Suite body
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/003_load_balance_host_list', () => {
  beforeAll(async () => {
    nodes = await bootThreeNodes();
    // Convert the third node into a "standby" (pg_is_in_recovery()
    // returns true). The first two stay as primaries.
    await installStandbyShadow(
      nodeContainers[2],
      nodes[2].user,
      nodes[2].database,
    );
  }, 180_000);

  afterAll(async () => {
    // Stop in parallel — container.stop() is async-friendly.
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

  // -------------------------------------------------------------------------
  // 1. Negative: load_balance_hosts=doesnotexist is rejected at URI parse.
  // -------------------------------------------------------------------------

  it.skipIf(process.platform === 'win32')(
    'load_balance_hosts=doesnotexist is rejected with a clear diagnostic',
    async () => {
      // We can use any host:port — the URI parse fails before any
      // socket is opened. Use node1 just to keep the URI realistic.
      const n = nodes[0];
      const uri =
        `postgresql://${encodeURIComponent(n.user)}:${encodeURIComponent(n.password)}` +
        `@${n.host}:${String(n.port)}/${encodeURIComponent(n.database)}` +
        `?sslmode=disable&load_balance_hosts=doesnotexist`;
      const launcher = makeLauncher('lb-negative').launcher;
      const r = await runChild({
        launcher,
        argv: [uri, '-c', 'SELECT 1'],
        timeoutMs: 30_000,
      });
      // Upstream asserts both "connect_fails" (non-zero exit) and the
      // stderr regex. Our wording differs slightly — we emit `invalid
      // value for "load_balance_hosts"` while libpq says `invalid
      // load_balance_hosts value`. We assert on the semantic content
      // (the keyword + the rejected value) so the test is robust to
      // either upstream's wording or ours.
      expect(r.exitCode, `expected non-zero exit; stderr=${r.stderr}`).not.toBe(
        0,
      );
      expect(r.stderr).toMatch(/load_balance_hosts/);
      expect(r.stderr).toMatch(/doesnotexist/);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // 2. load_balance_hosts=disable connects to the first host.
  // -------------------------------------------------------------------------

  it('load_balance_hosts=disable lands on the first host in the list', async () => {
    const { PgConnection } = await loadWire();
    const n1 = nodes[0];
    const conn = await PgConnection.connect({
      // The single-host scalars are a fallback; with `hosts` populated
      // the iterator uses the list verbatim.
      host: n1.host,
      port: n1.port,
      user: n1.user,
      password: n1.password,
      database: n1.database,
      ssl: 'disable',
      hosts: nodes.map((n) => ({ host: n.host, port: n.port })),
      loadBalanceHosts: 'disable',
    });
    try {
      expect(conn.port).toBe(n1.port);
      expect(conn.host).toBe(n1.host);
    } finally {
      await conn.close();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // 3. load_balance_hosts=random shuffles deterministically.
  //
  // Fisher-Yates with rng()=0 always picks j=0 for every step. For
  // n=3 the trace is:
  //   start: [n1, n2, n3]
  //   i=2 (j=0): swap arr[2], arr[0] -> [n3, n2, n1]
  //   i=1 (j=0): swap arr[1], arr[0] -> [n2, n3, n1]
  // First attempted host is nodes[1] (n2). The second/third positions
  // are irrelevant for this assertion — we just need ANY observable
  // reorder relative to the input list, and matching the first slot
  // gives us a deterministic ground truth.
  //
  // Why deterministic instead of upstream's 50-sample statistical
  // argument: in CI, a sampled distribution test can flake under
  // adversarial scheduling. The wire layer's RNG seam exists
  // specifically to make this branch testable without statistics, and
  // the matching unit test in `connection.test.ts` documents the
  // exact mechanism. Here we just verify end-to-end that the
  // shuffled order actually reaches three real servers.
  // -------------------------------------------------------------------------

  it('load_balance_hosts=random reorders the list (deterministic RNG)', async () => {
    const { PgConnection } = await loadWire();
    PgConnection._loadBalanceRng = (): number => 0;
    try {
      const conn = await PgConnection.connect({
        host: nodes[0].host,
        port: nodes[0].port,
        user: nodes[0].user,
        password: nodes[0].password,
        database: nodes[0].database,
        ssl: 'disable',
        hosts: nodes.map((n) => ({ host: n.host, port: n.port })),
        loadBalanceHosts: 'random',
      });
      try {
        // With rng() = 0, Fisher-Yates produces [n2, n3, n1]. First
        // attempted host is n2 (= nodes[1]), and since it accepts the
        // connection (no target_session_attrs), we land on it.
        expect(conn.port).toBe(nodes[1].port);
        // Sanity: NOT the head of the original list — if we'd landed
        // on nodes[0] the shuffle didn't run.
        expect(conn.port).not.toBe(nodes[0].port);
      } finally {
        await conn.close();
      }
    } finally {
      PgConnection._loadBalanceRng = null;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // 4. target_session_attrs=read-write skips the standby (cheat).
  //
  // Put the standby FIRST in the host list. With
  // target_session_attrs=read-write, the iterator probes
  // `pg_is_in_recovery()` on the first hit, sees `true` (our shadow
  // function), tears the connection down, and tries the next. We
  // expect to land on the first PRIMARY (i.e. nodes[0] in the
  // original list, which is the SECOND entry after we prepend the
  // standby).
  // -------------------------------------------------------------------------

  it('target_session_attrs=read-write skips a read-only host listed first', async () => {
    const { PgConnection } = await loadWire();
    const standby = nodes[2];
    const primaryA = nodes[0];
    const primaryB = nodes[1];
    // Hosts list ORDER matters for this assertion: standby first, then
    // the two primaries.
    const conn = await PgConnection.connect({
      host: standby.host,
      port: standby.port,
      user: standby.user,
      password: standby.password,
      database: standby.database,
      ssl: 'disable',
      hosts: [
        { host: standby.host, port: standby.port },
        { host: primaryA.host, port: primaryA.port },
        { host: primaryB.host, port: primaryB.port },
      ],
      targetSessionAttrs: 'read-write',
    });
    try {
      // We must NOT have landed on the standby.
      expect(conn.port).not.toBe(standby.port);
      // We should have landed on the first primary in the list
      // (primaryA == nodes[0]).
      expect(conn.port).toBe(primaryA.port);
    } finally {
      await conn.close();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // SKIPPED SUBTESTS — explicit `it.skip` so the report inventories them.
  // -------------------------------------------------------------------------

  describe('SKIPPED: load_balance_hosts=disable fall-through (covered by unit tests)', () => {
    it.skip('stops node1 + node2, expects connection to node3', () => {
      /* covered by `src/psql/wire/connection.test.ts::'falls through
       * to the second host when the first refuses the connection'` */
    });
  });

  describe('SKIPPED: load_balance_hosts=random fall-through (covered by unit tests)', () => {
    it.skip('5x connect with two nodes down, expects only node3 to be hit', () => {
      /* covered by the wire-level fall-through unit test plus this
       * spec's deterministic-RNG subtest */
    });
  });
});
