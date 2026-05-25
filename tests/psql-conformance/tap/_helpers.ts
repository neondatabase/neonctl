// Shared helpers for the TAP-port specs.
//
// These wrap the spawn-and-collect pattern used by every TAP spec in this
// folder. The implementation invokes a Node launcher that imports the
// built `runPsql` from `dist/psql/index.js`, so the test surface matches
// what `bin/cli.js` would do at runtime.
//
// The first TAP spec to land was `030_pager.spec.ts` which baked its
// launcher inline. The 001_basic port shares enough of the spawn / env /
// stdin choreography that the duplicated code has been promoted here.
// `030_pager.spec.ts` is kept untouched (separate WP, smaller blast
// radius); future ports should reuse this module.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPgConn, setupPg } from '../harness/pg-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
/** Path to the built TS psql entry module. */
export const DIST_PSQL = join(REPO_ROOT, 'dist', 'psql', 'index.js');

/** True when `RUN_INTEGRATION=1` is set. */
export const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';

/** True when the TS psql dist build exists at the expected path. */
export const DIST_EXISTS = existsSync(DIST_PSQL);

/** The combined "spec body actually runs" gate for TAP integration specs. */
export const SHOULD_RUN_INTEGRATION = RUN_INTEGRATION && DIST_EXISTS;

export type LauncherPaths = {
  /** A unique tmp dir owned by the spec; safe to drop artefacts in. */
  dir: string;
  /** Absolute path to the `node`-runnable launcher. */
  launcher: string;
};

/**
 * Write a one-shot launcher that imports `runPsql` from the built dist
 * and runs it against argv. The launcher exits with the runPsql exit
 * code so the spec can assert exit-code behaviour directly. Using a
 * launcher (rather than `node -e`) keeps the multi-line scripts in the
 * spec readable.
 */
export const makeLauncher = (prefix: string): LauncherPaths => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const launcher = join(dir, 'launcher.mjs');
  // file:// URL keeps the dynamic import platform-portable.
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

/**
 * Build a postgres URI from the shared fixture connection. SSL is
 * explicitly disabled so the local container does not require a cert.
 *
 * Vitest's `globalSetup` runs in the parent process; per-spec worker
 * processes inherit the populated `PGCONFORMANCE_PG_*` env vars but
 * NOT the in-process cache that `pg-fixture` keeps. `ensureFixture()`
 * re-hydrates that cache from the env vars on first use (and is
 * idempotent thereafter), so specs can use `buildUri()` directly from
 * within their `beforeAll` callback.
 */
export const ensureFixture = async (): Promise<void> => {
  // setupPg() is idempotent — returns the cached PgConn when already
  // initialised, otherwise reads the env vars set by globalSetup.
  await setupPg();
};

export const buildUri = (): string => {
  const conn = getPgConn();
  const u = new URL(`postgresql://${conn.host}:${conn.port}/${conn.db}`);
  u.username = conn.user;
  u.password = conn.password;
  u.searchParams.set('sslmode', 'disable');
  return u.toString();
};

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type RunChildOpts = {
  /** Absolute path to the launcher created via `makeLauncher`. */
  launcher: string;
  /** argv passed to the launcher (first item is normally the URI). */
  argv: string[];
  /** SQL or psql script to feed via stdin; closes stdin afterwards. */
  stdin?: string;
  /** Extra env vars merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Max ms before SIGKILL. Defaults to 30s. */
  timeoutMs?: number;
};

/**
 * Spawn the launcher with the given argv, env, and optional stdin
 * script. Captures stdout / stderr / exit code. The child has no TTY,
 * so `runPsql` sees `stdin.isTTY === false` (matches non-interactive
 * upstream psql invocations).
 */
export const runChild = (opts: RunChildOpts): Promise<RunResult> => {
  return new Promise<RunResult>((resolveResult, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LC_ALL: 'C',
      PAGER: '',
      PSQL_PAGER: '',
      ...opts.env,
    };
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [opts.launcher, ...opts.argv],
      {
        env,
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

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
};

/**
 * Convenience: run a single SQL/psql script via stdin against the live
 * fixture postgres. Returns stdout/stderr/exit. Equivalent to upstream
 * `$node->psql('postgres', $sql)`, which the PostgresNode helper drives
 * with `-XAtq` — `-X` (no .psqlrc), `-A` (unaligned), `-t` (tuples
 * only), `-q` (quiet, no "INSERT 0 N"-style noise). The unaligned +
 * tuples-only output is what the upstream regexes are written against.
 */
export const runPsqlScript = async (opts: {
  launcher: string;
  uri: string;
  script: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<RunResult> => {
  return runChild({
    launcher: opts.launcher,
    argv: [opts.uri, '-X', '-A', '-t', '-q', ...(opts.extraArgs ?? [])],
    stdin: opts.script,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
  });
};
