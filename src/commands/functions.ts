import { existsSync } from 'node:fs';
import { join } from 'node:path';

import yargs from 'yargs';
import { isAxiosError } from 'axios';

import { retryOnLock } from '../api.js';
import { log } from '../log.js';
import { BranchScopeProps } from '../types.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { buildZip } from '../utils/zip.js';
import { writer } from '../writer.js';
import {
  createDeployment,
  deleteFunction,
  getDeployment,
  getFunction,
  listFunctions,
  NeonFunctionDeployment,
} from '../functions_api.js';

const FUNCTION_FIELDS = [
  'slug',
  'name',
  'invocation_url',
  'created_at',
] as const;

const DEPLOYMENT_FIELDS = [
  'id',
  'status',
  'runtime',
  'memory_mib',
  'concurrency',
  'bundle_sha256',
  'created_at',
] as const;

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const SLUG_HELP =
  'Use 1-40 lowercase letters, digits, and hyphens; it must start and end with a letter or digit.';
const MEMORY_CHOICES = [256, 512, 1024, 2048, 4096, 8192];

// Overridable so tests can poll fast; defaults to 2s in real use.
const POLL_INTERVAL_MS =
  Number(process.env.NEON_FUNCTIONS_POLL_INTERVAL_MS) || 2000;

export const command = 'functions';
export const describe = 'Manage Neon Functions';
export const aliases = ['function'];
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 functions <sub-command> [options]')
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
            describe: 'Function slug (lowercase DNS label)',
            type: 'string',
            demandOption: true,
          })
          .options({
            path: {
              describe: 'Directory to deploy (must contain index.ts)',
              type: 'string',
              default: '.',
            },
            'memory-mib': {
              describe: 'Memory in MiB',
              type: 'number',
              choices: MEMORY_CHOICES,
              default: 256,
            },
            concurrency: {
              describe: 'Maximum concurrent invocations (1-1000)',
              type: 'number',
              default: 1,
            },
            runtime: {
              describe: 'Function runtime',
              type: 'string',
              choices: ['nodejs24'],
              default: 'nodejs24',
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
        yargs.positional('slug', {
          describe: 'Function slug',
          type: 'string',
          demandOption: true,
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
  path: string;
  memoryMib: number;
  concurrency: number;
  runtime: string;
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
  `Check status with: neonctl functions get ${slug} --project-id ${projectId} --branch ${branchId}`;

const deploy = async (props: DeployProps) => {
  // Cheap, offline validation first — fail before any network round-trip.
  if (!SLUG_PATTERN.test(props.slug)) {
    throw new Error(`Invalid function slug "${props.slug}". ${SLUG_HELP}`);
  }
  if (
    !Number.isInteger(props.concurrency) ||
    props.concurrency < 1 ||
    props.concurrency > 1000
  ) {
    throw new Error(
      `Invalid --concurrency ${props.concurrency}. It must be an integer between 1 and 1000.`,
    );
  }
  const environment = parseEnv(props.env);
  const indexPath = join(props.path, 'index.ts');
  if (!existsSync(indexPath)) {
    throw new Error(
      `No index.ts found in ${props.path}. A function must have an index.ts at the root of --path.`,
    );
  }

  const branchId = await branchIdFromProps(props);
  const zip = buildZip(props.path);

  const deployment = await retryOnLock(() =>
    createDeployment(props.apiClient, props.projectId, branchId, props.slug, {
      zip,
      memoryMib: props.memoryMib,
      concurrency: props.concurrency,
      runtime: props.runtime,
      environment,
    }),
  );
  log.info(
    `Deployment ${deployment.id} created for ${props.slug} (status: ${deployment.status})`,
  );

  if (!props.wait) {
    log.info(statusHint(props.slug, props.projectId, branchId));
    writer(props).end(deployment, { fields: DEPLOYMENT_FIELDS });
    return;
  }

  // Best-effort interrupt: a Ctrl-C lands at the next poll boundary, after
  // which we print the status hint and exit cleanly. (No automated test; the
  // path mirrors the --no-wait branch and is verified manually.)
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let current: NeonFunctionDeployment = deployment;
  try {
    while (
      current.status !== 'completed' &&
      current.status !== 'failed' &&
      !interrupted
    ) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (interrupted) break;
      current = await getDeployment(
        props.apiClient,
        props.projectId,
        branchId,
        props.slug,
        deployment.id,
      );
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (interrupted) {
    log.info(statusHint(props.slug, props.projectId, branchId));
    writer(props).end(current, { fields: DEPLOYMENT_FIELDS });
    return;
  }

  // Print the final deployment to stdout, then signal failure by throwing.
  // The global handler prints `ERROR: <msg>`, flushes analytics, and exits 1.
  writer(props).end(current, { fields: DEPLOYMENT_FIELDS });
  if (current.status === 'failed') {
    throw new Error(`Deployment ${current.id} failed.`);
  }
  log.info(`Deployment ${current.id} completed.`);
};

const get = async (props: BranchScopeProps & { slug: string }) => {
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
  if (fn.active_deployment) {
    out.write(fn.active_deployment, {
      fields: DEPLOYMENT_FIELDS,
      title: 'active deployment',
    });
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
  const functions = await listFunctions(
    props.apiClient,
    props.projectId,
    branchId,
  );

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(functions, { fields: FUNCTION_FIELDS });
    return;
  }

  const rows = functions.map((fn) => ({
    slug: fn.slug,
    name: fn.name,
    invocation_url: fn.invocation_url,
    status: fn.active_deployment?.status ?? '-',
    created_at: fn.created_at,
  }));
  writer(props).end(rows, {
    fields: ['slug', 'name', 'invocation_url', 'status', 'created_at'],
    emptyMessage: 'No functions found on this branch.',
  });
};
