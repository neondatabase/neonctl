import { EndpointType } from '@neondatabase/api-client';
import yargs from 'yargs';

import { IdOrNameProps, ProjectScopeProps } from '../types.js';
import { writer } from '../writer.js';
import { branchCreateRequest } from '../parameters.gen.js';
import { retryOnLock } from '../api.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import {
  looksLikeBranchId,
  looksLikeLSN,
  looksLikeTimestamp,
} from '../utils/formats.js';
import { showHelpMiddleware } from '../help.js';

const BRANCH_FIELDS = [
  'id',
  'name',
  'primary',
  'created_at',
  'updated_at',
] as const;

export const command = 'branches';
export const describe = 'Manage branches';
export const aliases = ['branch'];
export const builder = (argv: yargs.Argv) =>
  argv
    .middleware(showHelpMiddleware(argv))
    .usage('usage: $0 branches <sub-command> [options]')
    .options({
      'project-id': {
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
          name: branchCreateRequest['branch.name'],
          parent: {
            describe:
              'Parent branch name or id or timestamp or LSN. Defaults to the primary branch',
            type: 'string',
          },
          compute: {
            describe:
              'Create a branch with or without a compute. By default branch is created with a read-write compute. To create a branch without compute use --no-compute',
            type: 'boolean',
            default: true,
          },
          type: {
            describe: 'Type of compute to add',
            type: 'string',
            implies: 'compute',
            default: EndpointType.ReadWrite,
            choices: Object.values(EndpointType),
          },
        }),
      async (args) => await create(args as any)
    )
    .command(
      'rename <id|name> <new-name>',
      'Rename a branch',
      (yargs) => yargs,
      async (args) => await rename(args as any)
    )
    .command(
      'set-primary <id|name>',
      'Set a branch as primary',
      (yargs) => yargs,
      async (args) => await setPrimary(args as any)
    )
    .command(
      'add-compute <id|name>',
      'Add a compute to a branch',
      (yargs) =>
        yargs.options({
          type: {
            type: 'string',
            choices: Object.values(EndpointType),
            describe: 'Type of compute to add',
            default: EndpointType.ReadOnly,
          },
        }),
      async (args) => await addCompute(args as any)
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
  const { data } = await props.apiClient.listProjectBranches(props.projectId);
  writer(props).end(data.branches, {
    fields: BRANCH_FIELDS,
  });
};

const create = async (
  props: ProjectScopeProps & {
    name: string;
    compute: boolean;
    parent?: string;
    type: EndpointType;
  }
) => {
  const parentProps = await (() => {
    if (!props.parent) {
      return props.apiClient
        .listProjectBranches(props.projectId)
        .then(({ data }) => {
          const branch = data.branches.find((b) => b.primary);
          if (!branch) {
            throw new Error('No primary branch found');
          }
          return { parent_id: branch.id };
        });
    }

    if (looksLikeLSN(props.parent)) {
      return { parent_lsn: props.parent };
    }

    if (looksLikeTimestamp(props.parent)) {
      return { parent_timestamp: props.parent };
    }

    if (looksLikeBranchId(props.parent)) {
      return { parent_id: props.parent };
    }
    return props.apiClient
      .listProjectBranches(props.projectId)
      .then(({ data }) => {
        const branch = data.branches.find((b) => b.name === props.parent);
        if (!branch) {
          throw new Error(`Branch ${props.parent} not found`);
        }
        return { parent_id: branch.id };
      });
  })();

  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectBranch(props.projectId, {
      branch: {
        name: props.name,
        ...parentProps,
      },
      endpoints: props.compute
        ? [
            {
              type: props.type,
            },
          ]
        : [],
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

const rename = async (
  props: ProjectScopeProps & IdOrNameProps & { newName: string }
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.updateProjectBranch(props.projectId, branchId, {
      branch: {
        name: props.newName,
      },
    })
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const setPrimary = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.setPrimaryProjectBranch(props.projectId, branchId)
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const deleteBranch = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectBranch(props.projectId, branchId)
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const get = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await props.apiClient.getProjectBranch(
    props.projectId,
    branchId
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const addCompute = async (
  props: ProjectScopeProps &
    IdOrNameProps & {
      type: EndpointType;
    }
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectEndpoint(props.projectId, {
      endpoint: {
        branch_id: branchId,
        type: props.type,
      },
    })
  );
  writer(props).end(data.endpoint, {
    fields: ['id', 'host'],
  });
};
