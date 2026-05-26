/**
 * Postgres provisioner.
 *
 * Flow:
 *   1. Resolve branchFrom (explicit, or project's default branch).
 *   2. Look up by name. If found → reuse (poll for ready if creating).
 *   3. If not found → POST /projects/{id}/branches with the endpoint, poll
 *      ops (terminal: finished/skipped/cancelled; non-terminal: failed,
 *      error, running, scheduling, cancelling — Neon retries both failed
 *      AND error per the OperationStatus enum).
 *   4. Reconcile compute via PATCH /projects/{id}/endpoints/{endpoint_id}
 *      with `{ endpoint: { ... } }` wrapper.
 *   5. Build the connection-URI cache keyed on (branchId, endpointId,
 *      database, role, pooled) so multiple Ref opts-tuples each get their
 *      own resolved URI.
 */
import {
  EndpointType,
  type Api,
  type Branch,
  type Endpoint,
  type Role,
} from '@neondatabase/api-client';
import { isAxiosError } from 'axios';

import { retryOnLock } from '../../api.js';
import { log } from '../../log.js';
import type { PostgresSpec } from '../config.js';
import { branchQuotaMessage } from '../errors.js';

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_MIN_CU = 0.25;
const DEFAULT_MAX_CU = 1;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_BRANCH_TIMEOUT_S = 300;

const TERMINAL_OP_STATUSES = new Set(['finished', 'skipped', 'cancelled']);

// =============================================================================
// Types
// =============================================================================

export type PostgresProvisionResult = {
  /** The branch we attached to / created. */
  branch: Branch;
  /** The read_write endpoint on the branch. */
  endpoint: Endpoint;
  /** Stable string outputs the runner seeds its resolver with. */
  role: string;
  database: string;
};

// =============================================================================
// Helpers
// =============================================================================

type NeonApi = Api<unknown>;

async function findBranchByName(
  api: NeonApi,
  projectId: string,
  name: string,
): Promise<Branch | undefined> {
  const { data } = await retryOnLock(() =>
    api.listProjectBranches({ projectId }),
  );
  return data.branches.find((b: Branch) => b.name === name);
}

async function resolveBranchFromId(
  api: NeonApi,
  projectId: string,
  branchFrom: string | undefined,
): Promise<{ id: string; name: string }> {
  const { data } = await retryOnLock(() =>
    api.listProjectBranches({ projectId }),
  );
  if (branchFrom !== undefined) {
    const match = data.branches.find((b: Branch) => b.name === branchFrom);
    if (!match) {
      throw new Error(
        `[neon launch] branchFrom='${branchFrom}' was specified but no branch with that name exists in project ${projectId}.`,
      );
    }
    return { id: match.id, name: match.name };
  }
  // Omitted → use the project's default branch.
  const def = data.branches.find((b: Branch) => b.default);
  if (!def) {
    throw new Error(
      `[neon launch] Project ${projectId} has no default branch — cannot resolve branchFrom. Set branchFrom explicitly in your neon.ts.`,
    );
  }
  return { id: def.id, name: def.name };
}

async function pollBranchReady(
  api: NeonApi,
  projectId: string,
  branchId: string,
  timeoutSeconds: number,
): Promise<Branch> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const { data } = await retryOnLock(() =>
      api.getProjectBranch(projectId, branchId),
    );
    if (data.branch.current_state === 'ready') return data.branch;
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(
    `[neon launch] Timed out after ${timeoutSeconds}s waiting for branch ${branchId} to reach 'ready'.`,
  );
}

async function pollOpsTerminal(
  api: NeonApi,
  projectId: string,
  operationIds: string[],
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const remaining = new Set(operationIds);
  while (remaining.size > 0 && Date.now() < deadline) {
    for (const opId of [...remaining]) {
      const { data } = await retryOnLock(() =>
        api.getProjectOperation(projectId, opId),
      );
      const status = data.operation.status;
      if (TERMINAL_OP_STATUSES.has(status)) {
        remaining.delete(opId);
      }
      // `failed` and `error` are both non-terminal — Neon retries them.
      // We keep polling regardless.
    }
    if (remaining.size > 0) await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  if (remaining.size > 0) {
    throw new Error(
      `[neon launch] Timed out after ${timeoutSeconds}s waiting for Neon operations to reach terminal: ${[...remaining].join(', ')}.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findEndpoint(
  api: NeonApi,
  projectId: string,
  branchId: string,
): Promise<Endpoint | undefined> {
  const { data } = await retryOnLock(() =>
    api.listProjectBranchEndpoints(projectId, branchId),
  );
  return data.endpoints.find(
    (e: Endpoint) => e.type === EndpointType.ReadWrite,
  );
}

async function reconcileCompute(
  api: NeonApi,
  projectId: string,
  endpoint: Endpoint,
  spec: PostgresSpec,
  branchName: string,
): Promise<Endpoint> {
  const compute = spec.compute ?? {};
  const wantMin = compute.minCu ?? DEFAULT_MIN_CU;
  const wantMax = compute.maxCu ?? DEFAULT_MAX_CU;
  // Suspend-timeout sentinels: omitted / 0 → project default; -1 → never
  // suspend; positive integer → that many seconds. The project default is
  // opaque here, so we treat omitted-and-0 identically (don't drive drift,
  // don't write the field). -1 and positive values compare directly.
  const wantSuspendRaw = compute.suspendTimeoutSeconds;
  const useProjectDefault =
    wantSuspendRaw === undefined || wantSuspendRaw === 0;

  const drifts: string[] = [];
  if (endpoint.autoscaling_limit_min_cu !== wantMin)
    drifts.push(
      `minCu ${endpoint.autoscaling_limit_min_cu ?? '?'} → ${wantMin}`,
    );
  if (endpoint.autoscaling_limit_max_cu !== wantMax)
    drifts.push(
      `maxCu ${endpoint.autoscaling_limit_max_cu ?? '?'} → ${wantMax}`,
    );
  if (
    !useProjectDefault &&
    endpoint.suspend_timeout_seconds !== wantSuspendRaw
  ) {
    drifts.push(
      `suspendTimeoutSeconds ${endpoint.suspend_timeout_seconds ?? '?'} → ${wantSuspendRaw}`,
    );
  }

  if (drifts.length === 0) return endpoint;

  const body: {
    endpoint: {
      autoscaling_limit_min_cu: number;
      autoscaling_limit_max_cu: number;
      suspend_timeout_seconds?: number;
    };
  } = {
    endpoint: {
      autoscaling_limit_min_cu: wantMin,
      autoscaling_limit_max_cu: wantMax,
      ...(useProjectDefault ? {} : { suspend_timeout_seconds: wantSuspendRaw }),
    },
  };

  const { data } = await retryOnLock(() =>
    api.updateProjectEndpoint(projectId, endpoint.id, body),
  );
  log.info(`[postgres:${branchName}] compute updated: ${drifts.join(', ')}`);
  return data.endpoint;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Provision (or attach to) the Neon Postgres branch declared by `spec`.
 *
 * @param api Authenticated Neon API client.
 * @param projectId The Neon project to operate within.
 * @param spec The resolved PostgresSpec from the user's neon.ts.
 * @param branchTimeoutSeconds Per-branch poll budget (--branch-timeout flag).
 * @param resourceFqn FQN for log lines.
 */
export async function provisionPostgres(opts: {
  api: NeonApi;
  projectId: string;
  spec: PostgresSpec;
  branchTimeoutSeconds?: number;
  resourceFqn: string;
}): Promise<PostgresProvisionResult> {
  const timeoutS = opts.branchTimeoutSeconds ?? DEFAULT_BRANCH_TIMEOUT_S;
  const { api, projectId, spec, resourceFqn } = opts;

  let branch = await findBranchByName(api, projectId, spec.name);

  if (branch) {
    // Reuse — poll if still in init/creating, otherwise attach immediately.
    if (branch.current_state !== 'ready') {
      log.info(
        `[postgres:${resourceFqn}] branch '${spec.name}' is in '${branch.current_state}' state — polling.`,
      );
      branch = await pollBranchReady(api, projectId, branch.id, timeoutS);
    } else {
      log.info(
        `[postgres:${resourceFqn}] reusing existing branch '${spec.name}'.`,
      );
    }
  } else {
    // Need to create. Resolve parent.
    const parent = await resolveBranchFromId(api, projectId, spec.branchFrom);
    log.info(
      `[postgres:${resourceFqn}] creating branch '${spec.name}' forked from '${parent.name}' (${parent.id}).`,
    );

    // Suspend-timeout: omitted OR 0 → project default → omit the field.
    // -1 or positive integer → pass through verbatim.
    const sus = spec.compute?.suspendTimeoutSeconds;
    const sendSuspend = sus !== undefined && sus !== 0;
    const createBody: Parameters<Api<unknown>['createProjectBranch']>[1] = {
      branch: { name: spec.name, parent_id: parent.id },
      endpoints: [
        {
          type: EndpointType.ReadWrite,
          autoscaling_limit_min_cu: spec.compute?.minCu ?? DEFAULT_MIN_CU,
          autoscaling_limit_max_cu: spec.compute?.maxCu ?? DEFAULT_MAX_CU,
          ...(sendSuspend ? { suspend_timeout_seconds: sus } : {}),
        },
      ],
    };

    let createResp;
    try {
      createResp = await retryOnLock(() =>
        api.createProjectBranch(projectId, createBody),
      );
    } catch (err) {
      // Concurrent-create race: another launch beat us to it. Fall back to
      // listing + attaching if the branch now exists.
      if (
        isAxiosError(err) &&
        err.response &&
        err.response.status >= 400 &&
        err.response.status < 500
      ) {
        const status = err.response.status;
        const existing = await findBranchByName(api, projectId, spec.name);
        if (existing) {
          log.info(
            `[postgres:${resourceFqn}] create returned ${status} but branch now exists — attaching (concurrent-create race).`,
          );
          branch =
            existing.current_state === 'ready'
              ? existing
              : await pollBranchReady(api, projectId, existing.id, timeoutS);
        } else {
          // Quota? Check the message.
          const msg =
            (err.response.data as { message?: string } | undefined)?.message ??
            '';
          if (/branch.*limit|quota/i.test(msg)) {
            throw new Error(branchQuotaMessage({ projectId }));
          }
          throw err;
        }
      } else {
        throw err;
      }
    }

    if (!branch && createResp) {
      // Poll ops to terminal, then branch to ready.
      const opIds = createResp.data.operations.map((o: { id: string }) => o.id);
      await pollOpsTerminal(api, projectId, opIds, timeoutS);
      branch = await pollBranchReady(
        api,
        projectId,
        createResp.data.branch.id,
        timeoutS,
      );
    }
  }

  if (!branch) {
    throw new Error(
      `[neon launch] Internal error: postgres provisioner finished without a branch.`,
    );
  }

  // Get the endpoint + reconcile compute.
  let endpoint = await findEndpoint(api, projectId, branch.id);
  if (!endpoint) {
    throw new Error(
      `[neon launch] Branch ${branch.id} has no read_write endpoint. The launcher requires endpoints to be present at branch-create time.`,
    );
  }
  endpoint = await reconcileCompute(
    api,
    projectId,
    endpoint,
    spec,
    branch.name,
  );

  const role = await firstNonSystemRole(api, projectId, branch.id);
  const database = await firstNonSystemDatabase(api, projectId, branch.id);
  if (!database) {
    throw new Error(
      `[neon launch] Branch ${branch.id} has no database. Create one via \`neon databases create\` or pick a branch that has one.`,
    );
  }

  return { branch, endpoint, role, database };
}

async function firstNonSystemRole(
  api: NeonApi,
  projectId: string,
  branchId: string,
): Promise<string> {
  const { data } = await retryOnLock(() =>
    api.listProjectBranchRoles(projectId, branchId),
  );
  // `protected: true` flags platform-managed roles (e.g. superuser). The
  // launcher wants a user-owned role for the connection string; falling
  // back to the system role would silently grant app code privileges it
  // shouldn't have.
  const userRole = data.roles.find((r: Role) => !r.protected);
  if (!userRole) {
    throw new Error(
      [
        `[neon launch] Branch ${branchId} has no user-owned role.`,
        `All roles on this branch are protected (system-managed).`,
        '',
        `Create a role via \`neon roles create --name <name>\` or via the Neon console, then re-run.`,
      ].join('\n'),
    );
  }
  return userRole.name;
}

async function firstNonSystemDatabase(
  api: NeonApi,
  projectId: string,
  branchId: string,
): Promise<string | undefined> {
  const { data } = await retryOnLock(() =>
    api.listProjectBranchDatabases(projectId, branchId),
  );
  return data.databases[0]?.name;
}

/**
 * Resolve a connection URI for the given opts-tuple. The runner calls this
 * for each `db.connectionString({ pooled, role, database })` call-site
 * encountered while walking a dependent's env record. Result is cached
 * per (branchId, endpointId, database, role, pooled).
 */
export async function resolveConnectionString(opts: {
  api: NeonApi;
  projectId: string;
  branchId: string;
  endpointId: string;
  database: string;
  role: string;
  pooled?: boolean;
}): Promise<string> {
  const { data } = await retryOnLock(() =>
    opts.api.getConnectionUri({
      projectId: opts.projectId,
      branch_id: opts.branchId,
      endpoint_id: opts.endpointId,
      database_name: opts.database,
      role_name: opts.role,
      ...(opts.pooled !== undefined ? { pooled: opts.pooled } : {}),
    }),
  );
  return data.uri;
}
