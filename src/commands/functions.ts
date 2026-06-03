import yargs from 'yargs';

import { BranchScopeProps } from '../types.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { writer } from '../writer.js';
import { listFunctions } from '../functions_api.js';

const FUNCTION_FIELDS = [
  'slug',
  'name',
  'invocation_url',
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
    );

export const handler = (args: yargs.Argv) => {
  return args;
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
