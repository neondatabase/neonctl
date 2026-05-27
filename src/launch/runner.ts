/**
 * Runner — load plan → provision in topo order → foreground phase.
 *
 * Per-stage execution: nodes with no remaining unsatisfied dependencies run
 * in parallel. After a stage settles (all ready), the runner advances to
 * the next stage. Once everything is ready, we hold the parent process
 * alive as long as any `local-command` child is still running; Ctrl-C
 * SIGTERMs everyone and exits 130.
 */
import { resolve as resolvePath } from 'node:path';

import { log } from '../log.js';
import { closeAnalytics } from '../analytics.js';
import { getApiClient } from '../api.js';
import {
  buildLaunchContext,
  findRepoRoot,
  readNeonLaunchEnv,
} from './context.js';
import { buildPlan, type Plan, type PlanNode } from './plan.js';
import {
  provisionPostgres,
  resolveConnectionString,
  type PostgresProvisionResult,
} from './provisioners/postgres.js';
import {
  startLocalCommand,
  type LocalCommandHandle,
  type StdioMode,
} from './provisioners/local-command.js';
import { provisionVercelDeployment } from './provisioners/vercel-deployment.js';
import { isRef } from './refs.js';
import {
  ExitCode,
  LaunchError,
  resetCliShutdownInFlight,
  setCliShutdownInFlight,
  vercelTokenMissingMessage,
} from './errors.js';
import type {
  LocalCommandSpec,
  PostgresSpec,
  VercelDeploymentSpec,
} from './config.js';

// =============================================================================
// Public surface
// =============================================================================

export type LaunchRunOptions = {
  configPath: string;
  branchFlag?: string;
  branchTimeoutSeconds: number;
  argv: Record<string, unknown>;
  recognizedFlags: ReadonlySet<string>;
};

// =============================================================================
// Output-table resolution
// =============================================================================

/**
 * Per-provisioned-resource bookkeeping the runner uses to fill ref leaves.
 *
 * For postgres: `connectionString` is opts-keyed (the user can call
 * `db.connectionString({ pooled: true })` and get a NEW Ref) — the runner
 * dispatches each call-site to `resolveConnectionString` with the right
 * opts. Other postgres outputs (`host`, `role`, `database`) are stable
 * strings.
 *
 * For vercel-deployment: a single eager `url` string.
 */
type ApiClient = ReturnType<typeof getApiClient>;

type PostgresOutputResolver = {
  kind: 'postgres';
  api: ApiClient;
  projectId: string;
  branchId: string;
  endpointId: string;
  host: string;
  role: string;
  database: string;
  uriCache: Map<string, string>;
};

type StaticOutputResolver = {
  kind: 'static';
  values: Record<string, string>;
};

type OutputResolver = PostgresOutputResolver | StaticOutputResolver;

/**
 * Per-invocation mutable state. Pre-round-11 this was module-scoped,
 * which made two concurrent `runLaunch` calls (library mode) clobber
 * each other's outputs and trip each other's shutdown flag. Now each
 * invocation owns its own Runtime that's threaded through provisioners
 * and observed by foregroundPhase + the signal handlers via closure.
 */
type Runtime = {
  outputs: Map<string /* resource __id */, OutputResolver>;
  shuttingDown: { value: boolean };
};

function newRuntime(): Runtime {
  return { outputs: new Map(), shuttingDown: { value: false } };
}

/**
 * Bounded SIGTERM→SIGKILL teardown of local-command handles. Dispatches
 * SIGTERM, polls for child exits for up to `termGraceMs` (default 2s),
 * then sends SIGKILL directly to any survivors. Returns once every
 * handle has exited OR we've issued SIGKILL.
 *
 * Used from the signal handler path where the parent is about to exit
 * after a short analytics flush — `LocalCommandHandle.kill()`'s own 5s
 * SIGKILL escalation timer would never fire because the parent dies
 * first. Exporting so the integration test can hit a SIGTERM-trapping
 * child end-to-end without process-level fakery.
 */
export async function gracefulShutdown(
  handles: LocalCommandHandle[],
  termGraceMs = 2_000,
): Promise<void> {
  // Snapshot on entry: the caller's array (e.g. `liveLocalCommands`)
  // may be spliced by provisionLocalCommandNode's catch path or the
  // fast-cancel teardown while we're awaiting the grace window.
  // Mid-iteration mutation would let a handle escape the SIGKILL
  // escalation. The snapshot preserves "kill everything that was
  // live when this teardown started" semantics regardless of caller
  // bookkeeping changes.
  const snapshot = [...handles];
  if (snapshot.length === 0) return;
  for (const h of snapshot) void h.kill();
  const start = performance.now();
  const isDead = (h: LocalCommandHandle): boolean =>
    h.child.exitCode !== null || h.child.signalCode !== null;
  while (performance.now() - start < termGraceMs) {
    if (snapshot.every(isDead)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Survivors: force SIGKILL directly. Two paths:
  //   1) Detached children have their own process group; `process.kill(-pid, …)`
  //      targets the whole group (reaches grandchildren).
  //   2) Non-detached children share the parent's group; `process.kill(-pid, …)`
  //      either targets a non-existent PGID (ESRCH on Linux) or errors on
  //      Windows. We can't tell from the catch alone whether ESRCH meant
  //      "child died between checks" or "no such PGID" — so unconditionally
  //      follow up with `child.kill('SIGKILL')` against the child's own pid.
  //      Both paths idempotent on an already-dead process (ESRCH swallowed).
  for (const h of snapshot) {
    if (isDead(h)) continue;
    try {
      if (h.child.pid !== undefined) {
        process.kill(-h.child.pid, 'SIGKILL');
      }
    } catch {
      /* group kill may ESRCH on non-detached or already-gone — fine */
    }
    if (!isDead(h)) {
      try {
        h.child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Scan raw argv for the `--project-id` / `--projectId` CLI flag. We can't
 * read it off `opts.argv.projectId` because the `enrichFromContext`
 * middleware writes the `.neon` file's value into the same slot when the
 * flag wasn't passed — making CLI and middleware values indistinguishable
 * at the runner layer. The flag must have absolute precedence over env
 * vars or a stale shell `NEON_PROJECT_ID` would silently override an
 * explicit `--project-id`.
 */
export function getCliProjectIdFromArgv(argv: string[]): string | undefined {
  const nonEmpty = (v: string | undefined): string | undefined =>
    v !== undefined && v !== '' ? v : undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Honor the `--` end-of-options separator. Yargs is configured with
    // `populate--: true`, so flags after `--` are pass-through. Without
    // this stop, `neon launch -- --project-id=…` would misclassify the
    // pass-through arg as an explicit CLI flag and skip the env fallback.
    if (a === '--') return undefined;
    if (a === '--project-id' || a === '--projectId') {
      const next = argv[i + 1];
      // Skip the next arg if it starts with `--` — that's the next flag,
      // not this flag's value. Without this, `--project-id --analytics`
      // would silently use `'--analytics'` as the project id.
      if (next?.startsWith('--')) return undefined;
      return nonEmpty(next);
    }
    const eq = '=';
    if (a.startsWith(`--project-id${eq}`))
      return nonEmpty(a.slice(`--project-id${eq}`.length));
    if (a.startsWith(`--projectId${eq}`))
      return nonEmpty(a.slice(`--projectId${eq}`.length));
  }
  return undefined;
}

async function resolveLeaf(
  runtime: Runtime,
  ref: {
    __ref: string;
    __opts?: unknown;
  },
): Promise<string> {
  const dot = ref.__ref.lastIndexOf('.');
  if (dot < 0) {
    throw new Error(
      `[neon launch] Internal: malformed ref id (missing '.'): ${ref.__ref}`,
    );
  }
  const id = ref.__ref.slice(0, dot);
  const prop = ref.__ref.slice(dot + 1);
  const resolver = runtime.outputs.get(id);
  if (!resolver) {
    throw new Error(
      `[neon launch] Unresolved Ref<T>: ${ref.__ref}. ` +
        `The source resource has not been provisioned yet — likely a topo-order bug.`,
    );
  }
  if (resolver.kind === 'static') {
    const v = resolver.values[prop];
    if (v === undefined) {
      throw new Error(
        `[neon launch] Unresolved Ref<T>: ${ref.__ref}. ` +
          `Source resource has no output named '${prop}'.`,
      );
    }
    return v;
  }
  // postgres
  if (prop === 'host') return resolver.host;
  if (prop === 'role') return resolver.role;
  if (prop === 'database') return resolver.database;
  if (prop === 'connectionString') {
    const opts = (ref.__opts ?? {}) as {
      pooled?: boolean;
      role?: string;
      database?: string;
    };
    const role = opts.role ?? resolver.role;
    const database = opts.database ?? resolver.database;
    const key = `${database}|${role}|${String(opts.pooled ?? false)}`;
    const cached = resolver.uriCache.get(key);
    if (cached !== undefined) return cached;
    const uri = await resolveConnectionString({
      api: resolver.api,
      projectId: resolver.projectId,
      branchId: resolver.branchId,
      endpointId: resolver.endpointId,
      database,
      role,
      pooled: opts.pooled,
    });
    resolver.uriCache.set(key, uri);
    return uri;
  }
  throw new Error(
    `[neon launch] Unresolved Ref<T>: ${ref.__ref}. ` +
      `Postgres resources don't expose '${prop}'.`,
  );
}

/**
 * Walk `env` and replace every Ref leaf with its resolved string. Skips
 * Ref-leafs (refs as values); does not recurse into nested objects (env
 * values are always strings or refs per the type contract).
 */
async function resolveEnv(
  runtime: Runtime,
  envIn: Record<string, unknown> | undefined,
): Promise<Record<string, string>> {
  if (!envIn) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envIn)) {
    if (typeof v === 'string') {
      out[k] = v;
      continue;
    }
    if (isRef(v)) {
      out[k] = await resolveLeaf(runtime, v);
      continue;
    }
    throw new Error(
      `[neon launch] env['${k}'] is neither string nor Ref<string> (got ${typeof v}). ` +
        `Spec env values must be plain strings or output refs.`,
    );
  }
  return out;
}

// =============================================================================
// Stage grouping
// =============================================================================

/**
 * Pick the stdio mode for a local-command node.
 *
 * 'inherit' passes the parent's TTY straight through — preserves Windows
 * native SIGINT routing into child prompts, lets the user interact with
 * `next dev` / `vite` shortcuts. Constraints (any one of these falls back
 * to 'prefixed'):
 *
 *   1. The parent's stdout is not a TTY (supervisor / pipe / no terminal).
 *      In that environment, the supervisor (docker, k8s, systemd) sends
 *      SIGTERM to the parent only — not to the process group — so
 *      inherit-mode + non-detached leaves the dev-server grandchild as
 *      an orphan holding the port. Force 'prefixed' (detached) so the
 *      kill cascade reaches the group via `process.kill(-pid, ...)`.
 *      Also: no TTY means inherit's main UX win (interactive shortcuts)
 *      doesn't apply.
 *   2. logMatch readiness needs captured stdout — can't share the TTY.
 *   3. Another local-command in the same stage would interleave on the
 *      TTY — prefixed serializes line output.
 *   4. The node has dependents — downstream stage teardown will call
 *      `kill()` on this handle. In inherit mode `detached` is false to
 *      preserve TTY control, so `kill()` signals only the wrapping
 *      `sh -c` — the dev-server grandchild survives, re-parents to init,
 *      and keeps holding its port. Prefixed (detached) lets the kill
 *      cascade reach the grandchild's process group.
 *   5. ANY sibling resource is in the same stage (postgres, vercel-
 *      deployment, or another local-command). Sibling failure triggers
 *      a fast-cancel kill of every live local-command — including this
 *      one — and the same grandchild-leak in (4) applies. The only stage
 *      where inherit is safe is one where this is the ONLY node.
 *      TTY Ctrl-C still works in prefixed mode because the kernel
 *      signals the whole foreground group.
 */
export function pickStdioMode(
  node: PlanNode,
  localCmdCount: number,
  hasDependents: boolean,
  stageSize: number,
  isTty = Boolean(process.stdout.isTTY),
): StdioMode {
  if (!isTty) return 'prefixed';
  if (stageSize > 1) return 'prefixed';
  if (localCmdCount !== 1) return 'prefixed';
  const spec = node.spec as { readiness?: { logMatch?: RegExp } };
  if (spec.readiness && 'logMatch' in spec.readiness) return 'prefixed';
  if (hasDependents) return 'prefixed';
  return 'inherit';
}

/**
 * Group the topo-ordered node list into stages: each stage contains all
 * nodes whose deps are satisfied by previous stages. Within a stage, nodes
 * run in parallel.
 */
export function groupStages(plan: Plan): PlanNode[][] {
  const stages: PlanNode[][] = [];
  const done = new Set<string>();
  const remaining = new Set(plan.order);
  while (remaining.size > 0) {
    const stage: PlanNode[] = [];
    for (const fqn of remaining) {
      const node = plan.registry.get(fqn);
      if (!node) continue;
      if (node.deps.every((d) => d === '' || done.has(d))) {
        stage.push(node);
      }
    }
    if (stage.length === 0) {
      throw new Error(
        `[neon launch] Internal: stage grouping made no progress. ` +
          `Remaining: ${[...remaining].join(', ')}. (Should have been caught by cycle check.)`,
      );
    }
    for (const n of stage) {
      done.add(n.name);
      remaining.delete(n.name);
    }
    stages.push(stage);
  }
  return stages;
}

// =============================================================================
// Runner entry
// =============================================================================

export async function runLaunch(opts: LaunchRunOptions): Promise<void> {
  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const ctx = buildLaunchContext({
    argv: opts.argv,
    recognizedFlags: opts.recognizedFlags,
    branchFlag: opts.branchFlag,
    processEnv: process.env,
    cwd,
  });

  log.info(`neon launch — gitBranch=${ctx.gitBranch || '(none)'}`);

  // 1. Plan.
  const configAbs = resolvePath(cwd, opts.configPath);
  const plan = await buildPlan(configAbs, ctx);
  log.info(
    `[launch] plan: ${plan.registry.size} resources — ${[...plan.registry.values()].map((n) => `${n.name}(${n.resource.__kind})`).join(', ')}`,
  );

  // 2. Resolve project id with this precedence (highest first):
  //   --project-id CLI flag > process.env > .neon-launch.env > .neon middleware context
  //
  // The middleware `enrichFromContext` (src/context.ts) writes the .neon
  // file's projectId to argv.projectId IFF the CLI flag wasn't passed.
  // That makes argv.projectId ambiguous (CLI vs. middleware) at this
  // layer — so we scan raw process.argv to separate them. CLI explicit
  // ALWAYS wins; a stale shell `NEON_PROJECT_ID` must not silently
  // override an explicit `--project-id` (that path could destructively
  // provision against the wrong project).
  const neonLaunchEnv = readNeonLaunchEnv(repoRoot);
  const cliProjectId = getCliProjectIdFromArgv(process.argv);
  const middlewareProjectId =
    cliProjectId === undefined
      ? (opts.argv.projectId as string | undefined)
      : undefined;
  const projectId =
    cliProjectId ??
    process.env.NEON_PROJECT_ID ??
    neonLaunchEnv.NEON_PROJECT_ID ??
    middlewareProjectId;
  if (!projectId) {
    throw new LaunchError(
      [
        `[neon launch] NEON_PROJECT_ID is required.`,
        `Set it in your environment, in .neon-launch.env, or pass --project-id.`,
        `Existing \`neon\` users: \`neon set-context\` (then commit \`.neon\`) works too.`,
      ].join('\n'),
      ExitCode.CONFIG_ERROR,
    );
  }

  // 3. Resolve Neon API auth — OAuth via argv.apiClient (set by ensureAuth)
  // or NEON_API_KEY env, in that order. apiHost flows through from the
  // global --api-host flag.
  // The yargs builder in `src/index.ts` defaults `apiClient` to `null`
  // (cast at the boundary); after `ensureAuth` middleware runs it gets
  // the real client. Normalize to
  // undefined so the `??` chain and the `!argvApiClient` check below
  // behave consistently.
  const argvApiClient =
    (opts.argv.apiClient as
      | ReturnType<typeof getApiClient>
      | null
      | undefined) ?? undefined;
  const apiKey =
    (opts.argv.apiKey as string | undefined) ?? process.env.NEON_API_KEY ?? '';
  const apiHost =
    (opts.argv.apiHost as string | undefined) ??
    process.env.NEON_API_HOST ??
    undefined;
  if (!argvApiClient && !apiKey) {
    throw new LaunchError(
      `[neon launch] Neon auth required. Run \`neon auth\` (OAuth) or set NEON_API_KEY.`,
      ExitCode.AUTH_MISSING,
    );
  }
  const api = argvApiClient ?? getApiClient({ apiKey, apiHost });

  // 4. Provision stage-by-stage.
  const stages = groupStages(plan);
  const liveLocalCommands: LocalCommandHandle[] = [];

  // Register shutdown handlers before STAGE 1 provisioning starts.
  // Signals received during plan loading or auth resolution (the steps
  // above this line) take Node's default action; that's fine because
  // no children are spawned yet — there's nothing to leak. Signals
  // received once provisioning is in flight kill any local-commands
  // spawned in an earlier stage (which would otherwise become orphans,
  // compounded by the detached-shell process group on Unix), then exit
  // with the signal's conventional code. The `interrupted` flag is
  // also read by foregroundPhase so it can defer to the handler's
  // exit instead of racing it with a misleading "exited with code
  // null" error.
  //
  // Both SIGINT (interactive Ctrl-C) and SIGTERM (process supervisors:
  // systemd, k8s, docker stop, pm2, ...) are handled. A second signal
  // of the SAME kind during the analytics-flush window short-circuits
  // to immediate process.exit so the user can force-quit if Segment
  // wedges.
  const runtime = newRuntime();
  const makeShutdownHandler = (
    signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP',
    code: number,
  ) => {
    return () => {
      if (runtime.shuttingDown.value) {
        // Second signal arrived during cleanup — user wants out NOW.
        log.info(`[launch] ${signal} again — force-exiting.`);
        process.exit(code);
        return;
      }
      runtime.shuttingDown.value = true;
      setCliShutdownInFlight();
      log.info(`[launch] ${signal} — stopping any running local commands.`);
      // Tight SIGTERM-grace before SIGKILL: `h.kill()` schedules its own
      // 5s SIGKILL escalation, but the analytics flush below force-exits
      // the parent at ~1.5s — without explicit escalation here, a
      // SIGTERM-trapping child outlives the parent and orphans on init.
      // The grace is bounded so a misbehaving child can't deadlock Ctrl-C.
      void gracefulShutdown(liveLocalCommands)
        .then(() => closeAnalytics({ timeoutMs: 1_500 }))
        .finally(() => {
          process.exit(code);
        });
    };
  };
  const onSigint = makeShutdownHandler('SIGINT', ExitCode.SIGINT);
  const onSigterm = makeShutdownHandler('SIGTERM', ExitCode.SIGTERM);
  // SIGHUP: terminal close, ssh disconnect, parent shell exit. Node's
  // default action for SIGHUP is process termination — handlers don't
  // run unless we install one. Without this, detached children (their
  // own process group, so the kernel's SIGHUP-to-foreground-group
  // doesn't reach them) re-parent to init and keep holding ports.
  const onSighup = makeShutdownHandler('SIGHUP', ExitCode.SIGHUP);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);

  // Build a "this resource has at least one dependent" lookup. stdio
  // mode reads it: a node with dependents can be torn down by an
  // explicit kill (sibling failure, stage teardown) rather than by TTY
  // Ctrl-C — and the kill cascade only reaches grandchildren when we
  // detach (i.e. prefixed mode). Terminal nodes (no dependents) keep
  // 'inherit' so the user can interact with `next dev` / `vite`.
  const dependedOnFqns = new Set<string>();
  for (const node of plan.registry.values()) {
    for (const dep of node.deps) {
      if (dep !== '') dependedOnFqns.add(dep);
    }
  }

  try {
    await provisionStages({
      runtime,
      stages,
      dependedOnFqns,
      api,
      projectId,
      repoRoot,
      cwd,
      gitBranch: ctx.gitBranch,
      branchTimeoutSeconds: opts.branchTimeoutSeconds,
      liveLocalCommands,
      neonLaunchEnv,
    });

    log.info('[launch] all resources ready.');

    // 5. Foreground phase. Hold the process while any local-command runs.
    // Ctrl-C → SIGTERM all children, exit 130.
    if (liveLocalCommands.length === 0) {
      log.info('[launch] no foreground processes; exiting 0.');
      return;
    }
    await foregroundPhase(runtime, liveLocalCommands);
  } finally {
    // Match the handlers' lifecycle to this invocation so library-mode
    // callers don't accumulate one handler per runLaunch.
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('SIGHUP', onSighup);
    // Reset the CLI shutdown latch ONLY when this invocation didn't
    // initiate the shutdown. Resetting unconditionally here defeats
    // the latch's purpose: the rejected promise from our killed
    // children reaches commands/launch.ts BEFORE the signal handler
    // exits the process, and the CLI catch reads `isCliShutdownInFlight()`
    // — if we've already reset it, the catch races the handler with
    // its own closeAnalytics+process.exit and the wrong exit code wins.
    // Library mode still gets a clean reset on normal completion.
    if (!runtime.shuttingDown.value) resetCliShutdownInFlight();
  }
}

type StagesArgs = {
  runtime: Runtime;
  stages: PlanNode[][];
  /** FQNs of every node that some other node lists in `dependsOn`. */
  dependedOnFqns: Set<string>;
  api: ApiClient;
  projectId: string;
  repoRoot: string;
  cwd: string;
  gitBranch: string;
  branchTimeoutSeconds: number;
  liveLocalCommands: LocalCommandHandle[];
  neonLaunchEnv: Record<string, string>;
};

async function provisionStages(args: StagesArgs): Promise<void> {
  const {
    runtime,
    stages,
    dependedOnFqns,
    api,
    projectId,
    repoRoot,
    cwd,
    gitBranch,
    branchTimeoutSeconds,
    liveLocalCommands,
    neonLaunchEnv,
  } = args;
  for (const [idx, stage] of stages.entries()) {
    // SIGINT/SIGTERM may have fired between stages. The handler kills
    // any already-spawned local-commands and schedules process.exit
    // after the analytics flush, but it can't reach into this loop —
    // without this guard we'd spawn the next stage's local-commands
    // (including DB migrations) during the 1.5s flush window. Throw
    // a sentinel so the surrounding allSettled drains cleanly and
    // the user-visible exit comes from the signal handler.
    if (runtime.shuttingDown.value) {
      throw new LaunchError(
        '[neon launch] shutdown signal received before stage start — aborting before any further work.',
        ExitCode.SIGINT,
      );
    }
    log.info(
      `[launch] stage ${idx + 1}/${stages.length}: ${stage.map((n) => n.name).join(', ')}`,
    );
    const localCmdCount = stage.filter(
      (n) => n.resource.__kind === 'local-command',
    ).length;

    // Provisioning siblings in parallel: when one rejects, we kill the
    // rest — which makes their `await handle.ready` reject too. Use
    // allSettled so those secondary rejections are observed (not left
    // dangling for Node to surface as 'unhandled promise rejection'
    // racing the user-facing error in commands/launch.ts).
    const tasks = stage.map((node) =>
      provisionOne({
        runtime,
        node,
        api,
        projectId,
        repoRoot,
        cwd,
        gitBranch,
        branchTimeoutSeconds,
        stdioMode: pickStdioMode(
          node,
          localCmdCount,
          dependedOnFqns.has(node.name),
          stage.length,
        ),
        liveLocalCommands,
        neonLaunchEnv,
      }),
    );

    // Fast-cancel: on the FIRST rejection, immediately kill any local
    // commands already running. Their `handle.ready` rejects via the
    // child-exit pathway, which unblocks their provisioner — siblings
    // settle quickly instead of waiting out their own readiness budget
    // (5min logMatch / 2min httpGet / 60s portListening). Postgres and
    // Vercel polls keep their own clocks; their typical durations are
    // short enough to not be worth a deeper signal-threading refactor.
    let firstReject: { reason: unknown } | undefined;
    for (const t of tasks) {
      t.catch((err: unknown) => {
        if (firstReject !== undefined) return;
        firstReject = { reason: err };
        for (const h of liveLocalCommands) void h.kill();
      });
    }
    // Still await allSettled so the late-rejection promises are observed
    // (not left dangling for Node to surface as 'unhandled promise
    // rejection' racing the user-facing error in commands/launch.ts).
    await Promise.allSettled(tasks);
    if (firstReject !== undefined) {
      // Bounded SIGTERM→SIGKILL teardown — same discipline as the
      // signal handler + foregroundPhase crash. Naked h.kill() schedules
      // its in-handle 5s SIGKILL escalation, but the parent's CLI catch
      // calls closeAnalytics with default ~12.5s timeout, and a fast
      // analytics flush would let the parent exit before the in-handle
      // timer fires — leaking SIGTERM-trapping grandchildren.
      await gracefulShutdown(liveLocalCommands);
      throw firstReject.reason as Error;
    }
  }
}

// =============================================================================
// Per-resource dispatch
// =============================================================================

async function provisionOne(args: {
  runtime: Runtime;
  node: PlanNode;
  api: ApiClient;
  projectId: string;
  repoRoot: string;
  cwd: string;
  gitBranch: string;
  branchTimeoutSeconds: number;
  stdioMode: StdioMode;
  liveLocalCommands: LocalCommandHandle[];
  neonLaunchEnv: Record<string, string>;
}): Promise<void> {
  const { node } = args;
  const kind = node.resource.__kind;

  if (kind === 'postgres') {
    await provisionPostgresNode({
      runtime: args.runtime,
      node,
      api: args.api,
      projectId: args.projectId,
      branchTimeoutSeconds: args.branchTimeoutSeconds,
    });
    return;
  }
  if (kind === 'vercel-deployment') {
    await provisionVercelNode({
      runtime: args.runtime,
      node,
      repoRoot: args.repoRoot,
      cwd: args.cwd,
      gitBranch: args.gitBranch,
      neonLaunchEnv: args.neonLaunchEnv,
    });
    return;
  }
  if (kind === 'local-command') {
    await provisionLocalCommandNode({
      runtime: args.runtime,
      node,
      cwd: args.cwd,
      stdioMode: args.stdioMode,
      liveLocalCommands: args.liveLocalCommands,
    });
    return;
  }
  // stack nodes are pure grouping — plan.ts has already resolved them.
  throw new Error(
    `[neon launch] Internal: unexpected resource kind '${kind}' in topo order.`,
  );
}

async function provisionPostgresNode(args: {
  runtime: Runtime;
  node: PlanNode;
  api: ApiClient;
  projectId: string;
  branchTimeoutSeconds: number;
}): Promise<PostgresProvisionResult> {
  const spec = args.node.spec as PostgresSpec;
  const result = await provisionPostgres({
    api: args.api,
    projectId: args.projectId,
    spec,
    branchTimeoutSeconds: args.branchTimeoutSeconds,
    resourceFqn: args.node.name,
  });
  // Seed the output table for this resource so downstream refs resolve.
  args.runtime.outputs.set(args.node.resource.__id, {
    kind: 'postgres',
    api: args.api,
    projectId: args.projectId,
    branchId: result.branch.id,
    endpointId: result.endpoint.id,
    host: result.endpoint.host,
    role: result.role,
    database: result.database,
    uriCache: new Map(),
  });
  log.info(`[postgres:${args.node.name}] ready — host=${result.endpoint.host}`);
  return result;
}

async function provisionVercelNode(args: {
  runtime: Runtime;
  node: PlanNode;
  repoRoot: string;
  cwd: string;
  gitBranch: string;
  neonLaunchEnv: Record<string, string>;
}): Promise<void> {
  const spec = args.node.spec as VercelDeploymentSpec;
  const token = process.env.VERCEL_TOKEN ?? '';
  if (!token)
    throw new LaunchError(
      vercelTokenMissingMessage({ resourceFqn: args.node.name }),
      ExitCode.AUTH_MISSING,
    );
  // Precedence: spec.teamId (explicit user intent) > process.env >
  // .neon-launch.env. If the user types a `teamId: 'team_xyz'` into
  // their neon.ts that disagrees with a cached `VERCEL_TEAM_ID`, the
  // explicit spec wins — silently deploying to the cached team instead
  // would be cross-team corruption. The cache exists to skip slug
  // resolution for `spec.team`, not to override explicit ids. (If the
  // user uses `spec.team` for slug-based addressing, `provisionVercelDeployment`
  // resolves the slug fresh when neither this `teamId` nor a cached
  // `VERCEL_TEAM_ID` is present.)
  const teamId =
    spec.teamId ??
    process.env.VERCEL_TEAM_ID ??
    args.neonLaunchEnv.VERCEL_TEAM_ID ??
    undefined;
  // Cached project id/name from a previous run let us skip the
  // `/v9/projects/{idOrName}` lookup. Same env > .neon-launch.env order.
  const cachedProjectId =
    process.env.VERCEL_PROJECT_ID ?? args.neonLaunchEnv.VERCEL_PROJECT_ID;
  const cachedProjectName =
    process.env.VERCEL_PROJECT_NAME ?? args.neonLaunchEnv.VERCEL_PROJECT_NAME;
  const cachedTeamSlug = args.neonLaunchEnv.VERCEL_TEAM_SLUG;
  const resolvedEnv = await resolveEnv(args.runtime, spec.env);
  const result = await provisionVercelDeployment({
    resourceFqn: args.node.name,
    spec,
    resolvedEnv,
    ctx: { token, teamId },
    gitBranch: args.gitBranch,
    repoRoot: args.repoRoot,
    cwd: args.cwd,
    cachedProjectId,
    cachedProjectName,
    cachedTeamSlug,
  });
  args.runtime.outputs.set(args.node.resource.__id, {
    kind: 'static',
    values: { url: result.url },
  });
  log.info(`[vercel-deployment:${args.node.name}] ready — ${result.url}`);
}

export async function provisionLocalCommandNode(args: {
  runtime: Runtime;
  node: PlanNode;
  cwd: string;
  stdioMode: StdioMode;
  liveLocalCommands: LocalCommandHandle[];
}): Promise<void> {
  const spec = args.node.spec as LocalCommandSpec;
  // Spawn-after-signal race: if SIGINT arrived while we were waiting
  // on dependencies, the shutdown handler already iterated
  // liveLocalCommands and walked away. Spawning now would leak the
  // child — gracefulShutdown won't see it. Refuse to spawn instead.
  if (args.runtime.shuttingDown.value) {
    throw new LaunchError(
      `local-command '${args.node.name}': shutdown in flight; refusing to spawn`,
      ExitCode.SIGINT,
    );
  }
  const resolvedEnv = await resolveEnv(args.runtime, spec.env);
  const handle = startLocalCommand({
    resourceFqn: args.node.name,
    spec,
    resolvedEnv,
    cwd: args.cwd,
    stdioMode: args.stdioMode,
  });
  // Track BEFORE awaiting readiness so a stage-level catch can tear it
  // down if a sibling fails; also kill ourselves if our own readiness
  // throws (timeout, child exited with the wrong code, etc.) — otherwise
  // the spawned shell + grandchildren leak.
  args.liveLocalCommands.push(handle);
  try {
    await handle.ready;
  } catch (err) {
    // Bounded SIGTERM→SIGKILL teardown instead of naked kill(): a
    // SIGTERM-trapping child's in-handle 5s SIGKILL escalation timer
    // would be killed by the parent's process.exit (after at most ~1.5s
    // analytics flush) BEFORE escalating — orphaning the grandchild.
    // gracefulShutdown caps at 2s and force-SIGKILLs survivors directly.
    await gracefulShutdown([handle]);
    // Splice the dead handle so the stage-level catch + later teardowns
    // don't iterate over already-killed entries.
    const idx = args.liveLocalCommands.indexOf(handle);
    if (idx >= 0) args.liveLocalCommands.splice(idx, 1);
    throw err;
  }
  // Detect a one-shot vs a still-running dependent.
  //
  // `onExit:N` readiness IS the exit signal — when ready resolves the
  // child is gone by construction. Drop the handle so the
  // foreground-phase doesn't try to SIGTERM a dead pid.
  //
  // For OTHER readiness modes (portListening / httpGet / logMatch) an
  // already-exited child after ready resolves means the child died
  // BETWEEN the readiness probe firing and us reaching this line — a
  // post-readiness crash that should fail the whole launch, not be
  // silently swallowed by treating the dead child as "ready and one-
  // shot." Throw with the exit info so the runner's per-task catch in
  // provisionStages can tear down siblings.
  const isOnExitReadiness =
    spec.readiness !== undefined &&
    typeof spec.readiness === 'object' &&
    spec.readiness !== null &&
    'onExit' in spec.readiness;
  // Race the child's exit event against a short delay so a child that
  // dies right after readiness fires (e.g. logMatch matched on the
  // final stdout line before the OS reaped the process) is detected
  // deterministically. Without this race, the `exitCode` check below
  // is event-loop-scheduling-dependent: sometimes the exit event has
  // landed, sometimes not. 200ms is enough for a real exit to surface
  // and small enough to not noticeably slow launch.
  const POST_READINESS_PROBE_MS = 200;
  await Promise.race([
    handle.exited.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((r) => setTimeout(r, POST_READINESS_PROBE_MS)),
  ]);
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    const idx = args.liveLocalCommands.indexOf(handle);
    if (idx >= 0) args.liveLocalCommands.splice(idx, 1);
    if (!isOnExitReadiness) {
      throw new Error(
        `[neon launch] local-command '${args.node.name}' exited (code ${handle.child.exitCode}, signal ${handle.child.signalCode}) immediately after readiness fired — dependents would race a dead resource. Treating as a crash.`,
      );
    }
  }
  args.runtime.outputs.set(args.node.resource.__id, {
    kind: 'static',
    values: {},
  });
}

// =============================================================================
// Foreground phase
// =============================================================================

// Caller (runLaunch) owns the SIGINT handler lifecycle: registered at
// runner entry, observed here via `isShuttingDown()`.
async function foregroundPhase(
  runtime: Runtime,
  handles: LocalCommandHandle[],
): Promise<void> {
  log.info(
    `[launch] foreground: holding for ${handles.length} local-command(s). Ctrl-C to stop.`,
  );

  // If the FIRST handle to exit failed, tear down siblings and surface
  // the failure. If it exited cleanly, await the others — but we don't
  // re-check their codes (so a sibling crashing AFTER a clean first-exit
  // is silently swallowed). This is fine for v1 because typical configs
  // have one long-running foreground command (a dev server) plus
  // `onExit:0` one-shots that are filtered out of `handles` before we
  // get here. Multi-long-running configs are out of v1 scope; revisit
  // by racing the first NON-ZERO exit if that pattern lands.
  const firstExit = await Promise.race(handles.map((h) => h.exited));

  // Defer to the shutdown handlers ONLY when we have positive evidence
  // the parent is shutting down. Two cases:
  //   1. `isShuttingDown()` true — handler already ran (set interrupted).
  //   2. Child exited with signal 'SIGINT' or 'SIGTERM' AND the parent's
  //      handler is about to run (TTY Ctrl-C / supervisor SIGTERM
  //      delivered to whole foreground group). The handler runs in the
  //      same process tick as the signal; yield with setImmediate so
  //      it has a chance to set `interrupted`, then re-check. If still
  //      not shutting down after the yield, the signal was delivered
  //      only to the child (external `kill -INT/-TERM <child-pid>`,
  //      debugger, etc.) — fall through and treat as a sibling crash
  //      rather than parking forever.
  if (runtime.shuttingDown.value) {
    await new Promise(() => undefined);
    return;
  }
  if (firstExit.signal === 'SIGINT' || firstExit.signal === 'SIGTERM') {
    await new Promise((r) => setImmediate(r));
    if (runtime.shuttingDown.value) {
      await new Promise(() => undefined);
      return;
    }
    // Stray signal to the child only — fall through to the crash branch.
  }
  if (firstExit.code !== 0) {
    log.error(
      `[launch] a local-command exited with code=${firstExit.code ?? 'null'} signal=${firstExit.signal ?? 'none'} — stopping siblings.`,
    );
    // Use the same bounded teardown as the signal handler — naked
    // h.kill() leaves the in-handle SIGKILL escalation at 5s while
    // closeAnalytics defaults to ~12.5s, producing a 17s "wedged"
    // window for SIGTERM-trapping siblings. gracefulShutdown caps
    // the wait at 2s and force-SIGKILLs survivors directly.
    await gracefulShutdown(handles);
    // Throw rather than process.exit so library callers (per the
    // header comment's per-invocation-runtime contract) can catch.
    // The CLI catch in commands/launch.ts handles the exit + flush.
    throw new LaunchError(
      `[neon launch] local-command exited with code=${firstExit.code ?? 'null'} signal=${firstExit.signal ?? 'none'}`,
      ExitCode.RESOURCE_FAILED,
    );
  }
  // Successful exit; wait for siblings too — allSettled so a late
  // spawn-layer rejection doesn't take down the success path.
  await Promise.allSettled(handles.map((h) => h.exited));
}
