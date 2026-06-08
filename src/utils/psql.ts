import { spawn } from 'child_process';

import which from 'which';

import { closeAnalytics, trackEvent } from '../analytics.js';
import { log } from '../log.js';

export type PsqlMode = 'native' | 'ts' | 'auto';

export type PsqlOpts = {
  mode?: PsqlMode;
};

const FALLBACK_ENV = 'NEONCTL_PSQL_FALLBACK';

/** Max time we wait for the analytics flush before handing off to psql. */
const ANALYTICS_FLUSH_TIMEOUT_MS = 3000;

/** Why a given psql implementation was chosen — recorded for analytics. */
type PsqlReason =
  | 'forced_flag' // --fallback / mode: 'ts' from the command
  | 'forced_env' // NEONCTL_PSQL_FALLBACK=1
  | 'forced_native' // mode: 'native' from the command
  | 'native_available' // auto + a native psql is on PATH
  | 'fallback_no_native'; // auto + no native psql → embedded TS

type PsqlPlan = {
  implementation: 'ts' | 'native';
  reason: PsqlReason;
  /** Whether a native psql was found on PATH. `null` when we didn't probe. */
  nativeAvailable: boolean | null;
  /** Resolved native binary path (only set when probed and found). */
  nativePath: string | null;
};

/**
 * Decide which psql implementation will run, and why. The PATH probe is
 * skipped when TS is forced (flag or env) — we don't need it and it'd be a
 * wasted lookup — so `nativeAvailable` is `null` ("not checked") in those
 * cases rather than a misleading `false`.
 */
const planPsql = async (opts: PsqlOpts): Promise<PsqlPlan> => {
  if (opts.mode === 'ts') {
    return {
      implementation: 'ts',
      reason: 'forced_flag',
      nativeAvailable: null,
      nativePath: null,
    };
  }
  if (process.env[FALLBACK_ENV] === '1') {
    return {
      implementation: 'ts',
      reason: 'forced_env',
      nativeAvailable: null,
      nativePath: null,
    };
  }

  const nativePath = await which('psql', { nothrow: true });
  const nativeAvailable = nativePath !== null;

  if (opts.mode === 'native') {
    return {
      implementation: 'native',
      reason: 'forced_native',
      nativeAvailable,
      nativePath,
    };
  }

  // 'auto' (or unset): strict fallback — prefer native, TS only if missing.
  return nativeAvailable
    ? {
        implementation: 'native',
        reason: 'native_available',
        nativeAvailable,
        nativePath,
      }
    : {
        implementation: 'ts',
        reason: 'fallback_no_native',
        nativeAvailable,
        nativePath,
      };
};

/**
 * Record which psql implementation is about to run, then flush analytics.
 *
 * Both exec paths below call `process.exit()`, which short-circuits the
 * main loop's `closeAnalytics()` — so without flushing here the event (and
 * any earlier queued events, e.g. `CLI Started`) would be dropped. The
 * flush is bounded by {@link ANALYTICS_FLUSH_TIMEOUT_MS} so a slow or
 * unreachable analytics endpoint can't stall the psql launch. No-ops when
 * analytics is disabled (`--analytics false`), since the client is absent.
 */
const reportPsqlInvocation = async (plan: PsqlPlan): Promise<void> => {
  trackEvent('psql_invoked', {
    implementation: plan.implementation,
    reason: plan.reason,
    nativeAvailable: plan.nativeAvailable,
  });
  await closeAnalytics({ timeout: ANALYTICS_FLUSH_TIMEOUT_MS });
};

const execNative = async (
  binary: string,
  connection_uri: string,
  args: string[],
): Promise<never> => {
  log.info('Connecting to the database using psql...');
  const child = spawn(binary, [connection_uri, ...args], {
    stdio: 'inherit',
  });

  for (const signame of ['SIGINT', 'SIGTERM']) {
    process.on(signame, (code) => {
      if (!child.killed && code !== null) {
        child.kill(code as NodeJS.Signals);
      }
    });
  }

  return new Promise<never>((_, reject) => {
    child.on('exit', (code: number | null) => {
      process.exit(code === null ? 1 : code);
    });
    child.on('error', reject);
  });
};

const execTs = async (
  connection_uri: string,
  args: string[],
): Promise<never> => {
  log.info('Connecting to the database using embedded psql (TypeScript)...');
  const { runPsql } = await import('../psql/index.js');
  const code = await runPsql([connection_uri, ...args], {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
};

export const psql = async (
  connection_uri: string,
  args: string[] = [],
  opts: PsqlOpts = {},
): Promise<never> => {
  const plan = await planPsql(opts);

  await reportPsqlInvocation(plan);

  if (plan.implementation === 'ts') {
    if (plan.reason === 'fallback_no_native') {
      log.info(
        'psql binary not found on PATH; falling back to embedded TypeScript psql',
      );
    }
    return execTs(connection_uri, args);
  }

  // implementation === 'native'
  if (plan.nativePath === null) {
    // Only reachable when native was explicitly requested (mode: 'native')
    // but no binary is on PATH.
    log.error(`psql is not available in the PATH`);
    process.exit(1);
  }
  return execNative(plan.nativePath, connection_uri, args);
};
