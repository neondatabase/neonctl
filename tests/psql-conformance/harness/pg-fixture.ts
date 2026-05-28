// Postgres fixture for the conformance harness.
//
// Selection logic:
//   1. If $PGCONFORMANCE_PG_HOST is set, use that. The companion vars
//      $PGCONFORMANCE_PG_PORT / _USER / _PASSWORD / _DB pin the rest.
//      This is the GHA-service path.
//   2. Otherwise, lazily import `@testcontainers/postgresql` and boot
//      a container pinned to PG_IMAGE_DIGEST from POSTGRES_REF.
//   3. If `@testcontainers/postgresql` is not installed, throw a
//      directive error: it is not (yet) a devDep of neonctl, so the
//      caller must `bun add -d @testcontainers/postgresql` first.
//
// The intended consumer is vitest `globalSetup`. The fixture exports
// `setupPg()` to call from globalSetup, and `getPgConn()` to call
// from individual test files.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './util-log.js';

export type PgConn = {
  host: string;
  port: number;
  db: string;
  user: string;
  password: string;
  /**
   * Per-run temp dir the vendored regress scripts use as
   * `abs_builddir` / `PG_ABS_BUILDDIR`. Created on the host BEFORE the
   * container starts and bind-mounted into the container at the same
   * path, so server-side reads (e.g. `COPY reload_output(line) FROM
   * :'g_out_file'`) see the same file that the client wrote with
   * `\g :'g_out_file'`.
   *
   * `null` when the fixture is hydrated from `PGCONFORMANCE_PG_HOST`
   * (the GHA-service path): there's no testcontainer to bind-mount
   * into and the caller is expected to share its own filesystem with
   * the PG server.
   */
  absBuilddir: string | null;
  /**
   * Server major version (e.g. 14, 15, 16, 17, 18). Detected once
   * during fixture boot via `SHOW server_version_num`. Consumed by
   * the regress spec to drive version-conditional normalize rules
   * (PG 14-17 emit different wording / behavior for some pipeline
   * errors vs the PG 18 vendored expected — see normalize.ts). Falls
   * back to `null` when the version probe fails so callers can still
   * decide what to do.
   */
  serverMajor: number | null;
};

const PG_IMAGE_DEFAULT = 'postgres:18.0';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_SCRIPT_HOST_PATH = join(
  HERE,
  '..',
  'vendor',
  'postgres-18.0',
  'src',
  'test',
  'regress',
  'sql',
  'test_setup_minimal.sql',
);
const SEED_SCRIPT_CONTAINER_PATH =
  '/tmp/psql-conformance/test_setup_minimal.sql';

type StoppableContainer = { stop(): Promise<unknown> };

let cached: PgConn | null = null;
let containerRef: StoppableContainer | null = null;
/**
 * The host-side abs_builddir we created in {@link bootTestcontainer}.
 * Stored separately from `cached` because we still want to clean it up
 * even if the connection was hydrated from env vars on a different
 * code path (it shouldn't happen — only the fixture owns its own dir
 * — but defending against future plumbing changes is cheap).
 */
let ownedAbsBuilddir: string | null = null;

/**
 * Boot or attach to postgres. Idempotent within a process.
 * Should be called from vitest globalSetup.
 */
export async function setupPg(): Promise<PgConn> {
  if (cached) return cached;

  const envHost = process.env.PGCONFORMANCE_PG_HOST;
  if (envHost) {
    const envMajor = process.env.PGCONFORMANCE_PG_MAJOR;
    cached = {
      host: envHost,
      port: Number(process.env.PGCONFORMANCE_PG_PORT ?? '5432'),
      db: process.env.PGCONFORMANCE_PG_DB ?? 'postgres',
      user: process.env.PGCONFORMANCE_PG_USER ?? 'postgres',
      password: process.env.PGCONFORMANCE_PG_PASSWORD ?? 'postgres',
      absBuilddir: process.env.PGCONFORMANCE_ABS_BUILDDIR ?? null,
      serverMajor: envMajor ? Number(envMajor) : null,
    };
    log(
      `pg-fixture: using $PGCONFORMANCE_PG_HOST=${cached.host}:${cached.port}` +
        (cached.serverMajor !== null ? ` (major=${cached.serverMajor})` : ''),
    );
    return cached;
  }

  cached = await bootTestcontainer();
  return cached;
}

/**
 * Synchronously read the connection info populated by setupPg().
 *
 * vitest's `globalSetup` runs in a separate process from each test worker;
 * the in-process `cached` populated there is invisible here. globalSetup
 * propagates the connection via `PGCONFORMANCE_PG_*` env vars, so when
 * `cached` is null we hydrate from those. Only throw if neither the cache
 * nor the env vars are populated.
 */
export function getPgConn(): PgConn {
  if (cached) return cached;
  const envHost = process.env.PGCONFORMANCE_PG_HOST;
  if (envHost) {
    const envMajor = process.env.PGCONFORMANCE_PG_MAJOR;
    cached = {
      host: envHost,
      port: Number(process.env.PGCONFORMANCE_PG_PORT ?? '5432'),
      db: process.env.PGCONFORMANCE_PG_DB ?? 'postgres',
      user: process.env.PGCONFORMANCE_PG_USER ?? 'postgres',
      password: process.env.PGCONFORMANCE_PG_PASSWORD ?? 'postgres',
      absBuilddir: process.env.PGCONFORMANCE_ABS_BUILDDIR ?? null,
      serverMajor: envMajor ? Number(envMajor) : null,
    };
    return cached;
  }
  throw new Error(
    'pg-fixture: getPgConn() called before setupPg() and no ' +
      'PGCONFORMANCE_PG_HOST env var is set. Make sure vitest.config.ts ' +
      'wires globalSetup to tests/psql-conformance/harness/global-setup.ts.',
  );
}

/**
 * Tear down the container, if we own one.
 * Called by vitest globalTeardown.
 */
export async function teardownPg(): Promise<void> {
  if (containerRef) {
    await containerRef.stop();
    containerRef = null;
  }
  if (ownedAbsBuilddir) {
    try {
      rmSync(ownedAbsBuilddir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    ownedAbsBuilddir = null;
  }
  cached = null;
}

async function bootTestcontainer(): Promise<PgConn> {
  let mod;
  try {
    // The import is dynamic so the rest of the harness (notably the
    // unit tests under harness/) loads even when testcontainers is
    // not installed. See README "Setup" section.
    //
    // The string is built at runtime so `tsc` does not try to resolve
    // the (optional) module's types when it is not installed.
    const moduleName = '@testcontainers/postgresql';
    mod = (await import(moduleName)) as unknown as {
      PostgreSqlContainer?: unknown;
    };
  } catch {
    throw new Error(
      [
        'pg-fixture: @testcontainers/postgresql is not installed.',
        '',
        'Install it (one-time, dev only) with:',
        '  bun add -d @testcontainers/postgresql',
        '',
        'Or run the conformance harness against an externally-managed',
        'postgres by exporting:',
        '  export PGCONFORMANCE_PG_HOST=127.0.0.1',
        '  export PGCONFORMANCE_PG_PORT=5432',
        '  export PGCONFORMANCE_PG_USER=postgres',
        '  export PGCONFORMANCE_PG_PASSWORD=postgres',
        '  export PGCONFORMANCE_PG_DB=postgres',
      ].join('\n'),
    );
  }
  // The package's surface is intentionally typed loosely here so the
  // file compiles whether or not the package is installed in
  // node_modules — see the README "Setup" section.
  type BindMount = {
    source: string;
    target: string;
    mode?: 'rw' | 'ro' | 'z' | 'Z';
  };
  type ContentToCopy = {
    content: string;
    target: string;
    mode?: number;
  };
  type Builder = {
    withBindMounts(mounts: BindMount[]): Builder;
    start(): Promise<StartedContainer>;
  };
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
    copyContentToContainer(contents: ContentToCopy[]): Promise<void>;
  };
  type ContainerCtor = new (image: string) => Builder;
  const ctor = mod.PostgreSqlContainer as ContainerCtor | undefined;
  if (typeof ctor !== 'function') {
    throw new Error(
      'pg-fixture: @testcontainers/postgresql is installed but does not ' +
        'export PostgreSqlContainer — your version is incompatible.',
    );
  }

  // Allocate the per-run abs_builddir BEFORE the container starts so we
  // can bind-mount the same path into the container. This pairs the
  // client (host) and server (container) views of the directory: when
  // the regress script does `\g :'g_out_file'` (client writes) and
  // `COPY reload_output(line) FROM :'g_out_file'` (server reads), both
  // see the same bytes.
  //
  // The mkdtemp prefix matches the historical name in normalize.ts so
  // the existing path-scrub rule continues to fire when the path leaks
  // into output (e.g. error messages). The bind-mount uses identical
  // host and container paths so :abs_builddir resolves to a real path
  // on both sides without any rewriting.
  const absBuilddir = mkdtempSync(join(tmpdir(), 'psql-conformance-regress-'));
  // mkdtemp creates 0o700; widen so the bind-mount is reachable by the
  // `postgres` user (UID 999) inside the container. The dir lives under
  // tmpdir() so the wider perms don't expose anything sensitive.
  chmodSync(absBuilddir, 0o755);
  mkdirSync(join(absBuilddir, 'results'), { recursive: true, mode: 0o777 });
  ownedAbsBuilddir = absBuilddir;

  const image = process.env.PGCONFORMANCE_PG_IMAGE ?? PG_IMAGE_DEFAULT;
  log(
    `pg-fixture: booting ${image} via @testcontainers/postgresql ` +
      `(bind-mount abs_builddir=${absBuilddir})...`,
  );
  const builder = new ctor(image).withBindMounts([
    { source: absBuilddir, target: absBuilddir, mode: 'rw' },
  ]);
  const started = await builder.start();
  containerRef = started;

  // Seed the regression-test infrastructure once the container is up.
  // The vendored psql.sql references upstream tables (`onek`, `tenk1`)
  // that upstream pg_regress creates via test_setup.sql before running
  // the per-test scripts. We don't bring in the full upstream script
  // because it depends on `regresslib` (a C library built only as part
  // of the regression suite, not shipped in `postgres:<ver>` images);
  // the minimal script trims everything except the `onek` and `tenk1`
  // table definitions, which are the only ones our vendored scripts
  // reach for.
  const seedSql = readFileSync(SEED_SCRIPT_HOST_PATH, 'utf8');
  log(`pg-fixture: seeding regression-test tables (${SEED_SCRIPT_HOST_PATH})`);
  await started.copyContentToContainer([
    {
      content: seedSql,
      target: SEED_SCRIPT_CONTAINER_PATH,
      mode: 0o644,
    },
  ]);
  const seedResult = await started.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    started.getUsername(),
    '-d',
    started.getDatabase(),
    '-f',
    SEED_SCRIPT_CONTAINER_PATH,
  ]);
  if (seedResult.exitCode !== 0) {
    throw new Error(
      `pg-fixture: seed script failed (exit ${seedResult.exitCode}):\n` +
        seedResult.output,
    );
  }

  // Probe the running server's major version so the harness can apply
  // version-conditional normalize rules without round-tripping through
  // the test code. `server_version_num` is e.g. 180000 / 170004 — the
  // major is the first 1-2 digits.
  let serverMajor: number | null = null;
  try {
    const probe = await started.exec([
      'psql',
      '-tA', // tuples only + unaligned
      '-U',
      started.getUsername(),
      '-d',
      started.getDatabase(),
      '-c',
      'SHOW server_version_num',
    ]);
    if (probe.exitCode === 0) {
      const n = Number((probe.stdout ?? '').trim());
      if (Number.isFinite(n) && n > 0) {
        // server_version_num = MMmmpp; PG 10+ uses MMMmpp where MMM is
        // the major (10, 11, ..., 18, ...). Divide by 10_000.
        serverMajor = Math.floor(n / 10_000);
      }
    }
  } catch {
    // best-effort: leave null and let callers fall back.
  }

  const conn: PgConn = {
    host: started.getHost(),
    port: started.getPort(),
    db: started.getDatabase(),
    user: started.getUsername(),
    password: started.getPassword(),
    absBuilddir,
    serverMajor,
  };
  log(
    `pg-fixture: ready at ${conn.host}:${conn.port} (db=${conn.db}, ` +
      `abs_builddir=${absBuilddir}, server_major=${serverMajor ?? 'unknown'})`,
  );
  return conn;
}
