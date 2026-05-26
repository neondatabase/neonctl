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
const VENDOR_ROOT = join(HERE, 'vendor', 'postgres-18.0');
const SQL_DIR = join(VENDOR_ROOT, 'src', 'test', 'regress', 'sql');
const EXPECTED_DIR = join(VENDOR_ROOT, 'src', 'test', 'regress', 'expected');

const REGRESS_CASES = ['psql', 'psql_crosstab', 'psql_pipeline'] as const;
type RegressCase = (typeof REGRESS_CASES)[number];

const PSQL_BINARY = process.env.PSQL_BINARY ?? 'psql';

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

    const args = [
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
    log(`regress/${name}: invoking ${PSQL_BINARY} ${args.join(' ')}`);
    const result = spawnSync(PSQL_BINARY, args, {
      input: sql,
      env: { ...process.env, PGPASSWORD: conn.password, LC_ALL: 'C' },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    });

    if (result.error) {
      // Couldn't even spawn psql.
      throw new Error(`spawn error: ${result.error.message}`);
    }

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
