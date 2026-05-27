// SQL regression driver. For each vendored .sql script we:
//   1. boot postgres (via globalSetup -> pg-fixture)
//   2. shell out to $PSQL_BINARY (default `psql` on $PATH) with the
//      vendored .sql piped on stdin
//   3. normalize stdout and diff against the vendored .out file
//   4. assert the diff is empty
//
// Day-1 invariant: with PSQL_BINARY pointing at the system psql, all
// three test bodies must pass. Subtests that don't yet pass against the
// TS implementation should be marked `it.todo("reason")` (engine gap)
// or `it.skip("reason")` (out of scope) in their spec file.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { normalize } from './harness/normalize.js';
import { getPgConn } from './harness/pg-fixture.js';
import { log } from './harness/util-log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const VENDOR_ROOT = join(HERE, 'vendor', 'postgres-18.0');
const SQL_DIR = join(VENDOR_ROOT, 'src', 'test', 'regress', 'sql');
const EXPECTED_DIR = join(VENDOR_ROOT, 'src', 'test', 'regress', 'expected');

const REGRESS_CASES = ['psql', 'psql_crosstab', 'psql_pipeline'] as const;
type RegressCase = (typeof REGRESS_CASES)[number];

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

describe.each(REGRESS_CASES)('regress/%s', (name: RegressCase) => {
  it('matches vendored expected output', () => {
    const conn = getPgConn();
    const sqlPath = join(SQL_DIR, `${name}.sql`);
    const expectedPath = join(EXPECTED_DIR, `${name}.out`);
    if (!existsSync(sqlPath)) {
      throw new Error(`vendor script missing: ${sqlPath}`);
    }
    if (!existsSync(expectedPath)) {
      throw new Error(`vendor expected output missing: ${expectedPath}`);
    }
    const sql = readFileSync(sqlPath, 'utf8');
    const expected = normalize(readFileSync(expectedPath, 'utf8'));

    const psqlArgs = [
      '--no-psqlrc',
      '--echo-all',
      '--quiet',
      '-X',
      '-v',
      'ON_ERROR_STOP=0',
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
      env: { ...process.env, PGPASSWORD: conn.password, LC_ALL: 'C' },
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
    const actual = normalize(stdout);

    if (actual === expected) {
      expect(actual).toBe(expected);
      return;
    }

    const diff = renderDiff(expected, actual);
    const failureMessage =
      `regress/${name} output differs from vendored expected.\n` +
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
