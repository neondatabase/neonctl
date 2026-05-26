/**
 * Local-command provisioner.
 *
 * Spawns a child process with merged env. Honors:
 *   - stdio model: pass-through (`inherit`) when only one local-command is
 *     active in the stage (Windows SIGINT mitigation); prefixed streaming
 *     when multiple share a stage.
 *   - Readiness probes: onExit / portListening (dual-stack 127.0.0.1 + ::1) /
 *     httpGet (per-attempt timeout, overall budget) / logMatch.
 *   - Post-ready crash → caller (runner) decides whether to tear down siblings.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { log } from '../../log.js';
import type { LocalCommandReadiness, LocalCommandSpec } from '../config.js';

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_HTTP_PER_ATTEMPT_MS = 2_000;
const DEFAULT_HTTP_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HTTP_BUDGET_MS = 120_000;
const DEFAULT_PORT_POLL_INTERVAL_MS = 500;
const DEFAULT_PORT_BUDGET_MS = 60_000;

// =============================================================================
// Types
// =============================================================================

export type LocalCommandHandle = {
  /** Resolves when the readiness probe fires. */
  ready: Promise<void>;
  /** Resolves when the process exits (any code). */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM the child; resolves after the kill is dispatched. */
  kill: () => Promise<void>;
  /** Process handle for the runner's lifecycle bookkeeping. */
  child: ChildProcess;
};

export type StdioMode = 'inherit' | 'prefixed';

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dual-stack TCP probe — connects to BOTH 127.0.0.1 AND ::1 if `host` is
 * `localhost` or undefined. Resolves true if either accepts.
 */
async function probePort(port: number, host?: string): Promise<boolean> {
  const hosts =
    host === undefined || host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const probes = hosts.map(
    (h) =>
      new Promise<boolean>((resolve) => {
        const sock = connect({ host: h, port }, () => {
          sock.end();
          resolve(true);
        });
        sock.on('error', () => {
          resolve(false);
        });
        sock.setTimeout(500, () => {
          sock.destroy();
          resolve(false);
        });
      }),
  );
  const results = await Promise.all(probes);
  return results.some(Boolean);
}

async function probeHttp(
  url: string,
  expectedStatus: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        method: 'GET',
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        timeout: timeoutMs,
      },
      (res) => {
        resolve(res.statusCode === expectedStatus);
        res.resume();
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.end();
  });
}

// =============================================================================
// Readiness implementations
// =============================================================================

function awaitOnExit(child: ChildProcess, expectedCode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === expectedCode) resolve();
      else
        reject(
          new Error(
            `local-command exited with code ${code} (expected ${expectedCode}).`,
          ),
        );
    });
  });
}

/**
 * Wait until `predicate()` resolves truthy, with `budget` total ms and
 * `interval` ms between probes. Rejects early if `child` exits before the
 * predicate fires — a crashed child never becomes ready.
 */
async function pollUntilReady(opts: {
  child: ChildProcess;
  predicate: () => Promise<boolean>;
  budget: number;
  interval: number;
  describeFailure: () => string;
}): Promise<void> {
  const deadline = Date.now() + opts.budget;
  let childExited = false;
  let exitCode: number | null = null;
  const onExit = (code: number | null) => {
    childExited = true;
    exitCode = code;
  };
  opts.child.once('exit', onExit);
  try {
    while (Date.now() < deadline) {
      if (childExited) {
        throw new Error(
          `local-command exited (code ${exitCode}) before readiness fired. ${opts.describeFailure()}`,
        );
      }
      if (await opts.predicate()) return;
      await sleep(opts.interval);
    }
    throw new Error(opts.describeFailure());
  } finally {
    opts.child.off('exit', onExit);
  }
}

function awaitPortListening(
  child: ChildProcess,
  port: number,
  host: string | undefined,
  budget: number,
  interval: number,
): Promise<void> {
  return pollUntilReady({
    child,
    predicate: () => probePort(port, host),
    budget,
    interval,
    describeFailure: () =>
      `local-command readiness: port ${port} did not start listening within ${budget}ms.`,
  });
}

function awaitHttpGet(
  child: ChildProcess,
  url: string,
  expectedStatus: number,
  perAttemptMs: number,
  budgetMs: number,
  intervalMs: number,
): Promise<void> {
  return pollUntilReady({
    child,
    predicate: () => probeHttp(url, expectedStatus, perAttemptMs),
    budget: budgetMs,
    interval: intervalMs,
    describeFailure: () =>
      `local-command readiness: GET ${url} did not return ${expectedStatus} within ${budgetMs}ms.`,
  });
}

function awaitLogMatch(
  child: ChildProcess,
  regex: RegExp,
  attachStreams: () => { stdout: string[]; stderr: string[] },
): Promise<void> {
  // We read from buffered streams. Caller (spawn wrapper below) already
  // attached listeners that buffer; we poll the buffer.
  return new Promise((resolve, reject) => {
    let resolved = false;
    const onExit = (code: number | null) => {
      if (resolved) return;
      reject(
        new Error(
          `local-command exited (code ${code}) before logMatch ${regex} fired.`,
        ),
      );
    };
    child.once('exit', onExit);

    const tick = setInterval(() => {
      if (resolved) return;
      const { stdout, stderr } = attachStreams();
      for (const line of stdout.concat(stderr)) {
        if (regex.test(line)) {
          resolved = true;
          clearInterval(tick);
          child.off('exit', onExit);
          resolve();
          return;
        }
      }
    }, 200);
  });
}

// =============================================================================
// Spawn + monitor
// =============================================================================

/**
 * Spawn `spec.command` with the resolved env. Returns a handle the runner
 * uses to wait for readiness, watch for exit, or kill the process.
 *
 * @param stdioMode 'inherit' = pass through to the parent's TTY (best for
 *   single-active-in-stage; preserves Windows SIGINT behavior + lets the
 *   child use prompts). 'prefixed' = capture and stream lines prefixed
 *   with `[<name>]`. The runner picks based on stage occupancy.
 */
export function startLocalCommand(opts: {
  resourceFqn: string;
  spec: LocalCommandSpec;
  resolvedEnv: Record<string, string>;
  cwd?: string;
  stdioMode: StdioMode;
}): LocalCommandHandle {
  const { resourceFqn, spec, resolvedEnv, stdioMode } = opts;
  const cwd = spec.cwd ?? opts.cwd ?? process.cwd();
  const env = { ...process.env, ...resolvedEnv };

  log.info(`[${resourceFqn}] spawning: ${spec.command}`);

  const child = spawn(spec.command, {
    cwd,
    env,
    shell: true,
    stdio: stdioMode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  // Capture stream buffers for logMatch readiness (no-op when stdio:inherit).
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  if (stdioMode === 'prefixed' && child.stdout && child.stderr) {
    let stdoutTail = '';
    let stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutTail += chunk;
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) {
        stdoutBuf.push(line);
        log.info(`[${resourceFqn}] ${line}`);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderrTail += chunk;
      const lines = stderrTail.split('\n');
      stderrTail = lines.pop() ?? '';
      for (const line of lines) {
        stderrBuf.push(line);
        log.info(`[${resourceFqn}] ${line}`);
      }
    });
  }

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    let settled = false;
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
    // Surface spawn-level failures (ENOENT, EACCES, etc.) — without this
    // listener Node would crash the parent on an unhandled 'error' event
    // and `exited` would never resolve.
    child.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `[${resourceFqn}] spawn failed: ${err.message}. (Is '${spec.command.split(/\s+/)[0]}' on PATH?)`,
        ),
      );
    });
  });

  let ready: Promise<void>;
  if (spec.readiness === undefined) {
    // No dependents → immediately consider ready.
    // Plan-time invariant rejects undefined-readiness on a command with deps.
    ready = Promise.resolve();
  } else {
    ready = buildReadiness(spec.readiness, child, () => ({
      stdout: stdoutBuf,
      stderr: stderrBuf,
    }));
  }

  const kill = (): Promise<void> => {
    if (!child.killed) {
      // Windows: child.kill('SIGINT') ≈ SIGKILL (nodejs/node#35172). We still
      // emit SIGTERM uniformly; the inherit-stdio mode in single-active stages
      // is the mitigation.
      child.kill('SIGTERM');
    }
    return Promise.resolve();
  };

  return { ready, exited, kill, child };
}

function buildReadiness(
  readiness: LocalCommandReadiness,
  child: ChildProcess,
  bufs: () => { stdout: string[]; stderr: string[] },
): Promise<void> {
  if ('onExit' in readiness) {
    return awaitOnExit(child, readiness.onExit);
  }
  if ('portListening' in readiness) {
    return awaitPortListening(
      child,
      readiness.portListening,
      readiness.host,
      DEFAULT_PORT_BUDGET_MS,
      DEFAULT_PORT_POLL_INTERVAL_MS,
    );
  }
  if ('httpGet' in readiness) {
    const cfg = readiness.httpGet;
    return awaitHttpGet(
      child,
      cfg.url,
      cfg.status ?? 200,
      cfg.timeoutMs ?? DEFAULT_HTTP_PER_ATTEMPT_MS,
      DEFAULT_HTTP_BUDGET_MS,
      DEFAULT_HTTP_POLL_INTERVAL_MS,
    );
  }
  return awaitLogMatch(child, readiness.logMatch, bufs);
}
