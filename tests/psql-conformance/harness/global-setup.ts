// vitest globalSetup module. Boots a postgres fixture once per
// `vitest run` invocation and tears it down on exit. The connection
// info is propagated to per-worker test code via environment
// variables, so each worker can rehydrate without a second container.

import { setupPg, teardownPg } from './pg-fixture.js';

export default async function setup(): Promise<() => Promise<void>> {
  // Skip if no test actually consumes pg — `vitest run harness/*.test.ts`
  // for example. The env flag is set by regress.spec.ts.
  if (process.env.PSQL_CONFORMANCE_SKIP_PG === '1') {
    return async () => {
      /* nothing to tear down */
    };
  }
  const conn = await setupPg();
  // Surface to worker processes via env. pg-fixture.ts reads these
  // from worker context to rehydrate without re-booting.
  process.env.PGCONFORMANCE_PG_HOST = conn.host;
  process.env.PGCONFORMANCE_PG_PORT = String(conn.port);
  process.env.PGCONFORMANCE_PG_DB = conn.db;
  process.env.PGCONFORMANCE_PG_USER = conn.user;
  process.env.PGCONFORMANCE_PG_PASSWORD = conn.password;
  return async () => {
    await teardownPg();
  };
}
