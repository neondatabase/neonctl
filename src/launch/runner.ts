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
  resolveStateValue,
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
import { ExitCode, LaunchError, vercelTokenMissingMessage } from './errors.js';
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

const outputs = new Map<string /* resource __id */, OutputResolver>();

// Module-scoped because the SIGINT handler is registered at runner entry
// but observed by foregroundPhase (which can't see the handler's closure
// variable). Reset on each runLaunch invocation.
let interrupted = false;
function isShuttingDown(): boolean {
  return interrupted;
}

async function resolveLeaf(ref: {
  __ref: string;
  __opts?: unknown;
}): Promise<string> {
  const dot = ref.__ref.lastIndexOf('.');
  if (dot < 0) {
    throw new Error(
      `[neon launch] Internal: malformed ref id (missing '.'): ${ref.__ref}`,
    );
  }
  const id = ref.__ref.slice(0, dot);
  const prop = ref.__ref.slice(dot + 1);
  const resolver = outputs.get(id);
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
      out[k] = await resolveLeaf(v);
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
 * `next dev` / `vite` shortcuts. But the child's stdout/stderr are null,
 * so logMatch readiness can never see lines. Force 'prefixed' there.
 *
 * Also force 'prefixed' when ANOTHER local-command shares the stage —
 * they'd otherwise interleave on the same TTY. Non-local-command stage
 * members (postgres, vercel-deployment) don't write to the TTY so they
 * don't count.
 */
function pickStdioMode(node: PlanNode, localCmdCount: number): StdioMode {
  if (localCmdCount !== 1) return 'prefixed';
  const spec = node.spec as { readiness?: { logMatch?: RegExp } };
  if (spec.readiness && 'logMatch' in spec.readiness) return 'prefixed';
  return 'inherit';
}

/**
 * Group the topo-ordered node list into stages: each stage contains all
 * nodes whose deps are satisfied by previous stages. Within a stage, nodes
 * run in parallel.
 */
function groupStages(plan: Plan): PlanNode[][] {
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

  // 2. Resolve state values with precedence:
  //   process.env > .neon-launch.env > .neon middleware context
  // `enrichFromContext` (src/context.ts) writes the resolved project id to
  // argv.projectId (camelCase); yargs also mirrors any --project-id flag to
  // both kebab- and camelCase. Read both so set-context users actually
  // pick up the .neon value (the error message at line 255 promises this).
  const neonLaunchEnv = readNeonLaunchEnv(repoRoot);
  const neonContext: Record<string, string | undefined> = {
    NEON_PROJECT_ID:
      (opts.argv.projectId as string | undefined) ??
      (opts.argv['project-id'] as string | undefined) ??
      undefined,
  };
  const projectId = resolveStateValue(
    'NEON_PROJECT_ID',
    process.env,
    neonLaunchEnv,
    neonContext,
  );
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

  // Register the SIGINT handler BEFORE provisioning starts. Without this,
  // Ctrl-C during a slow branch-create or Vercel deploy lets Node's default
  // SIGINT exit immediately, leaving any local-commands spawned in an
  // earlier stage as orphans (compounded by the detached-shell process
  // group on Unix). We kill them explicitly here, then exit 130. The
  // `interrupted` flag is also read by foregroundPhase so it can defer
  // to the handler's exit instead of racing it with a misleading
  // "exited with code null" error.
  interrupted = false; // reset for this invocation (module-scoped)
  outputs.clear(); // ditto — would otherwise leak refs across re-invocations
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    log.info('[launch] SIGINT — stopping any running local commands.');
    for (const h of liveLocalCommands) void h.kill();
    // Flush analytics before exit so the SIGINT event isn't dropped.
    // Tight timeout so an unreachable Segment endpoint doesn't hang
    // Ctrl-C for the SDK's ~12.5s default — at-most-once delivery is
    // acceptable on the interactive shutdown path.
    void closeAnalytics({ timeoutMs: 1_500 }).finally(() => {
      process.exit(ExitCode.SIGINT);
    });
  };
  process.on('SIGINT', onSigint);

  try {
    await provisionStages({
      stages,
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
    await foregroundPhase(liveLocalCommands);
  } finally {
    // Match the handler's lifecycle to this invocation so library-mode
    // callers don't accumulate one handler per runLaunch.
    process.off('SIGINT', onSigint);
  }
}

type StagesArgs = {
  stages: PlanNode[][];
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
    stages,
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
    const results = await Promise.allSettled(
      stage.map((node) =>
        provisionOne({
          node,
          api,
          projectId,
          repoRoot,
          cwd,
          gitBranch,
          branchTimeoutSeconds,
          stdioMode: pickStdioMode(node, localCmdCount),
          liveLocalCommands,
          neonLaunchEnv,
        }),
      ),
    );
    const firstRejection = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (firstRejection) {
      // Tear down any local-commands that came up either in this stage
      // or an earlier one. Without this they leak as orphan processes
      // (compounded by detached shells holding ports).
      await Promise.all(liveLocalCommands.map((h) => h.kill()));
      throw firstRejection.reason as Error;
    }
  }
}

// =============================================================================
// Per-resource dispatch
// =============================================================================

async function provisionOne(args: {
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
      node,
      api: args.api,
      projectId: args.projectId,
      branchTimeoutSeconds: args.branchTimeoutSeconds,
    });
    return;
  }
  if (kind === 'vercel-deployment') {
    await provisionVercelNode({
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
  outputs.set(args.node.resource.__id, {
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
  node: PlanNode;
  repoRoot: string;
  cwd: string;
  gitBranch: string;
  neonLaunchEnv: Record<string, string>;
}): Promise<void> {
  const spec = args.node.spec as VercelDeploymentSpec;
  const token = process.env.VERCEL_TOKEN ?? '';
  if (!token)
    throw new LaunchError(vercelTokenMissingMessage(), ExitCode.AUTH_MISSING);
  // Precedence: process.env > .neon-launch.env > spec.teamId.
  const teamId =
    process.env.VERCEL_TEAM_ID ??
    args.neonLaunchEnv.VERCEL_TEAM_ID ??
    spec.teamId ??
    undefined;
  const resolvedEnv = await resolveEnv(spec.env);
  const result = await provisionVercelDeployment({
    resourceFqn: args.node.name,
    spec,
    resolvedEnv,
    ctx: { token, teamId },
    gitBranch: args.gitBranch,
    repoRoot: args.repoRoot,
    cwd: args.cwd,
  });
  outputs.set(args.node.resource.__id, {
    kind: 'static',
    values: { url: result.url },
  });
  log.info(`[vercel-deployment:${args.node.name}] ready — ${result.url}`);
}

async function provisionLocalCommandNode(args: {
  node: PlanNode;
  cwd: string;
  stdioMode: StdioMode;
  liveLocalCommands: LocalCommandHandle[];
}): Promise<void> {
  const spec = args.node.spec as LocalCommandSpec;
  const resolvedEnv = await resolveEnv(spec.env);
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
    await handle.kill();
    // Splice the dead handle so the stage-level catch + later teardowns
    // don't iterate over already-killed entries (idempotent today, but
    // avoids a landmine if kill() ever grows side effects).
    const idx = args.liveLocalCommands.indexOf(handle);
    if (idx >= 0) args.liveLocalCommands.splice(idx, 1);
    throw err;
  }
  outputs.set(args.node.resource.__id, {
    kind: 'static',
    values: {},
  });
  // If the command was a one-shot that already exited, drop it from the
  // foreground-phase list so we don't try to SIGTERM a dead pid.
  if (handle.child.exitCode !== null || handle.child.killed) {
    const idx = args.liveLocalCommands.indexOf(handle);
    if (idx >= 0) args.liveLocalCommands.splice(idx, 1);
  }
}

// =============================================================================
// Foreground phase
// =============================================================================

// Caller (runLaunch) owns the SIGINT handler lifecycle: registered at
// runner entry, observed here via `isShuttingDown()`.
async function foregroundPhase(handles: LocalCommandHandle[]): Promise<void> {
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

  // Defer to the SIGINT handler ONLY when we have positive evidence the
  // parent is shutting down. Two cases:
  //   1. `isShuttingDown()` true — handler already ran (set interrupted).
  //   2. Child exited with signal 'SIGINT' AND the parent's handler is
  //      about to run (TTY Ctrl-C delivered to whole foreground group).
  //      The handler runs in the same process tick as the signal; yield
  //      with setImmediate so it has a chance to set `interrupted`, then
  //      re-check. If still not shutting down after the yield, the
  //      SIGINT was delivered only to the child (external `kill -INT
  //      <child-pid>`, debugger, etc.) — fall through and treat as a
  //      sibling crash rather than parking forever.
  // SIGTERM is never used as a deferral signal — external supervisors
  // SIGTERM children all the time and we have no business hanging the
  // parent for that.
  if (isShuttingDown()) {
    await new Promise(() => undefined);
    return;
  }
  if (firstExit.signal === 'SIGINT') {
    await new Promise((r) => setImmediate(r));
    if (isShuttingDown()) {
      await new Promise(() => undefined);
      return;
    }
    // Stray SIGINT to the child only — fall through to the crash branch.
  }
  if (firstExit.code !== 0) {
    log.error(
      `[launch] a local-command exited with code ${firstExit.code ?? 'null'} — stopping siblings.`,
    );
    for (const h of handles) void h.kill();
    await Promise.all(handles.map((h) => h.exited));
    await closeAnalytics();
    process.exit(ExitCode.RESOURCE_FAILED);
  }
  // Successful exit; wait for siblings too.
  await Promise.all(handles.map((h) => h.exited));
}
