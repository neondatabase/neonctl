import { isAxiosError } from 'axios';

import { log } from './log.js';
import { BranchScopeProps } from './types.js';
import { writer } from './writer.js';
import { getFunction, NeonFunctionDeployment } from './functions_api.js';

export const DEPLOYMENT_FIELDS = [
  'id',
  'status',
  'runtime',
  'memory_mib',
  'created_at',
] as const;

// Overridable so tests can poll fast; defaults to 2s in real use.
const POLL_INTERVAL_MS =
  Number(process.env.NEON_FUNCTIONS_POLL_INTERVAL_MS) || 2000;

// Upper bound on --wait polling so the CLI never hangs (e.g. if our deployment
// never becomes active_deployment). Overridable so tests can time out fast;
// defaults to 10 minutes in real use.
const POLL_TIMEOUT_MS =
  Number(process.env.NEON_FUNCTIONS_POLL_TIMEOUT_MS) || 600_000;

const statusHint = (slug: string, projectId: string, branchId: string) =>
  `Check status with: neonctl functions get ${slug} --project-id ${projectId} --branch ${branchId}`;

// A poll error worth retrying: a network error (no HTTP response), a 5xx, or a
// 404 from eventual consistency. Anything else (e.g. 401/403) is surfaced.
const isTransient = (err: unknown): boolean =>
  isAxiosError(err) &&
  (err.response === undefined ||
    err.response.status === 404 ||
    err.response.status >= 500);

// Snapshot the active version, run `trigger` (the deployment POST), then poll
// until a NEW active version appears. --no-wait stops at first sight of it;
// --wait stops at a terminal status. Bounded by POLL_TIMEOUT_MS so it never
// hangs. Shared by `deploy` and the `env` subcommands; only `trigger` differs.
export const deployFunction = async (
  props: BranchScopeProps,
  branchId: string,
  slug: string,
  wait: boolean,
  trigger: () => Promise<void>,
): Promise<void> => {
  // Snapshot the active version before deploy so we can detect the new one
  // afterward. A missing function (404) or no active version → undefined.
  let before: number | undefined;
  try {
    const fn = await getFunction(
      props.apiClient,
      props.projectId,
      branchId,
      slug,
    );
    before = fn.active_deployment?.id;
  } catch (err: unknown) {
    if (!(isAxiosError(err) && err.response?.status === 404)) throw err;
  }

  await trigger();
  log.info(`Function deployment triggered for function ${slug}.`);

  // Best-effort interrupt: a Ctrl-C lands at the next poll boundary.
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let resolved: NeonFunctionDeployment | undefined;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  try {
    while (!interrupted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (interrupted) break;
      // The deploy already succeeded server-side; tolerate transient poll
      // failures and retry on the next interval. Surface anything else.
      let dep: NeonFunctionDeployment | undefined;
      try {
        dep = (
          await getFunction(props.apiClient, props.projectId, branchId, slug)
        ).active_deployment;
      } catch (err: unknown) {
        if (isTransient(err)) continue;
        throw err;
      }
      const isNew =
        dep !== undefined && (before === undefined || dep.id > before);
      if (isNew && dep) {
        resolved = dep;
        if (!wait) break;
        if (dep.status === 'completed' || dep.status === 'failed') break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (interrupted) {
    log.info(statusHint(slug, props.projectId, branchId));
    if (resolved) writer(props).end(resolved, { fields: DEPLOYMENT_FIELDS });
    return;
  }

  if (resolved === undefined) {
    log.info(statusHint(slug, props.projectId, branchId));
    throw new Error(
      `Timed out waiting for the deployment of ${slug} to start. It may still be in progress.`,
    );
  }

  writer(props).end(resolved, { fields: DEPLOYMENT_FIELDS });

  if (!wait) {
    log.info(statusHint(slug, props.projectId, branchId));
    return;
  }
  if (resolved.status === 'completed') {
    log.info(`Function deployment ${slug}/${resolved.id} completed.`);
    return;
  }
  if (resolved.status === 'failed') {
    throw new Error(`Function deployment ${slug}/${resolved.id} failed.`);
  }

  // --wait, new version appeared but the deadline hit before it finished.
  log.info(statusHint(slug, props.projectId, branchId));
  throw new Error(
    `Timed out waiting for function deployment ${slug}/${resolved.id} to finish. It may still be building.`,
  );
};
