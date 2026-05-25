#!/usr/bin/env bun
// Re-seed `tests/psql-conformance/KNOWN_FAILURES.yml` from a real run.
//
// Maintainers invoke this script ONCE after a major TS-psql behaviour
// change, so the conformance ledger reflects the new parity gap rather
// than the old one. The script:
//
//   1. Boots postgres (testcontainers locally; honours
//      $PGCONFORMANCE_PG_HOST if set, e.g. an externally-managed
//      service container).
//   2. Builds the TS psql (`bun run build`) unless `--skip-build` is
//      passed (or `dist/cli.js` already exists and `--reuse-build` is
//      passed).
//   3. Runs the conformance vitest suite once with the JSON reporter,
//      pointing $PSQL_BINARY at the freshly-built `dist/cli.js`.
//   4. Walks the JSON report, collects each failing assertion's
//      `regress/<case>` test name, and rewrites KNOWN_FAILURES.yml
//      with one entry per failure.
//   5. Backs up the previous KNOWN_FAILURES.yml as
//      KNOWN_FAILURES.yml.bak, prints a coverage summary, and exits 0.
//
// USAGE
//   bun run test:conformance:seed
//   bun run test:conformance:seed -- --skip-build
//   bun run test:conformance:seed -- --reuse-build
//
// SAFETY
// The original ledger is always copied to .bak before the rewrite, so
// a maintainer can `git diff` (or `mv ... ledger.bak ledger`) if the
// new baseline looks wrong.

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { setupPg, teardownPg } from '../harness/pg-fixture.js';
import { log } from '../harness/util-log.js';

type CliFlags = {
  skipBuild: boolean;
  reuseBuild: boolean;
};

type JsonAssertion = {
  ancestorTitles: string[];
  fullName: string;
  title: string;
  status: 'passed' | 'failed' | 'pending' | 'skipped' | 'todo';
  failureMessages?: string[];
};

type JsonFileResult = {
  name: string;
  status: 'passed' | 'failed';
  assertionResults: JsonAssertion[];
};

type JsonReport = {
  numFailedTests: number;
  numPassedTests: number;
  numTotalTests: number;
  testResults: JsonFileResult[];
};

type KnownFailureEntry = {
  test: string;
  scope: 'full-file' | 'subtest';
  subtest?: string;
  reason: string;
  owner: string;
  ticket: string;
  added: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CONFORMANCE_ROOT, '..', '..');
const LEDGER_PATH = join(CONFORMANCE_ROOT, 'KNOWN_FAILURES.yml');
const LEDGER_BAK_PATH = `${LEDGER_PATH}.bak`;
const VITEST_CONFIG = join(CONFORMANCE_ROOT, 'vitest.config.ts');
const DIST_BINARY = join(REPO_ROOT, 'dist', 'cli.js');
const DEFAULT_OWNER = '@neonctl-ts-psql';
const DEFAULT_REASON = 'TS-impl gap — TODO triage';

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));

  if (!flags.skipBuild) {
    if (flags.reuseBuild && existsSync(DIST_BINARY)) {
      log(`seed: reusing existing build at ${DIST_BINARY}`);
    } else {
      log('seed: building TS psql (bun run build)...');
      const build = spawnSync('bun', ['run', 'build'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
      if (build.status !== 0) {
        log(`seed: build failed (exit ${String(build.status)})`);
        return 1;
      }
    }
  } else {
    log('seed: --skip-build set; assuming dist/cli.js is current');
  }

  if (!existsSync(DIST_BINARY)) {
    log(
      `seed: ${DIST_BINARY} does not exist. Run \`bun run build\` first ` +
        'or drop --skip-build.',
    );
    return 1;
  }

  log('seed: booting postgres fixture...');
  const conn = await setupPg();
  // Propagate fixture connection to the vitest child so its globalSetup
  // re-uses the same instance instead of booting another container.
  process.env.PGCONFORMANCE_PG_HOST = conn.host;
  process.env.PGCONFORMANCE_PG_PORT = String(conn.port);
  process.env.PGCONFORMANCE_PG_DB = conn.db;
  process.env.PGCONFORMANCE_PG_USER = conn.user;
  process.env.PGCONFORMANCE_PG_PASSWORD = conn.password;
  process.env.PSQL_BINARY = DIST_BINARY;

  const tmp = mkdtempSync(join(tmpdir(), 'psql-conformance-seed-'));
  const reportPath = join(tmp, 'report.json');
  log(`seed: running conformance suite (report -> ${reportPath})`);

  try {
    const run = spawnSync(
      'bunx',
      [
        'vitest',
        'run',
        '--config',
        VITEST_CONFIG,
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: process.env,
      },
    );
    // We intentionally do NOT bail on non-zero exit: vitest exits non-zero
    // precisely when assertions fail, which is the case we want to seed.
    if (run.error) {
      log(`seed: failed to spawn vitest: ${run.error.message}`);
      return 1;
    }

    if (!existsSync(reportPath)) {
      log(`seed: vitest did not write a report at ${reportPath}`);
      return 1;
    }

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as JsonReport;
    const failures = collectFailures(report);
    const today = new Date().toISOString().slice(0, 10);
    const entries = buildEntries(failures, today);

    backupExistingLedger();
    writeLedger(entries);

    const summary = summarise(report, entries.length);
    log('---');
    log(summary);
    log('---');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await teardownPg();
  }
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { skipBuild: false, reuseBuild: false };
  for (const arg of argv) {
    if (arg === '--skip-build') flags.skipBuild = true;
    else if (arg === '--reuse-build') flags.reuseBuild = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: bun run test:conformance:seed [-- --skip-build|--reuse-build]',
          '',
          '  --skip-build    Do not run `bun run build`; assume dist/cli.js is current',
          '  --reuse-build   Skip rebuild iff dist/cli.js already exists',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      log(`seed: unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return flags;
}

/**
 * Pull each failing assertion out of a vitest JSON report and map it to
 * a `regress/<case>` test name. Failures outside `regress.spec.ts` (i.e.
 * harness unit tests) are reported but NOT seeded — they represent
 * harness bugs, not parity gaps, and would mask real problems.
 */
function collectFailures(report: JsonReport): KnownFailureEntry[] {
  const out: KnownFailureEntry[] = [];
  for (const file of report.testResults) {
    const isRegressFile = file.name.endsWith('regress.spec.ts');
    for (const a of file.assertionResults) {
      if (a.status !== 'failed') continue;
      if (!isRegressFile) {
        log(
          `seed: ignoring failure outside regress.spec.ts: ${a.fullName} ` +
            `(${file.name}) — harness bug, fix at source instead of pinning`,
        );
        continue;
      }
      // regress.spec.ts uses `describe.each(REGRESS_CASES)('regress/%s', ...)`
      // so ancestorTitles[0] is e.g. "regress/psql".
      const testName = a.ancestorTitles[0] ?? 'regress/<unknown>';
      out.push({
        test: testName,
        scope: 'full-file',
        reason: DEFAULT_REASON,
        owner: DEFAULT_OWNER,
        ticket: '',
        added: '',
      });
    }
  }
  return out;
}

function buildEntries(
  failures: readonly KnownFailureEntry[],
  today: string,
): KnownFailureEntry[] {
  // Deduplicate by (test, scope, subtest). regress.spec.ts has one `it`
  // per case so duplicates should be impossible, but the script may
  // grow subtest support — keep the de-dup defensive.
  const seen = new Set<string>();
  const result: KnownFailureEntry[] = [];
  for (const f of failures) {
    const key = `${f.test}|${f.scope}|${f.subtest ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...f, added: today });
  }
  // Stable order: by test name, then subtest for predictable diffs.
  result.sort((a, b) => {
    if (a.test !== b.test) return a.test < b.test ? -1 : 1;
    return (a.subtest ?? '').localeCompare(b.subtest ?? '');
  });
  return result;
}

function backupExistingLedger(): void {
  if (!existsSync(LEDGER_PATH)) {
    log(`seed: no existing ledger at ${LEDGER_PATH}; nothing to back up`);
    return;
  }
  copyFileSync(LEDGER_PATH, LEDGER_BAK_PATH);
  log(`seed: backed up existing ledger to ${LEDGER_BAK_PATH}`);
}

function writeLedger(entries: readonly KnownFailureEntry[]): void {
  const header = [
    '# Known failures — the conformance ledger.',
    '#',
    '# AUTO-GENERATED by `bun run test:conformance:seed`. Hand-edits are',
    '# expected: triage entries by replacing the placeholder reason/ticket',
    '# with the real gap, and delete entries as TS-psql parity catches up.',
    '#',
    '# Schema:',
    "#   - test:    'regress/<name>' or 'tap/<name>'",
    "#     scope:   'full-file' or 'subtest'",
    "#     subtest: required when scope is 'subtest'",
    '#     reason:  short human description; reference the WP',
    '#     owner:   GitHub handle / team',
    '#     ticket:  optional issue id',
    '#     added:   ISO date the entry was added',
    '',
  ].join('\n');

  // Emit explicit empty list rather than `null`, matching the prior
  // hand-curated baseline.
  const body =
    entries.length === 0
      ? '[]\n'
      : YAML.stringify(entries, {
          // YAML 1.2 keeps strings unquoted unless ambiguous; default flow
          // is block, which renders one entry per stanza like the original.
          lineWidth: 0,
        });

  writeFileSync(LEDGER_PATH, `${header}${body}`, 'utf8');
  log(`seed: wrote ${String(entries.length)} entries to ${LEDGER_PATH}`);
}

function summarise(report: JsonReport, seeded: number): string {
  const total = report.numTotalTests;
  const passed = report.numPassedTests;
  const failed = report.numFailedTests;
  const coverage = total === 0 ? 0 : Math.round((passed / total) * 10000) / 100;
  return [
    `total tests:     ${String(total)}`,
    `passed:          ${String(passed)}`,
    `failed:          ${String(failed)}`,
    `seeded entries:  ${String(seeded)}`,
    `coverage:        ${String(coverage)}% (passed / total)`,
  ].join('\n');
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`seed: fatal: ${msg}`);
    process.exit(1);
  });
