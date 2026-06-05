import { existsSync } from 'node:fs';
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
  createEnvDeployment,
  deleteFunction,
  getFunction,
  listFunctions,
} from '../functions_api.js';
import { deployFunction, DEPLOYMENT_FIELDS } from '../functions_deploy.js';

const FUNCTION_FIELDS = [
  'slug',
  'name',
  'invocation_url',
  'created_at',
] as const;

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const SLUG_HELP =
  'Use 1-40 lowercase letters, digits, and hyphens; it must start and end with a letter or digit.';
const MEMORY_CHOICES = [256, 512, 1024, 2048, 4096, 8192];

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
              describe: 'Base directory for the function (resolves --entry)',
              type: 'string',
            },
            entry: {
              describe: 'Entry file to bundle, relative to --path',
              type: 'string',
            },
            'memory-mib': {
              describe: 'Memory in MiB',
              type: 'number',
              choices: MEMORY_CHOICES,
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
    )
    .command(
      ['env', 'environment'],
      "Manage a function's environment variables",
      (yargs) =>
        yargs
          .usage('$0 functions env <sub-command> [options]')
          .command(
            'add <slug> <key> <value>',
            'Set an environment variable. Changing environment variables triggers a redeployment of the function.',
            (yargs) =>
              yargs
                .positional('slug', {
                  describe: 'Function slug',
                  type: 'string',
                  demandOption: true,
                })
                .positional('key', {
                  describe: 'Environment variable name',
                  type: 'string',
                  demandOption: true,
                })
                .positional('value', {
                  describe: 'Environment variable value',
                  type: 'string',
                  demandOption: true,
                })
                .options({
                  wait: {
                    describe: 'Wait for the redeployment to finish building',
                    type: 'boolean',
                    default: true,
                  },
                }),
            (args) => envAdd(args as any),
          )
          .demandCommand(1),
      (args) => args as any,
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

type DeployProps = BranchScopeProps & {
  slug: string;
  path?: string;
  entry?: string;
  memoryMib?: number;
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

const deploy = async (props: DeployProps) => {
  // At least one deploy option must be passed (--wait is excluded: it controls
  // output, not what gets deployed).
  const hasOption =
    props.path !== undefined ||
    props.entry !== undefined ||
    props.env !== undefined ||
    props.memoryMib !== undefined ||
    props.runtime !== undefined;
  if (!hasOption) {
    throw new Error(
      'Provide at least one option to deploy, e.g. --path, --entry, or --env. ' +
        'See: neonctl functions deploy --help.',
    );
  }

  // Cheap, offline validation first - fail before any network round-trip.
  if (!SLUG_PATTERN.test(props.slug)) {
    throw new Error(`Invalid function slug "${props.slug}". ${SLUG_HELP}`);
  }

  const path = props.path ?? '.';
  const entry = props.entry ?? 'index.ts';
  const memoryMib = props.memoryMib ?? 256;
  const runtime = props.runtime ?? 'nodejs24';

  const environment = parseEnv(props.env);
  const source = join(path, entry);
  if (!existsSync(source)) {
    throw new Error(
      `Entry file not found: ${source}. Pass --entry to point at your function's entry file (defaults to index.ts).`,
    );
  }

  // Bundle before any network round-trip so a bundling failure fails fast.
  const zip = zipBundle(await bundleEntry(source));
  const branchId = await branchIdFromProps(props);

  await deployFunction(props, branchId, props.slug, props.wait, () =>
    retryOnLock(() =>
      createDeployment(props.apiClient, props.projectId, branchId, props.slug, {
        zip,
        memoryMib,
        runtime,
        environment,
      }),
    ),
  );
};

type EnvAddProps = BranchScopeProps & {
  slug: string;
  key: string;
  value: string;
  wait: boolean;
};

const envAdd = async (props: EnvAddProps) => {
  if (!SLUG_PATTERN.test(props.slug)) {
    throw new Error(`Invalid function slug "${props.slug}". ${SLUG_HELP}`);
  }
  // An empty value is the server's delete signal; route that through `rm`
  // explicitly rather than silently dropping the key on an `add`.
  if (props.value === '') {
    throw new Error(
      'Refusing to set an empty value. To remove a variable, use: neonctl functions env rm <slug> <key>.',
    );
  }
  const branchId = await branchIdFromProps(props);
  await deployFunction(props, branchId, props.slug, props.wait, () =>
    retryOnLock(() =>
      createEnvDeployment(
        props.apiClient,
        props.projectId,
        branchId,
        props.slug,
        {
          [props.key]: props.value,
        },
      ),
    ),
  );
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

  writer(props).end(functions, {
    fields: FUNCTION_FIELDS,
    emptyMessage: 'No functions found on this branch.',
  });
};
