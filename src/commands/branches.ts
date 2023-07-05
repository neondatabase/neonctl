import {
  BranchCreateRequest,
  BranchCreateRequestEndpointOptions,
  BranchUpdateRequest,
} from '@neondatabase/api-client';
import yargs from 'yargs';

import { IdOrNameProps, ProjectScopeProps } from '../types.js';
import { writer } from '../writer.js';
import {
  branchCreateRequest,
  branchCreateRequestEndpointOptions,
} from '../parameters.gen.js';
import { commandFailHandler } from '../utils.js';
import { retryOnLock } from '../api.js';
import { branchIdFromProps, fillSingleProject } from '../enrichers.js';

const BRANCH_FIELDS = ['id', 'name', 'created_at', 'updated_at'] as const;

export const command = 'branches';
export const describe = 'Manage branches';
export const aliases = ['branch'];
export const builder = (argv: yargs.Argv) =>
  argv
    .demandCommand(1, '')
    .fail(commandFailHandler)
    .usage('usage: $0 branches <sub-command> [options]')
    .options({
      'project.id': {
        describe: 'Project ID',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
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
              ([key, value]) =>
                [`endpoint.${key}`, { ...value, demandOption: false }] as const
            )
          ),
        }),
      async (args) => await create(args as any)
    )
    .command(
      'update <id|name>',
      'Update a branch',
      (yargs) =>
        yargs.options({
          'branch.name': {
            describe: 'Branch name',
            type: 'string',
            demandOption: true,
          },
        }),
      async (args) => await update(args as any)
    )
    .command(
      'delete <id|name>',
      'Delete a branch',
      (yargs) => yargs,
      async (args) => await deleteBranch(args as any)
    )
    .command(
      'get <id|name>',
      'Get a branch',
      (yargs) => yargs,
      async (args) => await get(args as any)
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: ProjectScopeProps) => {
  const { data } = await props.apiClient.listProjectBranches(props.project.id);
  writer(props).end(data.branches, {
    fields: BRANCH_FIELDS,
  });
};

const create = async (
  props: ProjectScopeProps &
    Pick<BranchCreateRequest, 'branch'> & {
      endpoint: BranchCreateRequestEndpointOptions;
    }
) => {
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectBranch(props.project.id, {
      branch: props.branch,
      endpoints: props.endpoint ? [props.endpoint] : undefined,
    })
  );
  const out = writer(props);
  out.write(data.branch, {
    fields: BRANCH_FIELDS,
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

const update = async (
  props: ProjectScopeProps & IdOrNameProps & BranchUpdateRequest
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.updateProjectBranch(props.project.id, branchId, {
      branch: props.branch,
    })
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const deleteBranch = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectBranch(props.project.id, branchId)
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const get = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await props.apiClient.getProjectBranch(
    props.project.id,
    branchId
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};
