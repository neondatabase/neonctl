/**
 * Local-command provisioner — spec §3.2 step 5 (local-command path) + §3.6.
 *
 * Spawns a child process with merged env. Honors:
 *   - stdio model: pass-through (`inherit`) when only one local-command is
 *     active in the stage (Windows SIGINT mitigation, spec §11 #21); prefixed
 *     streaming when multiple share a stage.
 *   - Readiness probes: onExit / portListening (dual-stack 127.0.0.1 + ::1,
 *     spec §11 #22) / httpGet (per-attempt timeout, overall budget) / logMatch.
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
 * `localhost` or undefined (spec §11 #22). Resolves true if either accepts.
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

async function awaitPortListening(
  port: number,
  host: string | undefined,
  budget: number,
  interval: number,
): Promise<void> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await probePort(port, host)) return;
    await sleep(interval);
  }
  throw new Error(
    `local-command readiness: port ${port} did not start listening within ${budget}ms.`,
  );
}

async function awaitHttpGet(
  url: string,
  expectedStatus: number,
  perAttemptMs: number,
  budgetMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await probeHttp(url, expectedStatus, perAttemptMs)) return;
    await sleep(intervalMs);
  }
  throw new Error(
    `local-command readiness: GET ${url} did not return ${expectedStatus} within ${budgetMs}ms.`,
  );
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
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  let ready: Promise<void>;
  if (spec.readiness === undefined) {
    // No dependents → immediately consider ready (per spec §11 #8 + §3.6).
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
      // is the mitigation (spec §11 #21).
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
      readiness.portListening,
      readiness.host,
      DEFAULT_PORT_BUDGET_MS,
      DEFAULT_PORT_POLL_INTERVAL_MS,
    );
  }
  if ('httpGet' in readiness) {
    const cfg = readiness.httpGet;
    return awaitHttpGet(
      cfg.url,
      cfg.status ?? 200,
      cfg.timeoutMs ?? DEFAULT_HTTP_PER_ATTEMPT_MS,
      DEFAULT_HTTP_BUDGET_MS,
      DEFAULT_HTTP_POLL_INTERVAL_MS,
    );
  }
  return awaitLogMatch(child, readiness.logMatch, bufs);
}
