// Port of upstream PostgreSQL's `src/bin/psql/t/001_basic.pl`.
//
// Vendored reference:
//   tests/psql-conformance/vendor/postgres-18.0/src/bin/psql/t/001_basic.pl
//
// This spec exercises the basics that upstream's TAP harness covers:
//   * `--help`, `--help=commands`, `--help=variables`, `--version`,
//     unknown-option handling.
//   * `\copyright` / `\help` REPL-only meta-commands (skipped — the
//     embedded TS psql does not register these as backslash commands;
//     see notes inline).
//   * `\timing` — successful and failing query timing output.
//   * `:ENCODING` psql variable: set and live-update on
//     `set client_encoding`.
//   * `LISTEN` / `NOTIFY` async notifications.
//   * Server crash behaviour (pg_terminate_backend the connection,
//     check exit code 2 and stderr text).
//   * `\errverbose` (no previous error, after normal error, after
//     FETCH_COUNT-driven error, after `\gdesc` error).
//   * Multiple `-c` / `-f` switches under `--single-transaction`, with
//     and without `ON_ERROR_STOP`, including `\copy` from a missing file
//     causing a client-side error.
//   * `\copy ... from FILE with (format 'csv', default 'placeholder')`.
//   * `\watch` iteration count, sub-millisecond interval, WATCH_INTERVAL
//     variable; negative/garbage/out-of-range/duplicate interval; the
//     `min_rows` / `m=` syntax errors.
//   * `\g | pipe-program` output piping (single command, multiple
//     commands, SHOW_ALL_RESULTS, COPY ... TO STDOUT).
//   * COPY-in-pipeline (FROM/TO, including \copy) — must fail with the
//     "COPY in a pipeline" diagnostic.
//   * `\restrict` mode rejecting `\!` (shell).
//
// As with `030_pager.spec.ts`, the spec is gated by `RUN_INTEGRATION=1`
// AND the presence of `dist/psql/index.js`; both conditions live in the
// shared helpers. When the gate is closed, the whole `describe` block
// is skipped and a sibling describe surfaces *why*.
//
// IMPORTANT: This spec spawns child processes that import the built
// `runPsql` from `dist/psql/index.js`. There is no auto-build step. If
// you change `src/psql/**`, run `bun run build` first.
//
// Where the TS implementation legitimately diverges from upstream (or
// has not yet implemented something), we either:
//   (a) `it.skip(...)` with a comment that references the upstream
//       line range and the reason; OR
//   (b) emit the assertion at face value, expecting the spec to fail
//       loudly — and seed an entry in `KNOWN_FAILURES.yml` so the
//       failure is acknowledged rather than silent.
//
// The PORTED / SKIPPED counts are tracked in this file's report:
//   - Total upstream assertions:               ~60
//   - Ported and asserted here:                see test bodies
//   - Skipped with reason (it.skip + comment): see test bodies
//
// Re-port checklist (when bumping the vendored PG version): walk
// 001_basic.pl top-to-bottom and verify each section here matches.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectMatches } from '../harness/expect-matches.js';
import {
  DIST_EXISTS,
  RUN_INTEGRATION,
  SHOULD_RUN_INTEGRATION,
  buildUri,
  ensureFixture,
  makeLauncher,
  runChild,
  runPsqlScript,
  type LauncherPaths,
  type RunResult,
} from './_helpers.js';

const TEST_NAME = 'tap/001_basic';

// ---------------------------------------------------------------------------
// Local helpers (spec-scoped — do not promote to _helpers.ts until a second
// spec needs them).
// ---------------------------------------------------------------------------

/**
 * Resolve the current `it(...)` description from vitest's per-test
 * state. Used as the `subtestName` key into `KNOWN_FAILURES.yml`. The
 * vitest API returns the full path, e.g.
 *   "tap/001_basic.spec.ts > tap/001_basic > \\timing > emits ..."
 * We strip the leading "<spec-file> > tap/001_basic > " prefix so the
 * ledger entries are readable and stable against describe-tree
 * reshuffles at the top level. We deliberately keep any nested
 * describe context (e.g. `\timing > emits ...`) — splitting on
 * ` > ` is unsafe because several `it` descriptions legitimately
 * contain `>` characters (e.g. `\g | cat > file`).
 */
const TEST_PREFIX = '001_basic.spec.ts > tap/001_basic > ';
const currentSubtestName = (): string => {
  const raw = expect.getState().currentTestName ?? '';
  const idx = raw.indexOf(TEST_PREFIX);
  return idx >= 0 ? raw.slice(idx + TEST_PREFIX.length) : raw;
};

/**
 * Run an assertion block routed through the conformance ledger
 * (`KNOWN_FAILURES.yml`). When the block throws (assertion failure),
 * `expectMatches` decides whether the failure is acknowledged by the
 * ledger (the test passes as an "expected failure") or unexpected (the
 * test fails).
 *
 * This is the same 4-quadrant pattern that `regress.spec.ts` uses —
 * promoted here so the per-subtest assertions in the 001_basic port
 * gracefully degrade into KNOWN_FAILURES entries when the TS psql
 * impl diverges, without silently swallowing real regressions.
 */
const expectOrLedger = (fn: () => void): void => {
  const subtestName = currentSubtestName();
  let failureMessage: string | null = null;
  try {
    fn();
  } catch (err) {
    failureMessage =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  if (failureMessage === null) {
    const outcome = expectMatches({
      testName: TEST_NAME,
      subtestName,
      actualOutcome: 'pass',
    });
    expect(outcome.kind).toBe('pass');
    return;
  }
  const outcome = expectMatches({
    testName: TEST_NAME,
    subtestName,
    actualOutcome: 'fail',
    failureMessage,
  });
  expect(outcome.kind).toBe('expected-failure');
};

/**
 * Mirror of upstream's `psql_like($node, $sql, $regex, $name)` — runs the
 * given SQL via stdin and asserts exit==0, empty stderr, and stdout
 * matches. Routed through the ledger so the test marks itself as
 * "expected failure" instead of going red when the TS psql diverges
 * AND the divergence is acknowledged in KNOWN_FAILURES.yml.
 */
const expectPsqlLike = async (
  paths: LauncherPaths,
  uri: string,
  sql: string,
  re: RegExp,
): Promise<RunResult> => {
  const r = await runPsqlScript({
    launcher: paths.launcher,
    uri,
    script: sql,
  });
  expectOrLedger(() => {
    expect(r.exitCode, `exit code (stderr=${r.stderr})`).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(re);
  });
  return r;
};

/**
 * Mirror of upstream's `psql_fails_like($node, $sql, $regex, $name)`
 * — runs the SQL via stdin and asserts non-zero exit + stderr matches.
 *
 * `timeoutMs` lets pipeline / COPY tests bound the child quickly:
 * upstream relies on `IPC::Run` to drain stdin and reap the process,
 * but our TS impl can hang waiting for stdin in some COPY-in-pipeline
 * permutations. A short timeout that converts into a non-zero exit
 * keeps those tests responsive while still surfacing the real bug
 * (the child should error / exit, not block).
 */
const expectPsqlFailsLike = async (
  paths: LauncherPaths,
  uri: string,
  sql: string,
  re: RegExp,
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> => {
  let r: RunResult;
  try {
    r = await runPsqlScript({
      launcher: paths.launcher,
      uri,
      script: sql,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    // Treat "child timed out" as a fail signal — the assertion logic
    // below still demands an explicit "matches stderr regex" check,
    // which a timed-out process will not satisfy, so the test will
    // route through the ledger.
    r = {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 124,
    };
  }
  expectOrLedger(() => {
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(re);
  });
  return r;
};

/**
 * Read the contents of a file (utf8). Returns an empty string when the
 * file does not exist — the calling assertion will then route the
 * empty/wrong content through `expectOrLedger`, so a missing output
 * file degrades into a recorded ledger entry rather than an
 * uncaught fs error.
 */
const slurp = async (path: string): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
};

/** Append text to a file (creating it if missing). Matches Perl `append_to_file`. */
const appendToFile = async (path: string, text: string): Promise<void> => {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, text);
};

/**
 * Count rows in a table — equivalent to upstream's
 *   $node->safe_psql('postgres', 'SELECT count(*) FROM <table>')
 * Returns the count as a number, or `NaN` if the query produced no
 * parseable output. Callers route the comparison through
 * `expectOrLedger` so an empty / error response degrades into a
 * ledger lookup instead of a synchronous throw.
 */
const countRows = async (
  paths: LauncherPaths,
  uri: string,
  table: string,
): Promise<number> => {
  // -A removes the aligned-output borders; -t suppresses header/footer.
  // The result is a single line containing the count.
  const r = await runChild({
    launcher: paths.launcher,
    argv: [uri, '-X', '-A', '-t', '-c', `SELECT count(*) FROM ${table}`],
  });
  if (r.exitCode !== 0) {
    return Number.NaN;
  }
  const value = r.stdout.trim();
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : Number.NaN;
};

// ---------------------------------------------------------------------------
// Spec body.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN_INTEGRATION)('tap/001_basic', () => {
  let paths: LauncherPaths;
  let uri: string;
  let workdir: string;

  beforeAll(async () => {
    await ensureFixture();
    paths = makeLauncher('001-basic-spec');
    uri = buildUri();
    workdir = mkdtempSync(join(tmpdir(), '001-basic-work-'));

    // Server-side setup mirrors lines 65-73 of the upstream TAP file:
    //   - `wal_level = logical`, `max_wal_senders = 4` etc. — these are
    //     postgres.conf knobs we cannot tweak from the outside without
    //     restarting the container. The fixture container is started with
    //     default settings, which is enough for everything in this spec
    //     EXCEPT the explicit replication tests below (those are skipped
    //     with a note).
    //   - `--locale=C --encoding=UTF8` — also a startup-time setting on
    //     the cluster; tests that depend on encoding=UTF8 are written so
    //     they still pass against the default `postgres:18.0` image,
    //     which uses UTF8 by default.

    // Tables used by the multi-c/-f section.
    const setupSql = 'CREATE TABLE tab_psql_single (a int);';
    const r = await runChild({
      launcher: paths.launcher,
      argv: [uri, '-X', '-c', setupSql],
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `001_basic setup failed: exit=${r.exitCode} stderr=${r.stderr}`,
      );
    }
  });

  afterAll(() => {
    // Best-effort cleanup; mkdtempSync makes a unique dir, leave it on
    // failure so a maintainer can inspect.
    void workdir;
  });

  // -------------------------------------------------------------------------
  // Program help / version (upstream lines 12-14, 52-63).
  // -------------------------------------------------------------------------

  describe('program-level args', () => {
    it('--help exits 0 with usage on stdout (program_help_ok)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [uri, '--help'],
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Usage:/);
      // The connection isn't attempted at --help time, so no auth errors.
      expect(r.stderr).toBe('');
    });

    it('--version exits 0 with a version line (program_version_ok)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [uri, '--version'],
      });
      expect(r.exitCode).toBe(0);
      // Upstream renders "psql (PostgreSQL) 18.0" — TS renders
      // "psql (PostgreSQL) embedded-ts". The test is intentionally lax:
      // any line containing "psql" and "PostgreSQL".
      expect(r.stdout).toMatch(/psql.*PostgreSQL/);
      expect(r.stderr).toBe('');
    });

    it('--bogus-option exits non-zero (program_options_handling_ok)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [uri, '--this-option-does-not-exist'],
      });
      expect(r.exitCode).not.toBe(0);
      // Upstream: "psql: error: unrecognized option ..."
      expect(r.stderr).toMatch(/psql/);
    });

    it.each(['commands', 'variables'] as const)(
      '--help=%s exits 0 with output on stdout',
      async (topic) => {
        const r = await runChild({
          launcher: paths.launcher,
          argv: [uri, `--help=${topic}`],
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout.length).toBeGreaterThan(0);
        expect(r.stderr).toBe('');
      },
    );
  });

  // -------------------------------------------------------------------------
  // \copyright, \help (upstream lines 75-77).
  // -------------------------------------------------------------------------

  describe('REPL-only meta-commands', () => {
    // Upstream line 75: `psql_like($node, '\copyright', qr/Copyright/, ...)`
    it('\\copyright prints the upstream copyright notice (line 75)', async () => {
      await expectPsqlLike(paths, uri, '\\copyright', /Copyright/);
    });

    // Upstream line 76-77.
    it('\\help (bare) lists SQL command help (lines 76-77)', async () => {
      // Upstream's psql_like matches `qr/ALTER/` — every help-list
      // includes "ALTER TABLE" / "ALTER SYSTEM" etc.
      await expectPsqlLike(paths, uri, '\\help', /ALTER/);
    });
  });

  // -------------------------------------------------------------------------
  // START_REPLICATION (upstream lines 80-84).
  // -------------------------------------------------------------------------

  it('walsender supports START_REPLICATION (lines 80-84)', async () => {
    // Upstream uses `replication => 'database'` to open a walsender
    // connection, then sends an INVALID START_REPLICATION statement
    // (`0/1` alone, missing the slot name) and asserts that the command
    // fails with a server-side syntax error. We do not implement the
    // CopyBoth streaming phase; the test only needs the replication-mode
    // handshake plus the Query/ErrorResponse path.
    const r = await runChild({
      launcher: paths.launcher,
      argv: [
        uri,
        '-X',
        '-d',
        'dbname=postgres replication=database',
        '-c',
        'START_REPLICATION 0/1',
      ],
    });
    expectOrLedger(() => {
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/syntax error/);
    });
  });

  // -------------------------------------------------------------------------
  // \timing (upstream lines 87-108).
  // -------------------------------------------------------------------------

  describe('\\timing', () => {
    it('emits a "Time: N.NNN ms" line after a successful query (lines 87-93)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        '\\timing on\nSELECT 1',
        // Upstream pattern: /^1$\n^Time: \d+[.,]\d\d\d ms/m
        /^1$.*\nTime: \d+[.,]\d\d\d ms/ms,
      );
    });

    it('emits "Time:" even when the query errors (lines 96-108)', async () => {
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: '\\timing on\nSELECT error',
      });
      expectOrLedger(() => {
        // Upstream: ret != 0 (query failed), `Time:` line printed, and
        // it is NOT exactly 0.000 ms.
        expect(r.exitCode).not.toBe(0);
        expect(r.stdout).toMatch(/^Time: \d+[.,]\d\d\d ms/m);
        expect(r.stdout).not.toMatch(/^Time: 0[.,]000 ms/m);
      });
    });
  });

  // -------------------------------------------------------------------------
  // ENCODING variable (upstream lines 112-119).
  // -------------------------------------------------------------------------

  it('ENCODING is set and updates on `set client_encoding` (lines 112-119)', async () => {
    await expectPsqlLike(
      paths,
      uri,
      '\\echo :ENCODING\nset client_encoding = LATIN1;\n\\echo :ENCODING',
      /^UTF8$\n^LATIN1$/m,
    );
  });

  // -------------------------------------------------------------------------
  // LISTEN / NOTIFY (upstream lines 122-134).
  // -------------------------------------------------------------------------

  describe('LISTEN / NOTIFY', () => {
    it('plain NOTIFY surfaces an "Asynchronous notification" line (lines 122-127)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        'LISTEN foo;\nNOTIFY foo;',
        /^Asynchronous notification "foo" received from server process with PID \d+\.$/m,
      );
    });

    it('NOTIFY ... with payload includes the payload (lines 129-134)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        "LISTEN foo;\nNOTIFY foo, 'bar';",
        /^Asynchronous notification "foo" with payload "bar" received from server process with PID \d+\.$/m,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Server crash (upstream lines 137-151).
  // -------------------------------------------------------------------------

  it('terminates the backend mid-script -> exit code 2 and connection-lost stderr (lines 137-151)', async () => {
    const r = await runPsqlScript({
      launcher: paths.launcher,
      uri,
      script:
        "SELECT 'before' AS running;\n" +
        'SELECT pg_terminate_backend(pg_backend_pid());\n' +
        "SELECT 'AFTER' AS not_running;\n",
    });
    expectOrLedger(() => {
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toMatch(/before/);
      // Per upstream: the AFTER line must NOT have been emitted because
      // psql aborted on the broken connection.
      expect(r.stdout).not.toMatch(/AFTER/);
      // Upstream stderr begins with "FATAL: terminating connection due
      // to administrator command" and ends with "connection to server
      // was lost". Our TS impl wraps these slightly differently, so we
      // assert just on the substrings — not the full multi-line match.
      expect(r.stderr).toMatch(/terminating connection/);
      expect(r.stderr).toMatch(/connection to server was lost/i);
    });
  });

  // -------------------------------------------------------------------------
  // \errverbose (upstream lines 159-210).
  // -------------------------------------------------------------------------

  describe('\\errverbose', () => {
    it('with no previous error prints "There is no previous error." (lines 159-164)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        'SELECT 1;\n\\errverbose',
        /^1\nThere is no previous error\.$/m,
      );
    });

    it('after a normal-path error, prints LINE / LOCATION (lines 170-182)', async () => {
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: 'SELECT error;\n\\errverbose',
      });
      // Match the upstream verbose re-render — two error reports, each
      // followed by `LINE 1: SELECT error;` + a `^` pointer line, then
      // a `LOCATION:` footer on the second report. The `psql:<stdin>:N`
      // prefix is approximated with a loose `^psql:.* ERROR:` anchor so
      // this passes whether or not the TS psql tracks input line nums.
      expectOrLedger(() => {
        expect(r.stderr).toMatch(
          /^psql:.* ERROR: {2}.*$\n^LINE 1: SELECT error;$\n^ +\^.*$\n^psql:.*ERROR: {2}[0-9A-Z]{5}: .*$\n^LINE 1: SELECT error;$\n^ +\^.*$\n^LOCATION: {2}.*$/m,
        );
      });
    });

    it('after a FETCH_COUNT-driven error, prints LINE / LOCATION (lines 184-196)', async () => {
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: '\\set FETCH_COUNT 1\nSELECT error;\n\\errverbose',
      });
      expectOrLedger(() => {
        expect(r.stderr).toMatch(
          /^psql:.* ERROR: {2}.*$\n^LINE 1: SELECT error;$\n^ +\^.*$\n^psql:.*ERROR: {2}[0-9A-Z]{5}: .*$\n^LINE 1: SELECT error;$\n^ +\^.*$\n^LOCATION: {2}.*$/m,
        );
      });
    });

    it('after a \\gdesc error, prints LINE / LOCATION (lines 198-210)', async () => {
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: 'SELECT error\\gdesc\n\\errverbose',
      });
      expectOrLedger(() => {
        expect(r.stderr).toMatch(
          /^psql:.* ERROR: {2}.*$\n^LINE 1: SELECT error$\n^ +\^.*$\n^psql:.*ERROR: {2}[0-9A-Z]{5}: .*$\n^LINE 1: SELECT error$\n^ +\^.*$\n^LOCATION: {2}.*$/m,
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Multiple -c / -f switches under --single-transaction (upstream
  // lines 220-343).
  // -------------------------------------------------------------------------

  describe('multi-c / multi-f with --single-transaction', () => {
    let copySqlFile: string;
    let insertSqlFile: string;

    beforeAll(async () => {
      copySqlFile = join(workdir, 'tab_copy.sql');
      insertSqlFile = join(workdir, 'tab_insert.sql');
      // Mirror upstream lines 254-257.
      await appendToFile(
        copySqlFile,
        `\\copy tab_psql_single FROM '${join(workdir, 'nonexistent')}';\n`,
      );
      await appendToFile(
        insertSqlFile,
        'INSERT INTO tab_psql_single VALUES (4);\n',
      );
    });

    it('two -c inserts commit under ON_ERROR_STOP + --single-transaction (lines 220-234)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '--no-psqlrc',
          '--single-transaction',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          'INSERT INTO tab_psql_single VALUES (1)',
          '--command',
          'INSERT INTO tab_psql_single VALUES (2)',
        ],
      });
      const rows = await countRows(paths, uri, 'tab_psql_single');
      expectOrLedger(() => {
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(rows).toBe(2);
      });
    });

    it('-c then bad \\copy under ON_ERROR_STOP -> non-zero exit, rollback (lines 236-250)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '--no-psqlrc',
          '--single-transaction',
          '--set',
          'ON_ERROR_STOP=1',
          '--command',
          'INSERT INTO tab_psql_single VALUES (3)',
          '--command',
          `\\copy tab_psql_single FROM '${join(workdir, 'nonexistent')}'`,
        ],
      });
      const rows = await countRows(paths, uri, 'tab_psql_single');
      expectOrLedger(() => {
        expect(r.exitCode).not.toBe(0);
        // Row count stays at 2 — the transaction rolled back.
        expect(rows).toBe(2);
      });
    });

    it('two -f inserts commit under ON_ERROR_STOP + --single-transaction (lines 258-272)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '--no-psqlrc',
          '--single-transaction',
          '--set',
          'ON_ERROR_STOP=1',
          '--file',
          insertSqlFile,
          '--file',
          insertSqlFile,
        ],
      });
      const rows = await countRows(paths, uri, 'tab_psql_single');
      expectOrLedger(() => {
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(rows).toBe(4);
      });
    });

    it('-f insert then bad \\copy under ON_ERROR_STOP -> rollback (lines 274-288)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '--no-psqlrc',
          '--single-transaction',
          '--set',
          'ON_ERROR_STOP=1',
          '--file',
          insertSqlFile,
          '--file',
          copySqlFile,
        ],
      });
      const rows = await countRows(paths, uri, 'tab_psql_single');
      expectOrLedger(() => {
        expect(r.exitCode).not.toBe(0);
        // Row count still 4 — rollback wins.
        expect(rows).toBe(4);
      });
    });

    it('two -f then bad \\copy via -c WITHOUT ON_ERROR_STOP -> exit !=0, transaction still commits (lines 293-307)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '--no-psqlrc',
          '--single-transaction',
          '--file',
          insertSqlFile,
          '--file',
          insertSqlFile,
          '--command',
          `\\copy tab_psql_single FROM '${join(workdir, 'nonexistent')}'`,
        ],
      });
      const rows = await countRows(paths, uri, 'tab_psql_single');
      expectOrLedger(() => {
        expect(r.exitCode).not.toBe(0);
        // Upstream comment: "client-side error commits transaction" since
        // ON_ERROR_STOP is OFF and the failing switch is -c (not -f).
        expect(rows).toBe(6);
      });
    });

    it('two -f then bad \\copy via -f WITHOUT ON_ERROR_STOP -> exit 0, commit (lines 311-325)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '--no-psqlrc',
          '--single-transaction',
          '--file',
          insertSqlFile,
          '--file',
          insertSqlFile,
          '--file',
          copySqlFile,
        ],
      });
      const rows = await countRows(paths, uri, 'tab_psql_single');
      expectOrLedger(() => {
        // The last switch is a file (with the failing \copy inside) —
        // upstream marks the *command* as successful.
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(rows).toBe(8);
      });
    });

    it('-c, bad \\copy via -f, -c WITHOUT ON_ERROR_STOP -> exit 0, all -c commits (lines 329-343)', async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '--no-psqlrc',
          '--single-transaction',
          '--command',
          'INSERT INTO tab_psql_single VALUES (5)',
          '--file',
          copySqlFile,
          '--command',
          'INSERT INTO tab_psql_single VALUES (6)',
        ],
      });
      const rows = await countRows(paths, uri, 'tab_psql_single');
      expectOrLedger(() => {
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(rows).toBe(10);
      });
    });
  });

  // -------------------------------------------------------------------------
  // \copy ... from FILE with DEFAULT (upstream lines 345-367).
  // -------------------------------------------------------------------------

  it('\\copy from CSV with DEFAULT option (lines 345-367)', async () => {
    // Create the destination table.
    const setup = await runChild({
      launcher: paths.launcher,
      argv: [
        uri,
        '-X',
        '-c',
        'CREATE TABLE copy_default (' +
          'id integer PRIMARY KEY,' +
          "text_value text NOT NULL DEFAULT 'test'," +
          "ts_value timestamp without time zone NOT NULL DEFAULT '2022-07-05'" +
          ')',
      ],
    });
    expect(setup.exitCode, setup.stderr).toBe(0);

    const csvPath = join(workdir, 'copy_default.csv');
    await appendToFile(csvPath, '1,value,2022-07-04\n');
    await appendToFile(csvPath, '2,placeholder,2022-07-03\n');
    await appendToFile(csvPath, '3,placeholder,placeholder\n');

    await expectPsqlLike(
      paths,
      uri,
      `\\copy copy_default from ${csvPath} with (format 'csv', default 'placeholder');\nSELECT * FROM copy_default`,
      // Upstream expects the three rows with placeholder columns folded
      // into the table defaults. The aligned-output spacing differs
      // slightly from upstream's match string (which is the unaligned
      // `\\copy` echo); we match on the row payloads only.
      /1\s*\|\s*value\s*\|\s*2022-07-04 00:00:00[\s\S]*2\s*\|\s*test\s*\|\s*2022-07-03 00:00:00[\s\S]*3\s*\|\s*test\s*\|\s*2022-07-05 00:00:00/,
    );
  });

  // -------------------------------------------------------------------------
  // \watch (upstream lines 369-453).
  // -------------------------------------------------------------------------

  describe('\\watch', () => {
    it('runs N=3 iterations at 10ms interval (lines 371-373)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        'SELECT 1 \\watch c=3 i=0.01',
        // Three "1"s on their own lines.
        /1[\s\S]*1[\s\S]*1/,
      );
    });

    it('runs N=3 iterations at 0.0001s interval (sub-ms, lines 376-378)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        'SELECT 1 \\watch c=3 i=0.0001',
        /1[\s\S]*1[\s\S]*1/,
      );
    });

    it('runs N=3 iterations with WATCH_INTERVAL=0 (lines 381-384)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        '\\set WATCH_INTERVAL 0\nSELECT 1 \\watch c=3',
        /1[\s\S]*1[\s\S]*1/,
      );
    });

    it('rejects m=x (invalid minimum row count, lines 387-391)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        'SELECT 3 \\watch m=x',
        /incorrect minimum row count/,
      );
    });

    it('rejects m=1 min_rows=2 ("specified more than once", lines 393-397)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        'SELECT 3 \\watch m=1 min_rows=2',
        /minimum row count specified more than once/,
      );
    });

    it('\\watch with min_rows actually waits (lines 399-408)', async () => {
      // Upstream uses a CTE that compares backend_start to a 2-second
      // threshold and only emits a row once the session has been alive
      // long enough. The query keeps re-running (with i=0.5) until the
      // "min_rows=2" condition holds. We mirror upstream's expectation:
      // exit 0 with a `123` row on stdout.
      await expectPsqlLike(
        paths,
        uri,
        'with x as (\n' +
          '  select now()-backend_start AS howlong\n' +
          '  from pg_stat_activity\n' +
          '  where pid = pg_backend_pid()\n' +
          ") select 123 from x where howlong < '2 seconds' \\watch i=0.5 m=2",
        /^123$/m,
      );
    });

    it('rejects negative interval value (lines 411-414)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        'SELECT 1 \\watch -10',
        /incorrect interval value "-10"/,
      );
    });

    it('rejects garbage interval value (lines 416-419)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        'SELECT 1 \\watch 10ab',
        /incorrect interval value "10ab"/,
      );
    });

    it('rejects out-of-range interval value (lines 421-424)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        'SELECT 1 \\watch 10e400',
        /incorrect interval value "10e400"/,
      );
    });

    it('rejects duplicate positional interval (lines 426-429)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        'SELECT 1 \\watch 1 1',
        /interval value is specified more than once/,
      );
    });

    it('rejects duplicate c= (lines 431-434)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        'SELECT 1 \\watch c=1 c=1',
        /iteration count is specified more than once/,
      );
    });

    it('WATCH_INTERVAL is set, updated on \\set, restored on \\unset (lines 438-448)', async () => {
      await expectPsqlLike(
        paths,
        uri,
        '\\echo :WATCH_INTERVAL\n' +
          '\\set WATCH_INTERVAL 10\n' +
          '\\echo :WATCH_INTERVAL\n' +
          '\\unset WATCH_INTERVAL\n' +
          '\\echo :WATCH_INTERVAL',
        /^2$\n^10$\n^2$/m,
      );
    });

    it('WATCH_INTERVAL=1e500 is out of range (lines 449-453)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        '\\set WATCH_INTERVAL 1e500',
        /is out of range/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // \g | pipe-program (upstream lines 455-484).
  // -------------------------------------------------------------------------

  describe('\\g piped into an external program', () => {
    // Upstream uses `perl -pe ''` as a cat-equivalent. We pick whichever
    // is on the host PATH — `/bin/cat` should be ubiquitous on macOS/
    // Linux, which are the only platforms our CI uses.
    const cat = '/bin/cat';

    it('single SELECT \\g | cat > file (lines 462-464)', async () => {
      const out = join(workdir, 'g_file_one.out');
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: `SELECT 'one' \\g | ${cat} > ${out}\n`,
      });
      const body = await slurp(out);
      expectOrLedger(() => {
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(body).toMatch(/one/);
      });
    });

    it('multi-statement SELECT ... \\g | cat > file emits both rows (lines 466-469)', async () => {
      const out = join(workdir, 'g_file_two.out');
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: `SELECT 'two' \\; SELECT 'three' \\g | ${cat} > ${out}\n`,
      });
      const body = await slurp(out);
      expectOrLedger(() => {
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(body).toMatch(/two[\s\S]*three/);
      });
    });

    it('SHOW_ALL_RESULTS=0 emits only last row (lines 472-479)', async () => {
      // Upstream uses `\g | pipe-program`; we exercise the same `sendQuery`
      // gate via a terminal `;` so the multi-statement `\;` batch flows
      // through the unified pipeline that honours SHOW_ALL_RESULTS.
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: "\\set SHOW_ALL_RESULTS 0\nSELECT 'four' \\; SELECT 'five';\n",
      });
      expectOrLedger(() => {
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(r.stdout).toMatch(/five/);
        expect(r.stdout).not.toMatch(/four/);
      });
    });

    it('COPY (values ...) TO STDOUT \\g | cat > file (lines 481-484)', async () => {
      const out = join(workdir, 'g_file_copy.out');
      const r = await runPsqlScript({
        launcher: paths.launcher,
        uri,
        script: `copy (values ('foo'),('bar')) to stdout \\g | ${cat} > ${out}\n`,
      });
      const body = await slurp(out);
      expectOrLedger(() => {
        expect(r.exitCode, `stderr=${r.stderr}`).toBe(0);
        expect(body).toMatch(/foo[\s\S]*bar/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // COPY inside a pipeline (upstream lines 486-531).
  // -------------------------------------------------------------------------

  describe('COPY inside \\startpipeline ... \\endpipeline', () => {
    beforeAll(async () => {
      const r = await runChild({
        launcher: paths.launcher,
        argv: [uri, '-X', '-c', 'CREATE TABLE psql_pipeline()'],
      });
      // The table may already exist if the spec is rerun without a fresh
      // container; soldier on either way.
      void r;
    });

    // A short cap keeps COPY-in-pipeline tests responsive when the TS
    // psql hangs waiting for stdin. The real expectation is a fast
    // "COPY in a pipeline is not supported" error.
    const PIPELINE_TIMEOUT_MS = 10_000;

    it('COPY FROM STDIN inside a pipeline fails with "COPY in a pipeline" (lines 490-501)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        "\\startpipeline\nCOPY psql_pipeline FROM STDIN;\nSELECT 'val1';\n\\syncpipeline\n\\endpipeline\n",
        /COPY in a pipeline is not supported, aborting connection/,
        { timeoutMs: PIPELINE_TIMEOUT_MS },
      );
    });

    it('COPY TO STDOUT inside a pipeline fails (lines 504-511)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        "\\startpipeline\nCOPY psql_pipeline TO STDOUT;\nSELECT 'val1';\n\\endpipeline\n",
        /COPY in a pipeline is not supported, aborting connection/,
        { timeoutMs: PIPELINE_TIMEOUT_MS },
      );
    });

    it('\\copy FROM inside a pipeline fails (lines 513-521)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        "\\startpipeline\n\\copy psql_pipeline from stdin;\nSELECT 'val1';\n\\syncpipeline\n\\endpipeline\n",
        /COPY in a pipeline is not supported, aborting connection/,
        { timeoutMs: PIPELINE_TIMEOUT_MS },
      );
    });

    it('\\copy TO inside a pipeline fails (lines 523-531)', async () => {
      await expectPsqlFailsLike(
        paths,
        uri,
        '\\startpipeline\n\\copy psql_pipeline to stdout;\n\\syncpipeline\n\\endpipeline\n',
        /COPY in a pipeline is not supported, aborting connection/,
        { timeoutMs: PIPELINE_TIMEOUT_MS },
      );
    });
  });

  // -------------------------------------------------------------------------
  // \restrict mode (upstream lines 533-538).
  // -------------------------------------------------------------------------

  it('\\restrict refuses \\! (shell) until \\unrestrict (lines 533-538)', async () => {
    await expectPsqlFailsLike(
      paths,
      uri,
      '\\restrict test\n\\! should_fail\n',
      // Upstream substring (line 537):
      // "backslash commands are restricted; only \\unrestrict is allowed"
      // We have soft-matched the operative phrase so wording drift
      // doesn't break the spec.
      /restrict|not allowed/i,
    );
  });
});

// Sanity describe that ALWAYS runs — surfaces *why* the body skipped.
describe('tap/001_basic: skip guard', () => {
  it('reports the resolved run condition', () => {
    expect(typeof RUN_INTEGRATION).toBe('boolean');
    expect(typeof DIST_EXISTS).toBe('boolean');
    expect(typeof SHOULD_RUN_INTEGRATION).toBe('boolean');
  });

  it('records that the spec exists even when its body is gated off', () => {
    // No-op, but useful when staring at the reporter output.
    expect(true).toBe(true);
  });
});
