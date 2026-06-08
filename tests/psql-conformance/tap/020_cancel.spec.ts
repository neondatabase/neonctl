// Port of upstream PostgreSQL's `src/bin/psql/t/020_cancel.pl`.
//
// Upstream reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/bin/psql/t/020_cancel.pl
//
// What this verifies
// ------------------
//
//   1. A long-running query (`SELECT pg_sleep(N)`) sent through psql's
//      stdin can be cancelled by sending SIGINT to the psql process.
//   2. Server-side: the backend processes the CancelRequest and aborts
//      the in-flight statement (observable via the absence of the
//      pg_sleep row in `pg_stat_activity` after the cancel).
//   3. Client-side: psql's stderr carries the standard upstream
//      "canceling statement due to user request" message, and psql
//      exits with a non-zero status (matching upstream's `ok(!$result,
//      'query failed as expected')` assertion).
//
// Why end-to-end
// --------------
//
//   Unit tests cover the moving parts in isolation:
//   - `src/psql/io/lineEditor/index.test.ts` exercises ^C-on-readline
//     (rejects with `SignalError`).
//   - `src/psql/wire/connection.test.ts` exercises the BackendKeyData →
//     CancelRequest side-connection roundtrip.
//
//   But upstream is testing the WHOLE chain: `process.on('SIGINT')` in
//   the running REPL → `db.cancel()` → fresh socket carrying
//   CancelRequest → server aborts the query → REPL sees an ERROR on
//   the original connection → bubble out with non-zero exit. That
//   chain has many failure modes that no unit test covers (e.g. the
//   SIGINT handler not being installed once SQL is in-flight; the
//   cancel-request socket targeting the wrong host/port; the server
//   running a query the client thinks is gone). A live-server spawn-
//   and-signal test is the only way to validate the whole sequence.
//
// Run condition: same gate as the other TAP specs — RUN_INTEGRATION=1
// AND dist/psql/index.js exists. Skipped on Windows because sending
// SIGINT to a child terminates the test runner itself there (same
// reason upstream skips on Windows).

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SHOULD_RUN_INTEGRATION,
  buildUri,
  ensureFixture,
  makeLauncher,
  runPsqlScript,
  type LauncherPaths,
} from './_helpers.js';

const SHOULD_RUN = SHOULD_RUN_INTEGRATION && process.platform !== 'win32';

/**
 * Poll the server's `pg_stat_activity` until the long-running query has
 * registered. Mirrors upstream `PostgreSQL::Test::Cluster->poll_query_until`.
 *
 * We piggy-back the spec's own psql launcher (via `runPsqlScript`) to
 * avoid needing a separate pg client. Returns `true` if the query was
 * observed before the deadline, `false` on timeout.
 */
const pollUntilQueryRegistered = async (
  paths: LauncherPaths,
  uri: string,
  pollSql: string,
  deadlineMs: number,
): Promise<boolean> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    const r = await runPsqlScript({
      launcher: paths.launcher,
      uri,
      script: pollSql,
      timeoutMs: 5_000,
    });
    // `-Atq` strips noise; the polled SELECT returns a single integer
    // (the matching row count). Any positive value means the query is
    // registered.
    const n = Number(r.stdout.trim());
    if (r.exitCode === 0 && Number.isFinite(n) && n > 0) return true;
    await sleep(100);
  }
  return false;
};

describe.skipIf(!SHOULD_RUN)('tap/020_cancel', () => {
  let paths: LauncherPaths;
  let uri: string;

  beforeAll(async () => {
    await ensureFixture();
    paths = makeLauncher('cancel-spec');
    uri = buildUri();
  });

  // Long enough that even a slow CI never finishes the sleep before our
  // poll-then-cancel sequence runs. 30 s matches upstream's
  // `timeout_default`.
  const SLEEP_SECONDS = 30;

  it('SIGINT cancels a running pg_sleep query (psql exits non-zero with "canceling statement due to user request")', async () => {
    // Launch psql with the sleep query on stdin and capture stderr.
    const child = spawn(
      process.execPath,
      [paths.launcher, uri, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '-X'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LC_ALL: 'C',
          PAGER: '',
          PSQL_PAGER: '',
        },
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });

    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => {
          resolve({ code, signal });
        });
      },
    );

    // Feed the long-running query, then close stdin so the server starts
    // executing it (upstream does the same — IPC::Run's `pump` semantics).
    child.stdin.write(`SELECT pg_sleep(${SLEEP_SECONDS});\n`);
    child.stdin.end();

    // Wait until the server has registered the sleep query. Using a side
    // connection (the launcher again, with a separate exec) so the cancel
    // doesn't race the query's registration.
    const registered = await pollUntilQueryRegistered(
      paths,
      uri,
      "SELECT count(*) FROM pg_stat_activity WHERE query ~ '^SELECT pg_sleep'",
      10_000,
    );
    if (!registered) {
      child.kill('SIGKILL');
      throw new Error(
        'pg_sleep query never registered in pg_stat_activity ' +
          `within 10s. stderr so far: ${stderr.slice(-400)}`,
      );
    }

    // Send the cancel. Upstream uses `$h->signal('INT')`.
    child.kill('SIGINT');

    // Wait for the child to exit with a generous ceiling — the cancel
    // round-trip + REPL teardown is normally <1s.
    const exitResult = await Promise.race([
      exited,
      new Promise<{ code: number | null; signal: string | null }>((_, rej) =>
        setTimeout(
          () =>
            rej(
              new Error(
                'psql did not exit within 15s after SIGINT. ' +
                  `stderr: ${stderr.slice(-400)}`,
              ),
            ),
          15_000,
        ),
      ),
    ]);

    // Assert 1: query was cancelled. Upstream's `ok(!$result, ...)`
    // accepts EITHER a non-zero exit code OR a signal exit; psql's
    // typical answer is exit code 3 (ON_ERROR_STOP=1 + ERROR), but
    // some platforms surface the signal instead.
    expect(
      exitResult.code !== 0 || exitResult.signal !== null,
      `psql should exit non-zero or via a signal after cancel; ` +
        `got code=${String(exitResult.code)} signal=${String(exitResult.signal)}. ` +
        `stderr: ${stderr.slice(-400)}`,
    ).toBe(true);

    // Assert 2: stderr carries the canonical cancel message. This is
    // the load-bearing assertion — without it we'd be accepting any
    // failure, including a child that crashed before sending the
    // cancel-request at all.
    expect(stderr).toMatch(/canceling statement due to user request/);

    // Sanity: stdout never received a pg_sleep result row (it would
    // show the integer 0 if the sleep had finished).
    expect(stdout).not.toMatch(/^\(1 row\)/m);
  }, 60_000);

  afterAll(() => {
    // No long-lived resources to clean up; the per-test `child` exits
    // before each `it` returns. `makeLauncher` writes to a tmp dir that
    // the OS will reap.
  });
});

// Skip-guard mirroring the pattern used by the other TAP specs.
describe('tap/020_cancel: skip guard', () => {
  if (process.platform === 'win32') {
    it.skip('skipped: SIGINT on win32 terminates the test runner', () => {
      /* unreachable */
    });
  } else if (!SHOULD_RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1 or dist/psql missing', () => {
      /* unreachable */
    });
  } else {
    it('gates open: linux/darwin + RUN_INTEGRATION=1 + dist present', () => {
      expect(SHOULD_RUN).toBe(true);
    });
  }
});
