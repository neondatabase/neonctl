import {
  BranchCreateRequest,
  BranchCreateRequestEndpointOptions,
  BranchUpdateRequest,
} from '@neondatabase/api-client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { BranchScopeProps, ProjectScopeProps } from '../types.js';
import { writeOut } from '../writer.js';
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
  writeOut(props)(data.branches, {
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
  writeOut(props)({
    branch: {
      data: data.branch,
      config: { fields: ['id', 'name', 'created_at'] },
    },
    ...(data.endpoints?.length > 0
      ? {
          endpoints: {
            data: data.endpoints,
            config: { fields: ['id', 'created_at'] },
          },
        }
      : {}),
    ...(data.connection_uris
      ? {
          connection_uri: {
            data: data.connection_uris[0],
            config: {
              fields: ['connection_uri'],
            },
          },
        }
      : {}),
  } as any);
};

const update = async (props: BranchScopeProps & BranchUpdateRequest) => {
  const { data } = await props.apiClient.updateProjectBranch(
    props.project.id,
    props.branch.id,
    {
      branch: props.branch,
    }
  );
  writeOut(props)(data.branch, {
    fields: ['id', 'name', 'created_at'],
  });
};

const deleteBranch = async (props: BranchScopeProps) => {
  const { data } = await props.apiClient.deleteProjectBranch(
    props.project.id,
    props.branch.id
  );
  writeOut(props)(data.branch, {
    fields: ['id', 'name', 'created_at'],
  });
};
