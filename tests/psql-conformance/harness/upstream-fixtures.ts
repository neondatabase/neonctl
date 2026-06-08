// Runtime fetcher for upstream PostgreSQL regression SQL + expected
// outputs. We deliberately do NOT vendor these files; the version pin
// lives in `tests/psql-conformance/POSTGRES_REF` and the fetch happens
// once at test bootstrap.
//
// No on-disk cache: every `vitest run` invocation re-fetches. The 6
// files total ~400 KB, ~1-2 s of HTTPS round-trips. Trading speed for
// the simpler invariant "the harness always exercises the exact pinned
// upstream content, no stale local copy can drift".
//
// Files fetched (paths under https://raw.githubusercontent.com/postgres/postgres/<tag>/):
//
//   src/test/regress/sql/psql.sql
//   src/test/regress/sql/psql_crosstab.sql
//   src/test/regress/sql/psql_pipeline.sql
//   src/test/regress/expected/psql.out
//   src/test/regress/expected/psql_crosstab.out
//   src/test/regress/expected/psql_pipeline.out
//
// Returns a map keyed by the SHORT NAME used by `regress.spec.ts`
// (`'psql' | 'psql_crosstab' | 'psql_pipeline'`) with both `.sql` and
// `.expected` strings. `regress.spec.ts` consumes the maps directly
// instead of reading from disk.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTGRES_REF_PATH = resolve(HERE, '..', 'POSTGRES_REF');

const RAW_BASE = 'https://raw.githubusercontent.com/postgres/postgres';

export type RegressCaseName = 'psql' | 'psql_crosstab' | 'psql_pipeline';

export type UpstreamRegressFixture = {
  readonly sql: string;
  readonly expected: string;
};

const REGRESS_CASES: readonly RegressCaseName[] = [
  'psql',
  'psql_crosstab',
  'psql_pipeline',
];

/**
 * Parse `POSTGRES_REF` for the pinned tag. Throws if missing — the
 * fetcher cannot work without a pin.
 */
const readPgTag = (): string => {
  const raw = readFileSync(POSTGRES_REF_PATH, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === 'PG_TAG') return trimmed.slice(eq + 1).trim();
  }
  throw new Error(`PG_TAG missing from ${POSTGRES_REF_PATH}`);
};

const fetchText = async (url: string): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
};

/**
 * Download SQL + expected for every regress case in parallel. Returns
 * a map keyed by short name. Throws if any fetch fails (no partial
 * success — a half-fetched fixture set would silently break tests).
 */
export const fetchRegressFixtures = async (): Promise<
  Map<RegressCaseName, UpstreamRegressFixture>
> => {
  const tag = readPgTag();
  const requests: Promise<{
    name: RegressCaseName;
    fixture: UpstreamRegressFixture;
  }>[] = REGRESS_CASES.map(async (name) => {
    const [sql, expected] = await Promise.all([
      fetchText(`${RAW_BASE}/${tag}/src/test/regress/sql/${name}.sql`),
      fetchText(`${RAW_BASE}/${tag}/src/test/regress/expected/${name}.out`),
    ]);
    return { name, fixture: { sql, expected } };
  });
  const results = await Promise.all(requests);
  const map = new Map<RegressCaseName, UpstreamRegressFixture>();
  for (const r of results) map.set(r.name, r.fixture);
  return map;
};

/**
 * Path to our OWN seed script (`test_setup_minimal.sql`). Not from
 * upstream — we maintain it. Lives under `tests/psql-conformance/seed/`.
 */
export const SEED_SCRIPT_HOST_PATH = join(
  HERE,
  '..',
  'seed',
  'test_setup_minimal.sql',
);
