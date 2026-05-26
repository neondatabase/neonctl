/**
 * Runner — load plan → provision in topo order → foreground phase.
 *
 * Spec §3.2 step 6, §3.6, §9.
 *
 * Per-stage execution: nodes with no remaining unsatisfied dependencies run
 * in parallel. After a stage settles (all ready), the runner advances to
 * the next stage. Once everything is ready, we hold the parent process
 * alive as long as any `local-command` child is still running; Ctrl-C
 * SIGTERMs everyone and exits 130.
 */
import { resolve as resolvePath } from 'node:path';

import { log } from '../log.js';
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
import {
  ExitCode,
  vercelTokenMissingMessage,
  type ExitCode as ExitCodeT,
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
  yes: boolean;
  argv: Record<string, unknown>;
  recognizedFlags: ReadonlySet<string>;
};

export type LaunchRunResult = {
  exitCode: ExitCodeT;
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

  // 2. Resolve state values with spec §3.3 precedence:
  //   process.env > .neon-launch.env > .neon middleware context
  const neonLaunchEnv = readNeonLaunchEnv(repoRoot);
  const neonContext: Record<string, string | undefined> = {
    NEON_PROJECT_ID:
      (opts.argv['project-id'] as string | undefined) ?? undefined,
  };
  const projectId = resolveStateValue(
    'NEON_PROJECT_ID',
    process.env,
    neonLaunchEnv,
    neonContext,
  );
  if (!projectId) {
    throw new Error(
      `[neon launch] NEON_PROJECT_ID is required.\n` +
        `Set it in your environment, in .neon-launch.env, or pass --project-id. ` +
        `Existing \`neon\` users: \`neon set-context\` (then commit \`.neon\`) ` +
        `works too.`,
    );
  }

  // 3. Resolve Neon API auth — OAuth via argv.apiClient (set by ensureAuth)
  // or NEON_API_KEY env, in that order. apiHost flows through from the
  // global --api-host flag.
  const argvApiClient = opts.argv.apiClient as
    | ReturnType<typeof getApiClient>
    | undefined;
  const apiKey =
    (opts.argv.apiKey as string | undefined) ?? process.env.NEON_API_KEY ?? '';
  const apiHost =
    (opts.argv.apiHost as string | undefined) ??
    process.env.NEON_API_HOST ??
    undefined;
  if (!argvApiClient && !apiKey) {
    throw new Error(
      `[neon launch] Neon auth required. Run \`neon auth\` (OAuth) or set NEON_API_KEY.`,
    );
  }
  const api = argvApiClient ?? getApiClient({ apiKey, apiHost });

  // 3. Provision stage-by-stage.
  const stages = groupStages(plan);
  const liveLocalCommands: LocalCommandHandle[] = [];

  for (const [idx, stage] of stages.entries()) {
    log.info(
      `[launch] stage ${idx + 1}/${stages.length}: ${stage.map((n) => n.name).join(', ')}`,
    );
    // Decide stdio model: 'inherit' iff exactly one local-command in this
    // stage AND no other resource types share it (spec §3.6 + §11 #21).
    const localCmdCount = stage.filter(
      (n) => n.resource.__kind === 'local-command',
    ).length;
    const stdioMode: StdioMode =
      localCmdCount === 1 && stage.length === 1 ? 'inherit' : 'prefixed';

    await Promise.all(
      stage.map((node) =>
        provisionOne({
          node,
          api,
          projectId,
          repoRoot,
          cwd,
          gitBranch: ctx.gitBranch,
          branchTimeoutSeconds: opts.branchTimeoutSeconds,
          stdioMode,
          liveLocalCommands,
          neonLaunchEnv,
        }),
      ),
    );
  }

  log.info('[launch] all resources ready.');

  // 4. Foreground phase. Hold the process while any local-command runs.
  // Ctrl-C → SIGTERM all children, exit 130.
  if (liveLocalCommands.length === 0) {
    log.info('[launch] no foreground processes; exiting 0.');
    return;
  }

  await foregroundPhase(liveLocalCommands);
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
    role: (result.refTable.get('role') as string) ?? '',
    database: (result.refTable.get('database') as string) ?? '',
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
  if (!token) throw new Error(vercelTokenMissingMessage());
  // Spec §3.3 precedence: process.env > .neon-launch.env > spec.teamId.
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
  await handle.ready;
  outputs.set(args.node.resource.__id, {
    kind: 'static',
    values: {},
  });
  // Track for foreground phase if the process is still running.
  if (handle.child.exitCode === null && !handle.child.killed) {
    args.liveLocalCommands.push(handle);
  }
}

// =============================================================================
// Foreground phase
// =============================================================================

async function foregroundPhase(handles: LocalCommandHandle[]): Promise<void> {
  log.info(
    `[launch] foreground: holding for ${handles.length} local-command(s). Ctrl-C to stop.`,
  );

  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    log.info('[launch] SIGINT — stopping local commands.');
    for (const h of handles) void h.kill();
  };
  process.on('SIGINT', onSigint);

  try {
    // First-exit wins: if any local-command exits, tear down siblings.
    const firstExit = await Promise.race(handles.map((h) => h.exited));
    if (interrupted) {
      process.exit(ExitCode.SIGINT);
    }
    if (firstExit.code !== 0) {
      log.error(
        `[launch] a local-command exited with code ${firstExit.code} — stopping siblings.`,
      );
      for (const h of handles) void h.kill();
      await Promise.all(handles.map((h) => h.exited));
      process.exit(ExitCode.RESOURCE_FAILED);
    }
    // Successful exit; wait for siblings too.
    await Promise.all(handles.map((h) => h.exited));
  } finally {
    process.off('SIGINT', onSigint);
  }
}
