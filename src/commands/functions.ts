import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import yargs from 'yargs';
import { isAxiosError } from 'axios';

import { retryOnLock } from '../api.js';
import { log } from '../log.js';
import { BranchScopeProps } from '../types.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { zipBundle } from '../utils/zip.js';
import { bundleEntry } from '../utils/esbuild.js';
import { writer } from '../writer.js';
import {
  createDeployment,
  deleteFunction,
  getFunction,
  listFunctions,
  NeonFunction,
  NeonFunctionDeployment,
} from '../functions_api.js';

const FUNCTION_FIELDS = [
  'slug',
  'name',
  'invocation_url',
  'created_at',
] as const;

const FUNCTIONS_LIST_LIMIT = 100;

// Table columns for `functions list`. `status` is a derived field (the
// table writer reads flat fields only): the current deployment's status.
const LIST_TABLE_FIELDS = [
  'slug',
  'name',
  'status',
  'invocation_url',
  'created_at',
] as const;

const DEPLOYMENT_FIELDS = [
  'id',
  'status',
  'runtime',
  'memory_mib',
  'created_at',
] as const;

// Deploy emits the resolved deployment plus the function's invocation_url, so a
// successful `functions deploy` tells the user exactly where to call the function.
const DEPLOY_RESULT_FIELDS = [
  'id',
  'status',
  'invocation_url',
  'runtime',
  'memory_mib',
  'created_at',
] as const;

// In table mode a failed build's reason gets its own "deployment error"
// section after the deployment table; json/yaml carry the raw `error` field.
const writeDeploymentErrorSection = (
  out: ReturnType<typeof writer>,
  dep: NeonFunctionDeployment,
) => {
  if (dep.status === 'failed' && dep.error) {
    out.write(
      { reason: dep.error },
      { fields: ['reason'], title: 'deployment error' },
    );
  }
};

const SLUG_PATTERN = /^[a-z0-9]{1,20}$/;
const SLUG_HELP =
  'Use 1-20 lowercase letters and digits (no hyphens or other characters).';

// Entry-point discovery order inside --src.
const ENTRY_CANDIDATES = ['index.ts', 'index.mjs', 'index.js'] as const;

// Overridable so tests can poll fast; defaults to 2s in real use.
const POLL_INTERVAL_MS =
  Number(process.env.NEON_FUNCTIONS_POLL_INTERVAL_MS) || 2000;

// Upper bound on --wait polling so the CLI never hangs (e.g. if our deployment
// never shows up as current_deployment). Overridable so tests can time out fast;
// defaults to 10 minutes in real use.
const POLL_TIMEOUT_MS =
  Number(process.env.NEON_FUNCTIONS_POLL_TIMEOUT_MS) || 600_000;

export const command = 'function';
export const describe = 'Manage Neon Functions';
export const aliases = ['functions'];
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 function <sub-command> [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'deploy <slug>',
      'Deploy a function from a local directory',
      (yargs) =>
        yargs
          .positional('slug', {
            describe: 'Function slug (1-20 lowercase letters and digits)',
            type: 'string',
            demandOption: true,
          })
          .options({
            src: {
              describe:
                'Function source: a directory containing index.ts, index.mjs, or index.js, or a path to the entry file',
              type: 'string',
            },
            // Removed flags, kept hidden so old invocations fail loudly instead
            // of being silently ignored (the CLI has no .strictOptions()).
            path: {
              type: 'string',
              hidden: true,
            },
            entry: {
              type: 'string',
              hidden: true,
            },
            runtime: {
              describe: 'Function runtime',
              type: 'string',
              choices: ['nodejs24'],
            },
            env: {
              describe: 'Environment variable as KEY=VALUE (repeatable)',
              type: 'string',
              array: true,
            },
            wait: {
              describe: 'Wait for the deployment to finish building',
              type: 'boolean',
              default: true,
            },
          }),
      (args) => deploy(args as any),
    )
    .command(
      'list',
      'List functions on the branch',
      (yargs) => yargs,
      (args) => list(args as any),
    )
    .command(
      'get <slug>',
      "Show a function's details",
      (yargs) =>
        yargs
          .positional('slug', {
            describe: 'Function slug',
            type: 'string',
            demandOption: true,
          })
          .options({
            'list-env-variables': {
              describe:
                'List the environment variable names of the active deployment',
              type: 'boolean',
              alias: 'E',
              default: false,
            },
          }),
      (args) => get(args as any),
    )
    .command(
      'delete <slug>',
      'Delete a function on the branch',
      (yargs) =>
        yargs.positional('slug', {
          describe: 'Function slug',
          type: 'string',
          demandOption: true,
        }),
      (args) => deleteFn(args as any),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

type DeployProps = BranchScopeProps & {
  slug: string;
  src?: string;
  path?: string;
  entry?: string;
  runtime?: string;
  env?: string[];
  wait: boolean;
};

const parseEnv = (entries: string[] | undefined): string | undefined => {
  if (!entries || entries.length === 0) return undefined;
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --env value "${entry}". Expected KEY=VALUE.`);
    }
    map[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return JSON.stringify(map);
};

const statusHint = (slug: string, projectId: string, branchId: string) =>
  `Check status with: neonctl function get ${slug} --project-id ${projectId} --branch ${branchId}`;

// Emit the resolved deployment together with the function's invocation_url, so the
// deploy output shows where the function is reachable (not just the deployment id).
const emitDeployResult = (
  props: DeployProps,
  deployment: NeonFunctionDeployment,
  fn: NeonFunction | undefined,
) => {
  const out = writer(props).write(
    { ...deployment, invocation_url: fn?.invocation_url },
    { fields: DEPLOY_RESULT_FIELDS },
  );
  if (props.output !== 'json' && props.output !== 'yaml') {
    writeDeploymentErrorSection(out, deployment);
  }
  out.end();
};

// A poll error worth retrying: a network error (no HTTP response), a 5xx, or a
// 404 from eventual consistency. Anything else (e.g. 401/403) is surfaced.
const isTransient = (err: unknown): boolean =>
  isAxiosError(err) &&
  (err.response === undefined ||
    err.response.status === 404 ||
    err.response.status >= 500);

const deploy = async (props: DeployProps) => {
  if (props.path !== undefined || props.entry !== undefined) {
    throw new Error(
      '--path and --entry were removed. Use --src <dir>; the entry point ' +
        'is discovered as index.ts, index.mjs, or index.js in that directory.',
    );
  }

  // At least one deploy option must be passed (--wait is excluded: it controls
  // output, not what gets deployed).
  const hasOption =
    props.src !== undefined ||
    props.env !== undefined ||
    props.runtime !== undefined;
  if (!hasOption) {
    throw new Error(
      'Provide at least one option to deploy, e.g. --src or --env. ' +
        'See: neonctl function deploy --help.',
    );
  }

  // Cheap, offline validation first - fail before any network round-trip.
  if (!SLUG_PATTERN.test(props.slug)) {
    throw new Error(`Invalid function slug "${props.slug}". ${SLUG_HELP}`);
  }

  const src = props.src ?? '.';
  const runtime = props.runtime ?? 'nodejs24';

  const environment = parseEnv(props.env);
  const srcStat = statSync(src, { throwIfNoEntry: false });
  if (srcStat === undefined) {
    throw new Error(`--src path not found: ${src}.`);
  }
  // A file is used as the entry point directly; a directory triggers discovery.
  const source = srcStat.isFile()
    ? src
    : ENTRY_CANDIDATES.map((name) => join(src, name)).find((p) =>
        existsSync(p),
      );
  if (source === undefined) {
    throw new Error(
      `No entry file found in ${src}. Expected one of: ${ENTRY_CANDIDATES.join(', ')}.`,
    );
  }

  // Bundle before any network round-trip so a bundling failure fails fast.
  const zip = zipBundle(await bundleEntry(source));
  const branchId = await branchIdFromProps(props);

  // Snapshot the current version before deploy so we can detect the new one
  // afterward. A missing function (404) or no deployment yet → undefined.
  let before: number | undefined;
  try {
    const fn = await getFunction(
      props.apiClient,
      props.projectId,
      branchId,
      props.slug,
    );
    before = fn.current_deployment?.id;
  } catch (err: unknown) {
    if (!(isAxiosError(err) && err.response?.status === 404)) throw err;
  }

  await retryOnLock(() =>
    createDeployment(props.apiClient, props.projectId, branchId, props.slug, {
      zip,
      runtime,
      environment,
    }),
  );
  log.info(`Function deployment triggered for function ${props.slug}.`);

  // Best-effort interrupt: a Ctrl-C lands at the next poll boundary. (No
  // automated test; mirrors the resolution branches below, verified manually.)
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // Poll until a NEW version appears (id greater than the snapshot, or
  // any version if there was none). --no-wait stops there; --wait stops at a
  // terminal status. Bounded by POLL_TIMEOUT_MS so it never hangs.
  let resolved: NeonFunctionDeployment | undefined;
  // The function carries the invocation_url; keep the whole record (not just its
  // current_deployment) so we can surface that URL on success.
  let resolvedFn: NeonFunction | undefined;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  try {
    while (!interrupted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (interrupted) break;
      // The deploy already succeeded server-side; tolerate transient poll
      // failures and retry on the next interval. Surface anything else.
      let fn: NeonFunction | undefined;
      try {
        fn = await getFunction(
          props.apiClient,
          props.projectId,
          branchId,
          props.slug,
        );
      } catch (err: unknown) {
        if (isTransient(err)) continue;
        throw err;
      }
      const dep = fn.current_deployment;
      const isNew =
        dep !== undefined && (before === undefined || dep.id > before);
      if (isNew && dep) {
        resolved = dep;
        resolvedFn = fn;
        if (!props.wait) break;
        if (dep.status === 'completed' || dep.status === 'failed') break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (interrupted) {
    log.info(statusHint(props.slug, props.projectId, branchId));
    if (resolved) emitDeployResult(props, resolved, resolvedFn);
    return;
  }

  if (resolved === undefined) {
    log.info(statusHint(props.slug, props.projectId, branchId));
    throw new Error(
      `Timed out waiting for the deployment of ${props.slug} to start. It may still be in progress.`,
    );
  }

  emitDeployResult(props, resolved, resolvedFn);

  if (!props.wait) {
    log.info(statusHint(props.slug, props.projectId, branchId));
    return;
  }
  if (resolved.status === 'completed') {
    log.info(`Function deployment ${props.slug}/${resolved.id} completed.`);
    return;
  }
  if (resolved.status === 'failed') {
    throw new Error(`Function deployment ${props.slug}/${resolved.id} failed.`);
  }

  // --wait, new version appeared but the deadline hit before it finished.
  log.info(statusHint(props.slug, props.projectId, branchId));
  throw new Error(
    `Timed out waiting for function deployment ${props.slug}/${resolved.id} to finish. It may still be building.`,
  );
};

const get = async (
  props: BranchScopeProps & { slug: string; listEnvVariables: boolean },
) => {
  const branchId = await branchIdFromProps(props);
  const fn = await getFunction(
    props.apiClient,
    props.projectId,
    branchId,
    props.slug,
  );

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(fn, { fields: FUNCTION_FIELDS });
    return;
  }

  const out = writer(props).write(fn, {
    fields: FUNCTION_FIELDS,
    title: 'function',
  });
  const current = fn.current_deployment;
  const active = fn.active_deployment;
  if (current && active && current.id === active.id) {
    out.write(current, {
      fields: DEPLOYMENT_FIELDS,
      title: 'deployment (current, active)',
    });
    writeDeploymentErrorSection(out, current);
  } else {
    if (current) {
      out.write(current, {
        fields: DEPLOYMENT_FIELDS,
        title: 'current deployment',
      });
      // The failure reason is shown only for the current deployment;
      // the active one completed successfully by definition.
      writeDeploymentErrorSection(out, current);
    }
    if (active) {
      out.write(active, {
        fields: DEPLOYMENT_FIELDS,
        title: 'active deployment',
      });
    }
  }
  if (props.listEnvVariables) {
    out.write(
      (fn.active_deployment?.environment ?? []).map((name) => ({ name })),
      {
        fields: ['name'],
        title: 'environment',
        emptyMessage: 'No environment variables on the active deployment.',
      },
    );
  }
  out.end();
};

const deleteFn = async (props: BranchScopeProps & { slug: string }) => {
  const branchId = await branchIdFromProps(props);
  try {
    await retryOnLock(() =>
      deleteFunction(props.apiClient, props.projectId, branchId, props.slug),
    );
  } catch (err: unknown) {
    if (isAxiosError(err) && err.response?.status === 404) {
      throw new Error(
        `Function "${props.slug}" not found on branch ${branchId}.`,
      );
    }
    throw err;
  }
  log.info(`Function ${props.slug} deleted from branch ${branchId}`);
};

const list = async (props: BranchScopeProps) => {
  const branchId = await branchIdFromProps(props);
  const functions: NeonFunction[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listFunctions(
      props.apiClient,
      props.projectId,
      branchId,
      { cursor, limit: FUNCTIONS_LIST_LIMIT },
    );
    functions.push(...page.functions);
    log.debug(
      'Got %d functions, next cursor: %s',
      page.functions.length,
      page.next,
    );
    // A server echoing the same cursor would loop forever; treat it as
    // the end of the list.
    if (!page.next || page.next === cursor) break;
    cursor = page.next;
  }

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(functions, { fields: FUNCTION_FIELDS });
    return;
  }

  writer(props).end(
    functions.map((fn) => ({
      ...fn,
      status: fn.current_deployment?.status ?? '',
    })),
    {
      fields: LIST_TABLE_FIELDS,
      emptyMessage: 'No functions found on this branch.',
    },
  );
};
