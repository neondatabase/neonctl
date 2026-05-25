# psql conformance harness (WP-T)

This directory contains the test infrastructure for the TypeScript
reimplementation of PostgreSQL's `psql` that lives in `src/psql/`.

The harness validates **a `psql` binary** — by default the system
`psql`, eventually the TS implementation — against the vendored
upstream PostgreSQL 17.4 regression scripts. It is designed so that
**Day 1 is the system psql passing every test**, before any TS psql
code exists. That is how we know the harness itself is faithful.

## Layout

```
tests/psql-conformance/
  POSTGRES_REF             # pinned PG version + commit sha + image digest
  KNOWN_FAILURES.yml       # the conformance ledger (4-quadrant gate)
  vitest.config.ts         # separate vitest config (longer timeouts, custom reporter)
  tsconfig.json            # extends ../../tsconfig.json to include this tree
  harness/
    pg-fixture.ts          # boots postgres (testcontainers OR GHA service)
    global-setup.ts        # vitest globalSetup wiring pg-fixture
    normalize.ts           # pg_regress-style output normalization
    expect-matches.ts      # KNOWN_FAILURES-aware assertion
    reporter.ts            # vitest reporter that prints coverage headline
    util-log.ts            # stderr logger (no-console eslint rule)
    *.test.ts              # unit tests for the harness itself
  regress.spec.ts          # drives psql.sql, psql_crosstab.sql, psql_pipeline.sql
  scripts/refresh-vendored.ts  # re-pull upstream regression files at a tag
  vendor/postgres-17.4/    # vendored upstream files (see VENDORED_FROM)
```

## Setup (one-time)

The harness has no devDependencies of its own yet — both new packages
need to be added by the maintainer before `regress.spec.ts` can boot
postgres. They are intentionally _not_ in `package.json` until WP-T
lands its first end-to-end green run, so the rest of the repo's CI
keeps working unchanged.

```sh
# 1. Install testcontainers (Docker required at runtime)
bun add -d @testcontainers/postgresql

# 2. (later, once WP-24 needs a PTY) Install node-pty
bun add -d node-pty
```

Alternative: run the harness against an externally-managed postgres
(e.g. a GHA `services.postgres` container) by exporting:

```sh
export PGCONFORMANCE_PG_HOST=127.0.0.1
export PGCONFORMANCE_PG_PORT=5432
export PGCONFORMANCE_PG_USER=postgres
export PGCONFORMANCE_PG_PASSWORD=postgres
export PGCONFORMANCE_PG_DB=postgres
```

When these are set, `pg-fixture.ts` skips the testcontainers branch
entirely, so Docker is not required.

## Running

```sh
# Just the harness unit tests (no Docker, no postgres needed).
# Day-1 sanity: confirms normalize.ts and expect-matches.ts work.
npx vitest run \
  --config tests/psql-conformance/vitest.config.ts \
  tests/psql-conformance/harness/normalize.test.ts \
  tests/psql-conformance/harness/expect-matches.test.ts

# The full conformance run against the system psql.
# Requires Docker (or PGCONFORMANCE_PG_HOST set) AND
# `@testcontainers/postgresql` installed.
PSQL_BINARY="$(which psql)" \
  npx vitest run --config tests/psql-conformance/vitest.config.ts

# Once the TS implementation is buildable, point PSQL_BINARY at it:
PSQL_BINARY="./dist/bin/ts-psql" \
  npx vitest run --config tests/psql-conformance/vitest.config.ts
```

A `test:conformance` npm script is intentionally **not** added to
`package.json` in this PR — that is a follow-up once the dev-dep is
in place. Recommended addition:

```json
"test:conformance": "vitest run --config tests/psql-conformance/vitest.config.ts"
```

## Environment variables

| Var                         | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `PSQL_BINARY`               | path/name of the psql to test (default `psql`)     |
| `PGCONFORMANCE_PG_HOST`     | use an externally-managed postgres (GHA service)   |
| `PGCONFORMANCE_PG_PORT`     | port for the external server (default 5432)        |
| `PGCONFORMANCE_PG_USER`     | user for the external server (default postgres)    |
| `PGCONFORMANCE_PG_PASSWORD` | password for the external server                   |
| `PGCONFORMANCE_PG_DB`       | database (default postgres)                        |
| `PGCONFORMANCE_PG_IMAGE`    | override testcontainers image                      |
| `PSQL_CONFORMANCE_SKIP_PG`  | set to `1` to skip postgres boot (unit tests only) |

## Bootstrap sequence

The plan deliberately staggers introducing the TS implementation
behind the harness. Recommended order for the maintainer:

1. **System psql baseline**

   - Install testcontainers: `bun add -d @testcontainers/postgresql`
   - `PSQL_BINARY="$(which psql)" npx vitest run --config tests/psql-conformance/vitest.config.ts`
   - Expectation: all three regress tests green. If any of them is
     red, the harness has a bug — fix `normalize.ts` (most common
     culprit) until they go green. `KNOWN_FAILURES.yml` MUST stay
     empty in this state.

2. **Open WP-T's PR** — add the `test:conformance` script, the
   devDeps, and the GHA job (separate PR per the WP scope) so green
   stays green across CI.

3. **Switch to TS psql.** Once any TS psql code lands (even a stub
   that exits 1), run the suite with `PSQL_BINARY=./dist/bin/ts-psql`.
   It will fail on everything; record each failure in
   `KNOWN_FAILURES.yml` until the suite is back to green.

4. **WP-by-WP burn-down.** Each TS WP that ships removes its entries
   from `KNOWN_FAILURES.yml`. The 4-quadrant truth table in
   `expect-matches.ts` enforces this mechanically — a passing test
   that still has a KNOWN_FAILURES entry is a hard failure with a
   message telling the engineer which entry to remove.

## Vendored files

`vendor/postgres-17.4/` is a verbatim copy of upstream PostgreSQL
test scripts. See `VENDORED_FROM` for the exact tag, commit sha, and
license attribution.

`psql_pipeline.sql` is vendored from `REL_18_0` because it was added
to upstream after `REL_17_4`. The script still exercises features
available in the pinned `postgres:17.4` server. Failures specific to
that mismatch are expected to be enumerated in `KNOWN_FAILURES.yml`
when the maintainer runs step 1.

`030_pager.pl` is listed in the WP-T plan but **does not exist** in
upstream and so is not vendored. The plan should be updated, or a
custom pager harness should be authored, in a follow-up.

### Refreshing

When bumping the pinned PostgreSQL version:

```sh
# Update POSTGRES_REF (PG_VERSION, PG_TAG, PG_IMAGE_DIGEST) by hand,
# OR override on the command line:
bun tests/psql-conformance/scripts/refresh-vendored.ts REL_17_5
```

The script re-resolves commit shas via the GitHub API (set
`$GITHUB_TOKEN` to avoid rate limits), redownloads each vendored
file, and rewrites `POSTGRES_REF` and `VENDORED_FROM`.

## CI integration (not in this PR)

A future PR will add a `conformance` job to
`.github/workflows/pr.yml` along the lines of:

```yaml
conformance:
  runs-on: ubuntu-24.04
  services:
    postgres:
      image: postgres:17.4
      env:
        POSTGRES_PASSWORD: postgres
      ports: ['5432:5432']
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v1
    - run: bun install
    - run: |
        export PGCONFORMANCE_PG_HOST=127.0.0.1
        export PGCONFORMANCE_PG_PASSWORD=postgres
        PSQL_BINARY=$(which psql) \
          npx vitest run --config tests/psql-conformance/vitest.config.ts
```

Until then, conformance is a local-dev workflow.
