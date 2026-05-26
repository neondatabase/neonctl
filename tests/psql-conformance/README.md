# psql conformance harness (WP-T)

This directory contains the test infrastructure for the TypeScript
reimplementation of PostgreSQL's `psql` that lives in `src/psql/`.

The harness validates **a `psql` binary** — by default the system
`psql`, eventually the TS implementation — against the vendored
upstream PostgreSQL 17.4 regression scripts. It is designed so that
**Day 1 is the system psql passing every test**, before any TS psql
code exists. That is how we know the harness itself is faithful.

Subtests that don't yet pass against the embedded TS psql are marked
inline with `it.todo("<name> — <reason>")` (engine gap) or
`it.skip("<name> — <reason>")` (out of scope). There is **one**
mechanism for deferred work — no separate ledger file.

## Layout

```
tests/psql-conformance/
  POSTGRES_REF             # pinned PG version + commit sha + image digest
  vitest.config.ts         # separate vitest config (longer timeouts, custom reporter)
  tsconfig.json            # extends ../../tsconfig.json to include this tree
  harness/
    pg-fixture.ts          # boots postgres (testcontainers OR GHA service)
    global-setup.ts        # vitest globalSetup wiring pg-fixture
    normalize.ts           # pg_regress-style output normalization
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
# Day-1 sanity: confirms normalize.ts works.
npx vitest run \
  --config tests/psql-conformance/vitest.config.ts \
  tests/psql-conformance/harness/normalize.test.ts

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

## Marking deferred work

When a subtest doesn't pass against the embedded TS psql, mark it
inline rather than tracking it in a separate ledger file:

- `it.todo("<name> — <reason>")` for an engine gap with a concrete
  future fix (e.g. "scanner does not flush on backslash mid-buffer").
- `it.skip("<name> — <reason>")` for upstream tests that are
  intentionally out of scope (e.g. `IPC::Run` semantics we cannot
  reproduce in Vitest).

Vitest reports todo and skip counts separately from pass/fail. Once
the underlying gap is closed, replace `it.todo(name)` with a real
`it(name, async () => { ... })` body that asserts the expected
behaviour.

## Running the matrix locally

The CI workflow runs the harness against PG 14/15/16/17/18 (Neon's full
support range) in parallel matrix slots. To mirror that locally:

```sh
bun run test:conformance:matrix
```

This script:

- Builds `dist/` (unless `--skip-build`).
- For each PG major: boots a dedicated `@testcontainers/postgresql`
  container at the appropriate image tag, runs the conformance suite,
  captures the JSON report, and tears the container down.
- Persists per-version reports under `tmp/psql-conformance/pg-<n>.json`
  for triage.
- Prints a summary table with total / passed / failed / status per
  version. Exits non-zero if any version had failures.

Useful flags:

| Flag                | Effect                                                  |
| ------------------- | ------------------------------------------------------- |
| `--pg 17` (repeats) | Limit the matrix to specific majors. Default: all five. |
| `--skip-build`      | Reuse the existing `dist/cli.js` instead of rebuilding. |

Each slot is independent — one version failing doesn't abort the rest,
and Docker memory usage stays bounded because containers are torn down
between slots rather than running in parallel.

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
     culprit) until they go green.

2. **Open WP-T's PR** — add the `test:conformance` script, the
   devDeps, and the GHA job (separate PR per the WP scope) so green
   stays green across CI.

3. **Switch to TS psql.** Once any TS psql code lands (even a stub
   that exits 1), run the suite with `PSQL_BINARY=./dist/bin/ts-psql`.
   It will fail on everything; mark each unsupported subtest with
   `it.todo("<name> — <reason>")` until the suite is back to green.

4. **WP-by-WP burn-down.** Each TS WP that ships replaces its
   `it.todo(...)` placeholders with real `it(...)` bodies that assert
   the expected behaviour.

## Vendored files

`vendor/postgres-17.4/` is a verbatim copy of upstream PostgreSQL
test scripts. See `VENDORED_FROM` for the exact tag, commit sha, and
license attribution.

`psql_pipeline.sql` is vendored from `REL_18_0` because it was added
to upstream after `REL_17_4`. The script still exercises features
available in the pinned `postgres:17.4` server. Failures specific to
that mismatch should be marked with `it.todo("reason")` /
`it.skip("reason")` on the relevant subtests.

`030_pager.pl` is listed in the WP-T plan but **does not exist** in
upstream and so is not vendored. A custom port lives at
`tap/030_pager.spec.ts` — see "Custom pager spec" below.

`001_basic.pl` IS vendored under
`vendor/postgres-18.0/src/bin/psql/t/`; the Vitest port lives at
`tap/001_basic.spec.ts`. See "TAP-port specs" below for how the spec
is gated and how deferred subtests are marked.

### TAP-port specs

The `tap/` directory holds direct ports of upstream PostgreSQL TAP
tests (perl) to Vitest. Each spec gates its body on
`RUN_INTEGRATION=1` and the presence of `dist/psql/index.js`; when
either condition is missing the whole describe is skipped, so the
default conformance run does not pay the testcontainers boot cost.

Current inventory:

| spec                    | upstream source                            | scope                                                                                                                                                          |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `tap/001_basic.spec.ts` | `src/bin/psql/t/001_basic.pl` (vendored)   | program args, `\timing`, `:ENCODING`, LISTEN/NOTIFY, server crash, `\errverbose`, multi-`-c`/`-f` + `--single-transaction`, `\copy ... DEFAULT`, `\watch`, `\g | pipe`, COPY-in-pipeline, `\restrict` |
| `tap/030_pager.spec.ts` | custom (upstream's `030_pager.pl` deleted) | `PAGER`, `PSQL_PAGER`, `\pset pager off` / `always`                                                                                                            |

Common helpers for these specs live in `tap/_helpers.ts`:

- `SHOULD_RUN_INTEGRATION` — combined gate (`RUN_INTEGRATION=1` AND
  `dist/psql/index.js` exists).
- `makeLauncher(prefix)` — writes a one-shot Node launcher that imports
  the built `runPsql` so spawned children execute the same code path
  as `bin/cli.js`.
- `runChild()` / `runPsqlScript()` — capture stdout/stderr/exit with a
  bounded timeout; the script variant feeds SQL on stdin with `-XAtq`
  (matches the PostgresNode `psql` helper).
- `ensureFixture()` — re-hydrates the per-worker postgres connection
  cache from the env vars that `globalSetup` populated.

Deferred work: subtests that don't yet pass against the embedded TS
psql are marked inline with `it.todo("<name> — <reason>")` (engine
gap) or `it.skip("<name> — <reason>")` (out of scope). Once the
underlying gap is closed, replace the `it.todo(...)` with a real
`it(...)` body. Vitest reports todo and skip counts separately from
pass/fail.

To run the integration tier locally:

```sh
bun run build
RUN_INTEGRATION=1 \
  npx vitest run --config tests/psql-conformance/vitest.config.ts \
  tests/psql-conformance/tap/001_basic.spec.ts
```

### Custom pager spec (`tap/030_pager.spec.ts`)

The pager spec is a gated **integration** test that:

- skips by default (no `RUN_INTEGRATION=1` in the env);
- skips when `dist/psql/index.js` is missing (no auto-build step);
- boots the shared postgres fixture and spawns a Node subprocess that
  imports `runPsql` from the built dist, so the code path matches
  what `bin/cli.js` would execute;
- exercises the four pager contracts from the upstream TAP file:
  `PAGER` spawns / receives query output / is suppressed by
  `\pset pager off` / `PSQL_PAGER` overrides `PAGER`.

To run the integration tier:

```sh
bun run build
RUN_INTEGRATION=1 \
  npx vitest run --config tests/psql-conformance/vitest.config.ts \
  tests/psql-conformance/tap/030_pager.spec.ts
```

Caveat: at time of writing the embedded TS psql does not yet wire the
pager into the query-printing path (see `src/psql/print/pager.ts` —
fully unit-tested but unintegrated). The spec is structured so that
adding the wiring should make the assertions tighter without rewriting
the harness; today the assertions are content-based and verify the
plumbing.

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

- triggers on PRs that change `src/psql/**`, `src/utils/psql.ts`,
  `src/commands/{branches,connection_string,projects}.ts`, or
  `tests/psql-conformance/**` (plus pushes to `main` / `feat/ts-psql`);
- fans out across a **PG matrix** (one job per supported major — see
  below) — each job boots its own `postgres:<major>` GHA service
  container and exposes it via `PGCONFORMANCE_PG_HOST=127.0.0.1` /
  `PGCONFORMANCE_PG_PORT=5432`;
- runs `bun run build` then `bun run test:conformance` with
  `PSQL_BINARY` pointed at `dist/cli.js`;
- uploads each job's `psql-conformance.log` under a per-version
  artifact name (`psql-conformance-pg-<major>`) for triage.

### PG version matrix

Neon supports PG 14 through PG 18, so the conformance job runs as a
matrix over `pg: ['14', '15', '16', '17', '18']`. Key points:

- `fail-fast: false` — every PG version runs, even if one fails, so a
  PG-18-only break does not hide a PG-15 break.
- Each matrix job is gated by `continue-on-error: true` on the
  conformance step (same as the single-version setup); flipping to
  blocking is a follow-up — see the criteria below.
- The job name encodes the matrix value (`psql-conformance (pg-18)`),
  so the GitHub check list is self-describing.
- `concurrency: psql-conformance-${{ github.ref }}` with
  `cancel-in-progress: true` so re-pushing a branch cancels the
  in-flight matrix.

### Non-blocking phase

The conformance step is **non-blocking** (`continue-on-error: true`)
during the bootstrap phase, so a failure surfaces as a warning on the
PR check list but does **not** gate merge. The flag lives on the
`Run conformance suite` step itself; the rest of the job (build,
install, artifact upload) still fails fast.

Flip to blocking when **all** of the following hold:

1. The conformance reporter's `coverage` headline is **>= 95%**.
2. `main` has stayed green on conformance for at least one week.

When that bar is met:

- drop `continue-on-error: true` from the `Run conformance suite` step
  in `psql-conformance.yml`;
- (optionally) add the `psql-conformance` job to the required-checks
  set in the repo's branch protection rules.
