// Custom port of upstream PostgreSQL's `src/bin/psql/t/030_pager.pl`.
//
// The upstream file was renamed / removed in recent PG releases, so it is
// NOT vendored alongside the other TAP scripts under
// `tests/psql-conformance/vendor/`. We ship a custom port here that drives
// our embedded TS psql (`dist/psql/index.js` → `runPsql`) and asserts the
// pager-related env-var contract:
//
//   1. PAGER spawns the pager command when the printer asks for one.
//   2. The pager receives the rendered query output via its stdin.
//   3. `\pset pager off` suppresses the pager entirely.
//   4. PSQL_PAGER takes precedence over PAGER.
//
// IMPORTANT: This is an INTEGRATION test. It boots a real postgres (via the
// shared `pg-fixture.ts`) and spawns a Node subprocess that imports the
// built `runPsql`. It is gated by `RUN_INTEGRATION=1` so the default
// conformance run does NOT execute it. It also skips when `dist/psql/`
// does not exist — there is no auto-build step.
//
// Pager-spawn detection: the original version of this spec used content-
// based assertions (e.g. "PSQL_PAGER=cat → rows still appear on stdout"),
// which conflated "pager was invoked" with "output happened to land here".
// The current version uses BEHAVIOUR-based probes: PAGER points at a small
// shell script that writes a marker file (and the captured stdin) before
// exiting. Checking for the marker file after the run proves the pager
// actually ran, regardless of whether its stdout reached the parent.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';

import { getPgConn } from '../harness/pg-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DIST_PSQL = join(REPO_ROOT, 'dist', 'psql', 'index.js');

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const DIST_EXISTS = existsSync(DIST_PSQL);

/** Run condition: integration mode + the dist build is present. */
const SHOULD_RUN = RUN_INTEGRATION && DIST_EXISTS;

/**
 * Write a one-shot launcher that imports `runPsql` from the built dist and
 * runs it against argv. We use a launcher rather than `node -e` so the
 * code path matches what `bin/cli.js` would do, and so multi-line scripts
 * stay readable.
 *
 * The launcher exits with the runPsql exit code so the spec can assert
 * normal completion.
 */
type LauncherPaths = {
  dir: string;
  launcher: string;
};

const makeLauncher = (): LauncherPaths => {
  const dir = mkdtempSync(join(tmpdir(), 'pager-spec-'));
  const launcher = join(dir, 'launcher.mjs');
  // Resolve the runPsql module via a file:// URL so the dynamic import is
  // ESM-friendly across platforms.
  const distUrl = new URL(`file://${DIST_PSQL}`).href;
  const code = `
import { runPsql } from ${JSON.stringify(distUrl)};
const argv = process.argv.slice(2);
const code = await runPsql(argv);
process.exit(code);
`;
  writeFileSync(launcher, code, 'utf8');
  return { dir, launcher };
};

/** Build a postgres URI from the shared fixture connection. */
const buildUri = (): string => {
  const conn = getPgConn();
  const u = new URL(`postgresql://${conn.host}:${conn.port}/${conn.db}`);
  u.username = conn.user;
  u.password = conn.password;
  // Match `regress.spec.ts` — disable SSL for the local container.
  u.searchParams.set('sslmode', 'disable');
  return u.toString();
};

/**
 * Spawn the launcher with the given env, query, and PAGER settings. Returns
 * stdout / stderr / exit code. The child has no controlling TTY, so the
 * runtime pager check (`isTty`) will report false — which is why the spec
 * relies on `pager=always` to force a pager invocation.
 */
type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

const runChild = async (opts: {
  launcher: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<RunResult> => {
  return new Promise<RunResult>((resolveResult, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [opts.launcher, ...opts.argv],
      {
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child timed out after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveResult({ stdout, stderr, exitCode: code });
    });
    // Close stdin immediately — we drive the session via -c.
    child.stdin.end();
  });
};

/**
 * Build a tiny pager-probe shell script that, when invoked, writes a marker
 * file containing the captured stdin. Used by the behavioural assertions
 * below: the marker's presence after a `pager=always` run proves the pager
 * was spawned; its contents prove psql wrote the rendered rows into the
 * pager's stdin.
 */
const makeProbeScript = (dir: string, name = 'probe.sh'): string => {
  const script = join(dir, name);
  const markerPath = join(dir, `${name}.marker`);
  // shellcheck disable=SC2148 — runs under /bin/sh.
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      // Capture stdin into the marker. The marker's presence is a
      // sufficient proof of "pager was spawned"; its body proves "psql
      // piped output through it".
      `cat > "${markerPath}"`,
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return script;
};

const readMarker = (probePath: string): string | null => {
  const marker = `${probePath}.marker`;
  return existsSync(marker) ? readFileSync(marker, 'utf8') : null;
};

describe.skipIf(!SHOULD_RUN)('tap/030_pager', () => {
  let paths: LauncherPaths;
  let uri: string;

  beforeAll(() => {
    paths = makeLauncher();
    uri = buildUri();
  });

  it('runs a query via the launcher and exits cleanly (smoke test)', async () => {
    const result = await runChild({
      launcher: paths.launcher,
      argv: [uri, '-c', 'SELECT 1 AS one'],
      env: {
        ...process.env,
        PAGER: '',
        PSQL_PAGER: '',
        LC_ALL: 'C',
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/one/);
    expect(result.stdout).toMatch(/\b1\b/);
  });

  it('PAGER probe is spawned and receives query output via its stdin', async () => {
    // Behaviour-based: PAGER is a probe script that copies its stdin into
    // a marker file. After the run, the marker MUST exist AND contain the
    // rendered rows. If the wiring didn't engage, the marker file is absent
    // and the test fails.
    const probe = makeProbeScript(paths.dir, 'probe-on.sh');
    const result = await runChild({
      launcher: paths.launcher,
      argv: [
        uri,
        '-c',
        '\\pset pager always\nSELECT g FROM generate_series(1,5) g',
      ],
      env: {
        ...process.env,
        PAGER: probe,
        PSQL_PAGER: '',
        LC_ALL: 'C',
      },
    });
    expect(result.exitCode).toBe(0);
    const marker = readMarker(probe);
    // Pager spawned → marker exists.
    expect(marker).not.toBeNull();
    if (marker === null) return;
    // Pager received the rendered output → marker contains the row values.
    for (let i = 1; i <= 5; i++) {
      expect(marker).toMatch(new RegExp(`\\b${i}\\b`));
    }
  });

  it('`\\pset pager off` suppresses the pager (no marker is written)', async () => {
    // With pager explicitly off, the probe MUST NOT be invoked: the marker
    // file should be absent after the run.
    const probe = makeProbeScript(paths.dir, 'probe-off.sh');
    const result = await runChild({
      launcher: paths.launcher,
      argv: [
        uri,
        '-c',
        '\\pset pager off\nSELECT g FROM generate_series(1,5) g',
      ],
      env: {
        ...process.env,
        PAGER: probe,
        PSQL_PAGER: '',
        LC_ALL: 'C',
      },
    });
    expect(result.exitCode).toBe(0);
    expect(readMarker(probe)).toBeNull();
    // And the rows must reach stdout directly (no pager between us and them).
    expect(result.stdout).toMatch(/\b1\b/);
    expect(result.stdout).toMatch(/\b5\b/);
  });

  it('PSQL_PAGER takes precedence over PAGER', async () => {
    // Two probe scripts; only the one referenced by PSQL_PAGER should run.
    const winner = makeProbeScript(paths.dir, 'probe-win.sh');
    const loser = makeProbeScript(paths.dir, 'probe-lose.sh');
    const result = await runChild({
      launcher: paths.launcher,
      argv: [
        uri,
        '-c',
        '\\pset pager always\nSELECT g FROM generate_series(1,3) g',
      ],
      env: {
        ...process.env,
        PSQL_PAGER: winner,
        PAGER: loser,
        LC_ALL: 'C',
      },
    });
    expect(result.exitCode).toBe(0);
    // PSQL_PAGER's probe must have run …
    const winnerOut = readMarker(winner);
    expect(winnerOut).not.toBeNull();
    if (winnerOut !== null) {
      expect(winnerOut).toMatch(/\b1\b/);
    }
    // … and PAGER's probe must NOT have run.
    expect(readMarker(loser)).toBeNull();
  });
});

// Sanity assertion that the spec is wired correctly. Always runs (no skip).
describe('tap/030_pager: skip guard', () => {
  it('reports the resolved run condition', () => {
    // The spec body itself is skipped when SHOULD_RUN is false; this
    // assertion is here so a maintainer can see why in the test output.
    expect(typeof RUN_INTEGRATION).toBe('boolean');
    expect(typeof DIST_EXISTS).toBe('boolean');
  });
});
