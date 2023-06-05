import {
  BranchCreateRequest,
  BranchCreateRequestEndpointOptions,
  BranchUpdateRequest,
} from '@neondatabase/api-client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { BranchScopeProps, ProjectScopeProps } from '../types.js';
import { writer } from '../writer.js';
import {
  branchCreateRequest,
  branchCreateRequestEndpointOptions,
  branchUpdateRequest,
} from '../parameters.gen.js';

export const command = 'branches';
export const describe = 'Manage branches';
export const builder = (argv: yargs.Argv) =>
  argv
    .demandCommand(1, '')
    .fail(async (_msg, _err, argv) => {
      const y = yargs(hideBin(process.argv));
      if ((y.argv as yargs.Arguments)._.length === 1) {
        argv.showHelp();
        process.exit(1);
      }
    })
    .usage('usage: $0 branches <cmd> [args]')
    .options({
      'project.id': {
        describe: 'Project ID',
        type: 'string',
        demandOption: true,
      },
    })
    .command(
      'list',
      'List branches',
      (yargs) => yargs,
      async (args) => await list(args as any)
    )
    .command(
      'create',
      'Create a branch',
      (yargs) =>
        yargs.options({
          ...branchCreateRequest,
          ...Object.fromEntries(
            Object.entries(branchCreateRequestEndpointOptions).map(
              ([key, value]) => [`endpoint.${key}`, value] as const
            )
          ),
        }),
      async (args) => await create(args as any)
    )
    .command(
      'update',
      'Update a branch',
      (yargs) =>
        yargs.options(branchUpdateRequest).option('branch.id', {
          describe: 'Branch ID',
          type: 'string',
          demandOption: true,
        }),
      async (args) => await update(args as any)
    )
    .command(
      'delete',
      'Delete a branch',
      (yargs) =>
        yargs.option('branch.id', {
          describe: 'Branch ID',
          type: 'string',
          demandOption: true,
        }),
      async (args) => await deleteBranch(args as any)
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: ProjectScopeProps) => {
  const { data } = await props.apiClient.listProjectBranches(props.project.id);
  writer(props).end(data.branches, {
    fields: ['id', 'name', 'created_at'],
  });
};

const create = async (
  props: ProjectScopeProps &
    Pick<BranchCreateRequest, 'branch'> & {
      endpoint: BranchCreateRequestEndpointOptions;
    }
) => {
  const { data } = await props.apiClient.createProjectBranch(props.project.id, {
    branch: props.branch,
    endpoints: props.endpoint ? [props.endpoint] : undefined,
  });
  const out = writer(props);
  out.write(data.branch, {
    fields: ['id', 'name', 'created_at'],
    title: 'branch',
  });

  if (data.endpoints?.length > 0) {
    out.write(data.endpoints, {
      fields: ['id', 'created_at'],
      title: 'endpoints',
    });
  }
  if (data.connection_uris && data.connection_uris?.length > 0) {
    out.write(data.connection_uris, {
      fields: ['connection_uri'],
      title: 'connection_uris',
    });
  }
  out.end();
};

const update = async (props: BranchScopeProps & BranchUpdateRequest) => {
  const { data } = await props.apiClient.updateProjectBranch(
    props.project.id,
    props.branch.id,
    {
      branch: props.branch,
    }
  );
  writer(props).end(data.branch, {
    fields: ['id', 'name', 'created_at'],
  });
};

const deleteBranch = async (props: BranchScopeProps) => {
  const { data } = await props.apiClient.deleteProjectBranch(
    props.project.id,
    props.branch.id
  );
  writer(props).end(data.branch, {
    fields: ['id', 'name', 'created_at'],
  });
};
