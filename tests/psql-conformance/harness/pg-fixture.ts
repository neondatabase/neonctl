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

import { log } from './util-log.js';

export type PgConn = {
  host: string;
  port: number;
  db: string;
  user: string;
  password: string;
};

const PG_IMAGE_DEFAULT = 'postgres:18.0';

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
