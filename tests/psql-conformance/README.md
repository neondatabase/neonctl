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
PSQL_BINARY="$(which psql)" bun run test:conformance

# Once the TS implementation is built, point PSQL_BINARY at dist/cli.js:
bun run build
PSQL_BINARY="$(pwd)/dist/cli.js" bun run test:conformance
```

The `test:conformance` npm script wraps the vitest invocation:

```json
"test:conformance": "vitest run --config tests/psql-conformance/vitest.config.ts"
```

## Re-seeding the KNOWN_FAILURES ledger

After a major TS-psql behaviour change, the ledger may diverge from
what the suite actually exercises. Run:

```sh
bun run test:conformance:seed
```

This boots postgres, builds the TS psql, runs the conformance suite,
and rewrites `KNOWN_FAILURES.yml` with one `full-file` entry per
failing regression test. The previous ledger is copied to
`KNOWN_FAILURES.yml.bak` so a maintainer can diff or roll back.

Each seeded entry has a placeholder `reason: "TS-impl gap — TODO
triage"` and `ticket: ''`. Triage by hand:

1. Inspect the failure (the seed run leaves the full JSON report under
   `$TMPDIR/psql-conformance-seed-*/report.json` — see the script's
   stderr output for the path).
2. Replace `reason` with a one-liner referencing the WP that owns the
   gap.
3. Drop in a ticket id if one exists.
4. Commit the ledger.

Useful flags:

| Flag            | Effect                                                  |
| --------------- | ------------------------------------------------------- |
| `--skip-build`  | Assume `dist/cli.js` is already current (no rebuild).   |
| `--reuse-build` | Skip the rebuild iff `dist/cli.js` already exists.      |

The script honours the same `PGCONFORMANCE_PG_*` env vars as the
runtime harness, so a maintainer can point it at a managed postgres
instead of relying on Docker.

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

## CI integration

The conformance suite runs on every PR that touches the TS psql or the
harness — see `.github/workflows/psql-conformance.yml`. The workflow:

* triggers on PRs that change `src/psql/**`, `src/utils/psql.ts`,
  `src/commands/{branches,connection_string,projects}.ts`, or
  `tests/psql-conformance/**` (plus pushes to `main` / `feat/ts-psql`);
* boots a `postgres:18.0` GHA service container and exposes it via
  `PGCONFORMANCE_PG_HOST=127.0.0.1` / `PGCONFORMANCE_PG_PORT=5432`;
* runs `bun run build` then `bun run test:conformance` with
  `PSQL_BINARY` pointed at `dist/cli.js`;
* uploads the captured `psql-conformance.log` as a workflow artifact
  for triage.

### Non-blocking phase

The conformance step is **non-blocking** (`continue-on-error: true`)
during the bootstrap phase, so an unexpected failure surfaces as a
warning on the PR check list but does **not** gate merge. The flag
lives on the `Run conformance suite` step itself; the rest of the job
(build, install, artifact upload) still fails fast.

Flip to blocking when **all** of the following hold:

1. `KNOWN_FAILURES.yml` reflects the real coverage gap — no stale
   entries (the harness will already complain about those, but the
   maintainer has eyeballed the ledger).
2. The conformance reporter's `coverage` headline is **>= 95%**.
3. A maintainer has re-seeded the ledger via
   `bun run test:conformance:seed` after the last major TS-psql change.
4. `main` has stayed green on conformance for at least one week.

When that bar is met:

* drop `continue-on-error: true` from the `Run conformance suite` step
  in `psql-conformance.yml`;
* (optionally) add the `psql-conformance` job to the required-checks
  set in the repo's branch protection rules.
