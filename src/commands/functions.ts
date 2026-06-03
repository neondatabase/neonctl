import yargs from 'yargs';

import { BranchScopeProps } from '../types.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { writer } from '../writer.js';
import { getFunction, listFunctions } from '../functions_api.js';

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
    );

export const handler = (args: yargs.Argv) => {
  return args;
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
