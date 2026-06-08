// SQL regression driver. For each upstream regress case we:
//   1. boot postgres (via globalSetup -> pg-fixture)
//   2. fetch the SQL + expected output from upstream PostgreSQL at the
//      commit pinned in `tests/psql-conformance/POSTGRES_REF` (no on-disk
//      vendor copy — the harness owns the fetch via
//      `harness/upstream-fixtures.ts`)
//   3. shell out to $PSQL_BINARY with the fetched SQL on stdin
//   4. normalize stdout and diff against the fetched expected file
//   5. assert the diff is empty
//
// Day-1 invariant: with PSQL_BINARY pointing at the system psql, all
// three test bodies must pass. Subtests that don't yet pass against the
// TS implementation should be marked `it.todo("reason")` (engine gap)
// or `it.skip("reason")` (out of scope) in their spec file.
//
// Upstream sources fetched at runtime (see harness/upstream-fixtures.ts):
//   https://github.com/postgres/postgres/blob/REL_18_0/src/test/regress/sql/psql.sql
//   https://github.com/postgres/postgres/blob/REL_18_0/src/test/regress/sql/psql_crosstab.sql
//   https://github.com/postgres/postgres/blob/REL_18_0/src/test/regress/sql/psql_pipeline.sql
//   …and the matching expected/ outputs.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { normalize } from './harness/normalize.js';
import { getPgConn } from './harness/pg-fixture.js';
import {
  fetchRegressFixtures,
  type RegressCaseName,
  type UpstreamRegressFixture,
} from './harness/upstream-fixtures.js';
import { log } from './harness/util-log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const REGRESS_CASES: readonly RegressCaseName[] = [
  'psql',
  'psql_crosstab',
  'psql_pipeline',
];
type RegressCase = RegressCaseName;

// Seed the `abs_builddir` / `abs_srcdir` psql variables the way upstream
// pg_regress does. Vendored scripts (e.g. regress/psql.sql) rely on them
// via `\getenv abs_builddir PG_ABS_BUILDDIR` followed by
// `\set g_out_file :abs_builddir '/results/psql-output1'`, then write to
// that file with `\g :g_out_file`. If the env var is missing, `\getenv`
// silently unsets the psql variable, the file path resolves to junk
// (`/results/psql-output1`), and `\g` fails to open it.
//
// The temp dir is now allocated by pg-fixture.ts BEFORE the container
// starts so the fixture can bind-mount the same path into the
// container — that pairs the client-side `\g :'g_out_file'` (writes
// from the harness on the host) with the server-side `COPY ... FROM
// :'g_out_file'` (reads from postgres inside the container). The
// fixture passes the path back through `PGCONFORMANCE_ABS_BUILDDIR`.
//
// When the fixture is bypassed (PGCONFORMANCE_PG_HOST set — see the
// GHA-service path in pg-fixture.ts), we fall back to a host-local
// mkdtemp so the suite still works against an externally-managed PG
// that shares a filesystem with us.
//
// abs_srcdir is read-only and historically pointed at the vendored sql
// dir for completeness; no current vendored script actually reads it,
// but upstream pg_regress sets both so we mirror the contract. Now that
// we no longer vendor the upstream files, abs_srcdir points at the same
// tmp dir as abs_builddir — harmless because nothing reads it.
//
// Cleanup is best-effort via `afterAll` — mkdtempSync collisions are
// impossible, and leaving the dir behind on crash is harmless.
const REGRESS_TMP = (() => {
  const fromFixture = process.env.PGCONFORMANCE_ABS_BUILDDIR;
  if (fromFixture) {
    // The fixture already created this and the `results/` subdir.
    return fromFixture;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'psql-conformance-regress-'));
  mkdirSync(join(tmp, 'results'), { recursive: true });
  return tmp;
})();
const REGRESS_TMP_OWNED_BY_SPEC = !process.env.PGCONFORMANCE_ABS_BUILDDIR;
const REGRESS_ABS_SRCDIR = REGRESS_TMP;

afterAll(() => {
  // Only this file is allowed to remove the dir it created. When the
  // fixture owns the tmp dir, globalTeardown handles cleanup so worker
  // teardown doesn't pull the rug out from under other workers.
  if (!REGRESS_TMP_OWNED_BY_SPEC) return;
  try {
    rmSync(REGRESS_TMP, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Resolve the psql binary the harness drives:
//
//   1. PSQL_BINARY set to a `.js` file (the common case for our shim at
//      `dist/psql/cli.js`, the workflow / matrix runner) — invoke via
//      `node` so the file does not need its executable bit set after
//      `tsc` emit. Hosts running `bun` work too because `process.execPath`
//      points at whichever runtime is driving vitest.
//   2. PSQL_BINARY set to neonctl's `dist/cli.js` — that's the yargs CLI,
//      NOT a psql shim. yargs intercepts libpq flags like
//      `-v ON_ERROR_STOP=0` (collides with --version) and exits before
//      psql mode is entered. Redirect to the standalone shim instead.
//   3. PSQL_BINARY unset — default to the shim at `dist/psql/cli.js`.
//   4. PSQL_BINARY set to a non-`.js` path — honour verbatim (system psql,
//      a custom build, etc.).
//
// The `command` + `commandArgs` pair is what `spawnSync` ultimately runs.
const resolvePsqlBinary = (): { command: string; commandArgs: string[] } => {
  const shimPath = join(REPO_ROOT, 'dist', 'psql', 'cli.js');
  const env = process.env.PSQL_BINARY;
  if (!env || env.endsWith('/dist/cli.js') || env === 'dist/cli.js') {
    return { command: process.execPath, commandArgs: [shimPath] };
  }
  if (env.endsWith('.js')) {
    return { command: process.execPath, commandArgs: [env] };
  }
  return { command: env, commandArgs: [] };
};

const { command: PSQL_COMMAND, commandArgs: PSQL_PREARGS } =
  resolvePsqlBinary();

// `regress/psql` is the only case in REGRESS_CASES whose vendored
// expected output and vendored SQL depend on PG-18-only catalog shape
// and SQL syntax: `\dAo+ Leakproof?`, `\df+ Leakproof?`, `\dRp+ Generated
// columns`, `\dx Default version`, `\dAp uuid_skipsupport`,
// `debug_parallel_query` GUC, and `GRANT ... WITH ADMIN TRUE` syntax.
// Folding every diverging output block onto PG 18 shape is feasible but
// fragile (each PG minor that drops a row would cascade through the
// rest of the script via downstream state). We keep the test
// authoritative on PG 18 (byte-perfect) and skip it on older servers;
// `regress/psql_crosstab` and `regress/psql_pipeline` still run on
// every PG and remain green across the 14-18 matrix.
const skipReasonForCase = (
  name: RegressCase,
  pgMajor?: number,
): string | null =>
  name === 'psql' && pgMajor !== undefined && pgMajor < 18
    ? `regress/psql expected output is PG ${pgMajor < 18 ? '18-pinned' : '18'}; older server output diverges on PG-18-only features (Leakproof?, Generated columns, uuid_skipsupport, GRANT WITH ADMIN TRUE, …)`
    : null;

// Fetch upstream SQL + expected outputs once per spec invocation. No
// on-disk cache — we accept the ~1-2s of HTTPS round-trips in exchange
// for the invariant "the harness always exercises the exact pinned
// upstream content". Generous timeout because the network can be slow
// in CI.
let upstreamFixtures: Map<RegressCaseName, UpstreamRegressFixture> | null =
  null;
beforeAll(async () => {
  upstreamFixtures = await fetchRegressFixtures();
}, 60_000);

describe.each(REGRESS_CASES)('regress/%s', (name: RegressCase) => {
  it('matches upstream expected output', (ctx) => {
    const conn = getPgConn();
    const skipReason = skipReasonForCase(name, conn.serverMajor ?? undefined);
    if (skipReason) {
      ctx.skip(skipReason);
    }
    if (!upstreamFixtures) {
      throw new Error('upstream fixtures not loaded (beforeAll did not run)');
    }
    const fixture = upstreamFixtures.get(name);
    if (!fixture) {
      throw new Error(`upstream fixture missing for ${name}`);
    }
    const sql = fixture.sql;
    // Apply the same normalize options to both sides of the diff so
    // version-conditional rules can collapse PG 14-17 wording onto
    // the PG 18 expected shape (rules only match older-PG output, so
    // they are no-ops on expected).
    const pgMajor = conn.serverMajor ?? undefined;
    const expected = normalize(fixture.expected, { pgMajor });

    const psqlArgs = [
      '--no-psqlrc',
      '--echo-all',
      '--quiet',
      '-X',
      '-v',
      'ON_ERROR_STOP=0',
      // Seed abs_builddir / abs_srcdir even though the vendored scripts
      // pull them from PG_ABS_BUILDDIR / PG_ABS_SRCDIR via `\getenv`.
      // The `-v` form is the upstream pg_regress contract and is
      // belt-and-suspenders against any script that uses `:abs_builddir`
      // without a prior `\getenv`.
      '-v',
      `abs_builddir=${REGRESS_TMP}`,
      '-v',
      `abs_srcdir=${REGRESS_ABS_SRCDIR}`,
      // Mirror upstream pg_regress: hide the per-relation access method
      // and toast-compression markers from `\d+` output. pg_regress
      // injects `\set HIDE_TABLEAM on` / `\set HIDE_TOAST_COMPRESSION on`
      // into its session psqlrc before running each script; the vendored
      // expected output therefore assumes both are `on`. Without these,
      // we emit `Access method: heap` / `Access method: heap_psql`
      // footers that diverge before the `\set HIDE_TABLEAM off` line in
      // the psql.sql script. Passing via `-v` is equivalent and is
      // robust against `--no-psqlrc`.
      '-v',
      'HIDE_TABLEAM=on',
      '-v',
      'HIDE_TOAST_COMPRESSION=on',
      '-h',
      conn.host,
      '-p',
      String(conn.port),
      '-U',
      conn.user,
      '-d',
      conn.db,
    ];
    const args = [...PSQL_PREARGS, ...psqlArgs];
    log(`regress/${name}: invoking ${PSQL_COMMAND} ${args.join(' ')} 2>&1`);
    // Upstream pg_regress invokes `psql 2>&1` so stderr is interleaved
    // into stdout at the OS level — each write call is atomic on the
    // shared pipe. spawnSync can't merge child stderr into stdout
    // directly, so we run the whole thing under `sh -c` and let the
    // shell do the `2>&1` redirect. The shell-quoting safety bar is
    // low here: we control every arg (no user input).
    const quote = (a: string): string => `'${a.replace(/'/g, "'\\''")}'`;
    const cmdline = [PSQL_COMMAND, ...args].map(quote).join(' ') + ' 2>&1';
    const result = spawnSync('sh', ['-c', cmdline], {
      input: sql,
      env: {
        ...process.env,
        PGPASSWORD: conn.password,
        LC_ALL: 'C',
        // `\getenv abs_builddir PG_ABS_BUILDDIR` reads these from the
        // child's environment — see vendor/.../regress/sql/psql.sql.
        PG_ABS_BUILDDIR: REGRESS_TMP,
        PG_ABS_SRCDIR: REGRESS_ABS_SRCDIR,
        // Mirror upstream pg_regress's process-environment seed. The
        // regression test cluster is initdb'd with these as the GUC
        // defaults; the vendored expected output captures the resulting
        // rendering. Without `datestyle=Postgres,MDY`, `SELECT
        // '2000-01-01'::date` renders as `2000-01-01` (ISO) rather than
        // the vendored `01-01-2000`. `timezone=PST8PDT` is harmless for
        // psql.sql (no `now()`-style queries in scope) but pairs with
        // the date style as the upstream contract.
        //
        // Real libpq picks up `PGDATESTYLE` / `PGTIMEZONE` as known
        // env-var keys. Our neonctl psql honours only the connection-info
        // env-var subset (PGHOST/PGPORT/PGOPTIONS/...) and would silently
        // ignore PGDATESTYLE, so we route both through `PGOPTIONS` —
        // libpq's general-purpose options forwarder. The startup
        // message stamps them as GUC overrides before the first query
        // runs, equivalent to a leading `SET datestyle = ...` but without
        // emitting a row in `--echo-all` output.
        PGOPTIONS: '-c datestyle=Postgres,MDY -c timezone=PST8PDT',
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      // Hard kill if a buggy psql impl hangs (e.g., COPY-FROM-STDIN
      // inside a multi-statement chain isn't currently driven by the
      // mainloop — psql.sql line ~1468 triggers it). The test then
      // fails on a real diff or a spawn error rather than freezing
      // the whole suite.
      timeout: 60_000,
    });

    if (result.error) {
      // Couldn't even spawn psql.
      throw new Error(`spawn error: ${result.error.message}`);
    }

    // With `sh -c "... 2>&1"`, all output lands in stdout in the order
    // the child wrote it; stderr is empty (or holds shell errors only).
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const actual = normalize(stdout, { pgMajor });

    if (actual === expected) {
      expect(actual).toBe(expected);
      return;
    }

    const diff = renderDiff(expected, actual);
    const failureMessage =
      `regress/${name} output differs from upstream expected.\n` +
      `--- expected (normalized)\n+++ actual (normalized)\n${diff}\n` +
      (stderr ? `--- stderr ---\n${stderr}\n` : '');
    throw new Error(failureMessage);
  });
});

// Cheap line-oriented diff for failure messages — we do not pull in
// a diff library because the human reading the failure will already
// reach for `git diff` on the saved actual output. The first N
// differing lines is plenty for triage.
function renderDiff(expected: string, actual: string, maxLines = 40): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const out: string[] = [];
  const max = Math.max(e.length, a.length);
  let printed = 0;
  for (let i = 0; i < max && printed < maxLines; i++) {
    if (e[i] !== a[i]) {
      out.push(`@@ line ${i + 1}`);
      out.push(`- ${e[i] ?? '<eof>'}`);
      out.push(`+ ${a[i] ?? '<eof>'}`);
      printed += 1;
    }
  }
  if (printed === maxLines) {
    out.push(`... diff truncated at ${maxLines} mismatched lines`);
  }
  return out.join('\n');
}
