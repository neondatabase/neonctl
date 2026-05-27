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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './util-log.js';

export type PgConn = {
  host: string;
  port: number;
  db: string;
  user: string;
  password: string;
};

const PG_IMAGE_DEFAULT = 'postgres:18.0';

// Path to the minimal subset of upstream src/test/regress/sql/test_setup.sql
// that we run against the booted container before any vendored regress
// script. Upstream pg_regress runs the full test_setup.sql first, which
// creates a number of tables that every per-test script (psql.sql,
// psql_pipeline.sql, etc.) assumes already exist. We only need `onek` and
// `tenk1` — see test_setup_minimal.sql for the rationale.
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
 * Boot or attach to postgres. Idempotent within a process.
 * Should be called from vitest globalSetup.
 */
export async function setupPg(): Promise<PgConn> {
  if (cached) return cached;

  const envHost = process.env.PGCONFORMANCE_PG_HOST;
  if (envHost) {
    cached = {
      host: envHost,
      port: Number(process.env.PGCONFORMANCE_PG_PORT ?? '5432'),
      db: process.env.PGCONFORMANCE_PG_DB ?? 'postgres',
      user: process.env.PGCONFORMANCE_PG_USER ?? 'postgres',
      password: process.env.PGCONFORMANCE_PG_PASSWORD ?? 'postgres',
    };
    log(
      `pg-fixture: using $PGCONFORMANCE_PG_HOST=${cached.host}:${cached.port}`,
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
    cached = {
      host: envHost,
      port: Number(process.env.PGCONFORMANCE_PG_PORT ?? '5432'),
      db: process.env.PGCONFORMANCE_PG_DB ?? 'postgres',
      user: process.env.PGCONFORMANCE_PG_USER ?? 'postgres',
      password: process.env.PGCONFORMANCE_PG_PASSWORD ?? 'postgres',
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
  type ContentToCopy = {
    content: string;
    target: string;
    mode?: number;
  };
  type ExecResult = {
    output: string;
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  type ContainerCtor = new (image: string) => {
    start(): Promise<StartedContainer>;
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
  const ctor = mod.PostgreSqlContainer as ContainerCtor | undefined;
  if (typeof ctor !== 'function') {
    throw new Error(
      'pg-fixture: @testcontainers/postgresql is installed but does not ' +
        'export PostgreSqlContainer — your version is incompatible.',
    );
  }
  const image = process.env.PGCONFORMANCE_PG_IMAGE ?? PG_IMAGE_DEFAULT;
  log(`pg-fixture: booting ${image} via @testcontainers/postgresql...`);
  const started = await new ctor(image).start();
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

  const conn: PgConn = {
    host: started.getHost(),
    port: started.getPort(),
    db: started.getDatabase(),
    user: started.getUsername(),
    password: started.getPassword(),
  };
  log(`pg-fixture: ready at ${conn.host}:${conn.port} (db=${conn.db})`);
  return conn;
}
