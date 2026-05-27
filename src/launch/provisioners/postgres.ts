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
import { ExitCode, LaunchError, branchQuotaMessage } from '../errors.js';

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_MIN_CU = 0.25;
const DEFAULT_MAX_CU = 1;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_BRANCH_TIMEOUT_S = 300;

const TERMINAL_OP_STATUSES = new Set(['finished', 'skipped', 'cancelled']);

// 5xx retry budget for the branch-create POST. `retryOnLock` covers 423
// (resource locked) but not transient 5xx — exponential backoff with a
// small cap is safer than letting a single Neon hiccup fail the launch.
const FIVE_XX_RETRY_ATTEMPTS = 3;
const FIVE_XX_BASE_DELAY_MS = 500;

// Network-level transient codes that warrant retry alongside HTTP 5xx.
// Common in CI under NAT idle-eviction or DNS flake — without this
// retry a single mid-poll ECONNRESET fails an otherwise-successful
// 5-minute branch-create.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

async function with5xxRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined;
      const httpTransient =
        status !== undefined && status >= 500 && status < 600;
      // axios `err.code` is set for transport-level failures (no response
      // received). `err.response === undefined` is the discriminator that
      // distinguishes "got 5xx" from "got nothing back."
      const errCode = isAxiosError(err) ? err.code : undefined;
      const networkTransient =
        isAxiosError(err) &&
        err.response === undefined &&
        errCode !== undefined &&
        TRANSIENT_NETWORK_CODES.has(errCode);
      const transient = httpTransient || networkTransient;
      attempt += 1;
      if (!transient || attempt >= FIVE_XX_RETRY_ATTEMPTS) throw err;
      const delay = FIVE_XX_BASE_DELAY_MS * 2 ** (attempt - 1);
      log.info(
        `[postgres] retrying after ${status ?? errCode ?? 'transport error'} (attempt ${attempt}/${FIVE_XX_RETRY_ATTEMPTS - 1}, ${delay}ms)`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Compose retryOnLock (423) + with5xxRetry. All Neon API calls in this
 * provisioner go through here so transient outages and lock contention
 * are handled consistently — a single 502 from the read path shouldn't
 * fail a 5-minute branch-create poll.
 */
function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  return with5xxRetry(() => retryOnLock(fn));
}

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

/**
 * Find a branch by exact name. Uses the server-side `search` filter so we
 * don't miss matches that fall off the first page on large projects, then
 * narrows to exact-equal in code (search is substring-match per the API).
 */
async function findBranchByName(
  api: NeonApi,
  projectId: string,
  name: string,
): Promise<Branch | undefined> {
  for await (const branch of iterateBranches(api, projectId, name)) {
    if (branch.name === name) return branch;
  }
  return undefined;
}

/**
 * Resolve the parent branch for a new fork. Explicit `branchFrom` uses the
 * search-by-name path; omitted falls back to the project's default branch
 * (paginated since the default may be older than the first page's window).
 */
async function resolveBranchFromId(
  api: NeonApi,
  projectId: string,
  branchFrom: string | undefined,
): Promise<{ id: string; name: string }> {
  if (branchFrom !== undefined) {
    const match = await findBranchByName(api, projectId, branchFrom);
    if (!match) {
      throw new LaunchError(
        `[neon launch] branchFrom='${branchFrom}' was specified but no branch with that name exists in project ${projectId}.`,
        ExitCode.CONFIG_ERROR,
      );
    }
    return { id: match.id, name: match.name };
  }
  for await (const branch of iterateBranches(api, projectId)) {
    if (branch.default) return { id: branch.id, name: branch.name };
  }
  throw new LaunchError(
    `[neon launch] Project ${projectId} has no default branch — cannot resolve branchFrom. Set branchFrom explicitly in your neon.ts.`,
    ExitCode.CONFIG_ERROR,
  );
}

/**
 * Iterate every branch in the project, following the cursor pagination
 * cursor until exhausted. Optional `search` narrows server-side.
 */
async function* iterateBranches(
  api: NeonApi,
  projectId: string,
  search?: string,
): AsyncGenerator<Branch> {
  let cursor: string | undefined;
  while (true) {
    const { data } = await withRetries(() =>
      api.listProjectBranches({
        projectId,
        ...(search !== undefined ? { search } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    for (const b of data.branches as Branch[]) yield b;
    const next = data.pagination?.next;
    if (!next) return;
    cursor = next;
  }
}

async function pollBranchReady(
  api: NeonApi,
  projectId: string,
  branchId: string,
  timeoutSeconds: number,
): Promise<Branch> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const { data } = await withRetries(() =>
      api.getProjectBranch(projectId, branchId),
    );
    if (data.branch.current_state === 'ready') return data.branch;
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(
    `[neon launch] Timed out after ${timeoutSeconds}s waiting for branch ${branchId} to reach 'ready'.`,
  );
}

export async function pollOpsTerminal(
  api: NeonApi,
  projectId: string,
  operationIds: string[],
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const remaining = new Set(operationIds);
  // Keep the last-seen diagnostic per op so a final timeout can surface
  // Neon's actual error instead of just the op id. `failed`/`error` are
  // non-terminal — Neon retries internally — but `op.error` and
  // `op.failures_count` accumulate on every poll, and the SDK exposes
  // `retry_at` as "last retried at" (past tense), so we can't tell from
  // one snapshot whether more retries are coming. We trust the
  // `--branch-timeout` budget, but at least preserve the diagnostic.
  const lastSeen = new Map<
    string,
    { error?: string; failures: number; status: string }
  >();
  // failures_count ceiling: Neon retries internally, but an op stuck
  // at N retries for the full timeout-window is wedged. Bail at this
  // threshold with the latest diagnostic so the user sees the cause
  // in seconds rather than minutes.
  const FAILURES_CEILING = 5;
  while (remaining.size > 0 && Date.now() < deadline) {
    for (const opId of [...remaining]) {
      const { data } = await withRetries(() =>
        api.getProjectOperation(projectId, opId),
      );
      const op = data.operation;
      if (op.error || op.failures_count > 0) {
        lastSeen.set(opId, {
          error: op.error,
          failures: op.failures_count,
          status: op.status,
        });
      }
      if (TERMINAL_OP_STATUSES.has(op.status)) {
        remaining.delete(opId);
      } else if (op.failures_count >= FAILURES_CEILING) {
        throw new Error(
          `[neon launch] Neon operation ${opId} wedged after ${op.failures_count} internal retries ` +
            `(status=${op.status}, error=${op.error ?? 'unknown'}). Likely a regional issue; ` +
            `retry in a few minutes or check Neon status page.`,
        );
      }
    }
    if (remaining.size > 0) await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  if (remaining.size > 0) {
    const detail = [...remaining]
      .map((id) => {
        const ls = lastSeen.get(id);
        if (!ls) return id;
        return `${id} (status=${ls.status}, failures=${ls.failures}, error=${ls.error ?? 'unknown'})`;
      })
      .join('; ');
    throw new Error(
      `[neon launch] Timed out after ${timeoutSeconds}s waiting for Neon operations to reach terminal: ${detail}.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single source of truth for the archived-branch error message — used
 * by both the first-time-found path and the concurrent-create
 * race-fallback path. Earlier versions duplicated the message and the
 * race path still pointed at `\`neon branches restore <name> --project-id <id>\``
 * after the first path was fixed. The duplicate ALSO suggested an
 * invalid CLI form (`neon branches restore` requires `<source>` as
 * the second positional per src/commands/branches.ts; it's PITR-style
 * restore, not unarchive). Centralizing here so a future "helpful
 * rewrite" can't introduce the same drift again.
 *
 * Honesty note: the prior version said "Archived branches auto-restore
 * when first accessed" — TRUE for psql/connection-string access, but
 * the launcher's pre-check uses `findBranchByName` (a list call), which
 * does NOT trigger auto-restore. So re-running won't unwedge.
 */
export function archivedBranchMessage(
  branchName: string,
  projectId: string,
): string {
  return [
    `[neon launch] Branch '${branchName}' is archived.`,
    `Unarchive via the console at https://console.neon.tech/app/projects/${projectId}/branches,`,
    `then re-run \`neon launch\`. Or rename it in your neon.ts so the launcher creates a fresh branch.`,
  ].join('\n');
}

async function findEndpoint(
  api: NeonApi,
  projectId: string,
  branchId: string,
): Promise<Endpoint | undefined> {
  const { data } = await withRetries(() =>
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

  const { data } = await withRetries(() =>
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
    // Archived branches will never reach 'ready' without an explicit
    // restore. Polling would just burn the per-branch timeout.
    if (branch.current_state === 'archived') {
      throw new LaunchError(
        archivedBranchMessage(spec.name, projectId),
        ExitCode.CONFIG_ERROR,
      );
    }
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
      createResp = await withRetries(() =>
        api.createProjectBranch(projectId, createBody),
      );
    } catch (err) {
      // Concurrent-create race: another launch beat us to it. Fall back to
      // listing + attaching if the branch now exists.
      // Only the "branch already exists" race surfaces as 409 or 422.
      // 401/403 are auth (rethrow — the user sees the underlying axios
      // message which already carries enough context). 4xx with other
      // codes (rate-limited, validation) shouldn't trigger a fallback
      // list+attach that would itself hit the same 4xx and obscure the
      // original diagnostic. Quota is its own special case detected
      // from the response body even on non-409/422 4xx.
      const status = isAxiosError(err) ? err.response?.status : undefined;
      const responseBody = isAxiosError(err)
        ? (err.response?.data as { message?: string } | undefined)
        : undefined;
      // Tighter regex than `/branch.*limit|quota/i`: the loose form
      // matches any 4xx body containing the word "quota" (e.g. a generic
      // "monthly quota exceeded for storage") and misclassifies it as
      // branch-quota. Anchor on phrases that name the branch resource.
      const msg = responseBody?.message ?? '';
      const quotaHit =
        /branch.*(limit|quota)/i.test(msg) ||
        /(limit|quota).*branch/i.test(msg);
      if (quotaHit) {
        // Quota is a plan-level limit, not an auth failure. CONFIG_ERROR
        // matches the user-actionable framing of the message (delete
        // branches or upgrade the project) and is consistent with the
        // documented exit-code contract.
        throw new LaunchError(
          branchQuotaMessage({ projectId }),
          ExitCode.CONFIG_ERROR,
        );
      }
      if (status === 409 || status === 422) {
        const existing = await findBranchByName(api, projectId, spec.name);
        if (existing) {
          // Same guard as the first-time-found path above. Without it,
          // a concurrent operator archiving the branch between A's
          // success and B's listing would send B into pollBranchReady
          // and burn the full `branchTimeoutSeconds` budget.
          if (existing.current_state === 'archived') {
            throw new LaunchError(
              archivedBranchMessage(spec.name, projectId),
              ExitCode.CONFIG_ERROR,
            );
          }
          log.info(
            `[postgres:${resourceFqn}] create returned ${status} but branch now exists — attaching (concurrent-create race).`,
          );
          branch =
            existing.current_state === 'ready'
              ? existing
              : await pollBranchReady(api, projectId, existing.id, timeoutS);
        } else {
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
  const database = await firstDatabase(api, projectId, branch.id);
  if (!database) {
    throw new LaunchError(
      `[neon launch] Branch ${branch.id} has no database. Create one via \`neon databases create\` or pick a branch that has one.`,
      ExitCode.CONFIG_ERROR,
    );
  }

  return { branch, endpoint, role, database };
}

async function firstNonSystemRole(
  api: NeonApi,
  projectId: string,
  branchId: string,
): Promise<string> {
  const { data } = await withRetries(() =>
    api.listProjectBranchRoles(projectId, branchId),
  );
  // `protected: true` flags platform-managed roles (e.g. superuser). The
  // launcher wants a user-owned role for the connection string; falling
  // back to the system role would silently grant app code privileges it
  // shouldn't have.
  const userRole = data.roles.find((r: Role) => !r.protected);
  if (!userRole) {
    throw new LaunchError(
      [
        `[neon launch] Branch ${branchId} has no user-owned role.`,
        `All roles on this branch are protected (system-managed).`,
        '',
        `Create a role via \`neon roles create --name <name>\` or via the Neon console, then re-run.`,
      ].join('\n'),
      ExitCode.CONFIG_ERROR,
    );
  }
  return userRole.name;
}

async function firstDatabase(
  api: NeonApi,
  projectId: string,
  branchId: string,
): Promise<string | undefined> {
  const { data } = await withRetries(() =>
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
  const { data } = await withRetries(() =>
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
