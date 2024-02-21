import { Branch, EndpointType } from '@neondatabase/api-client';
import yargs from 'yargs';

import { IdOrNameProps, ProjectScopeProps } from '../types.js';
import { writer } from '../writer.js';
import { branchCreateRequest } from '../parameters.gen.js';
import { retryOnLock } from '../api.js';
import {
  branchIdFromProps,
  branchIdResolve,
  fillSingleProject,
} from '../utils/enrichers.js';
import {
  looksLikeBranchId,
  looksLikeLSN,
  looksLikeTimestamp,
} from '../utils/formats.js';
import { psql } from '../utils/psql.js';
import { parsePointInTime } from '../utils/point_in_time.js';
import { log } from '../log.js';

const BRANCH_FIELDS = [
  'id',
  'name',
  'primary',
  'created_at',
  'updated_at',
] as const;

const BRANCH_FIELDS_RESET = [
  'id',
  'name',
  'primary',
  'created_at',
  'last_reset_at',
] as const;

export const command = 'branches';
export const describe = 'Manage branches';
export const aliases = ['branch'];
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 branches <sub-command> [options]')
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
      async (args) => await list(args as any),
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
          'suspend-timeout': {
            describe:
              'Duration of inactivity in seconds after which the compute endpoint is\nautomatically suspended. The value `0` means use the global default.\nThe value `-1` means never suspend. The default value is `300` seconds (5 minutes).\nThe maximum value is `604800` seconds (1 week).',
            type: 'number',
            implies: 'compute',
            default: 0,
          },
          psql: {
            type: 'boolean',
            describe: 'Connect to a new branch via psql',
            default: false,
          },
        }),
      async (args) => await create(args as any),
    )
    .command(
      'reset <id|name>',
      'Reset a branch',
      (yargs) =>
        yargs.options({
          parent: {
            describe: 'Reset to a parent branch',
            type: 'boolean',
            default: false,
          },
          'preserve-under-name': {
            describe: 'Name under which to preserve the old branch',
          },
        }),
      async (args) => await reset(args as any),
    )
    .command(
      'restore <target-id|name> <source>[@(timestamp|lsn)]',
      'Restores a branch to a specific point in time\n<source> can be: ^self, ^parent, or <source-branch-id|name>',
      (yargs) =>
        yargs
          // we want to show meaningful help for the command
          // but it makes yargs to fail on parsing the command
          // so we need to fill in the missing args manually
          .middleware((args: any) => {
            args.id = args.targetId;
            args.pointInTime = args['source@(timestamp'];
          })
          .usage(
            '$0 branches restore <target-id|name> <source>[@(timestamp|lsn)]',
          )
          .options({
            'preserve-under-name': {
              describe: 'Name under which to preserve the old branch',
            },
          })
          .example([
            [
              '$0 branches restore main br-source-branch-123456',
              'Restore main to the head of the branch with id br-source-branch-123456',
            ],
            [
              '$0 branches restore main source@2021-01-01T00:00:00Z',
              'Restore main to the timestamp 2021-01-01T00:00:00Z of the source branch',
            ],
            [
              '$0 branches restore my-branch ^self@0/123456',
              'Restore my-branch to the LSN 0/123456 of the branch itself',
            ],
            [
              '$0 branches restore my-branch ^parent',
              'Restore my-branch to the head of the parent branch',
            ],
          ]),
      async (args) => await restore(args as any),
    )
    .command(
      'rename <id|name> <new-name>',
      'Rename a branch',
      (yargs) => yargs,
      async (args) => await rename(args as any),
    )
    .command(
      'set-primary <id|name>',
      'Set a branch as primary',
      (yargs) => yargs,
      async (args) => await setPrimary(args as any),
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
      async (args) => await addCompute(args as any),
    )
    .command(
      'delete <id|name>',
      'Delete a branch',
      (yargs) => yargs,
      async (args) => await deleteBranch(args as any),
    )
    .command(
      'get <id|name>',
      'Get a branch',
      (yargs) => yargs,
      async (args) => await get(args as any),
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
    psql: boolean;
    suspendTimeout: number;
    '--'?: string[];
  },
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
              suspend_timeout_seconds:
                props.suspendTimeout === 0 ? undefined : props.suspendTimeout,
            },
          ]
        : [],
    }),
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

  if (props.psql) {
    if (!data.connection_uris || !data.connection_uris?.length) {
      throw new Error(`Branch ${data.branch.id} doesn't have a connection uri`);
    }
    const connection_uri = data.connection_uris[0].connection_uri;
    const psqlArgs = props['--'];
    await psql(connection_uri, psqlArgs);
  }
};

const rename = async (
  props: ProjectScopeProps & IdOrNameProps & { newName: string },
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.updateProjectBranch(props.projectId, branchId, {
      branch: {
        name: props.newName,
      },
    }),
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const setPrimary = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.setPrimaryProjectBranch(props.projectId, branchId),
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const deleteBranch = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectBranch(props.projectId, branchId),
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const get = async (props: ProjectScopeProps & IdOrNameProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await props.apiClient.getProjectBranch(
    props.projectId,
    branchId,
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const addCompute = async (
  props: ProjectScopeProps &
    IdOrNameProps & {
      type: EndpointType;
    },
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectEndpoint(props.projectId, {
      endpoint: {
        branch_id: branchId,
        type: props.type,
      },
    }),
  );
  writer(props).end(data.endpoint, {
    fields: ['id', 'host'],
  });
};

const reset = async (
  props: ProjectScopeProps &
    IdOrNameProps & {
      parent: boolean;
      preserveUnderName?: string;
    },
) => {
  if (!props.parent) {
    throw new Error('Only resetting to parent is supported for now');
  }
  const branchId = await branchIdFromProps(props);
  const {
    data: { branch },
  } = await props.apiClient.getProjectBranch(props.projectId, branchId);
  if (!branch.parent_id) {
    throw new Error('Branch has no parent');
  }
  const { data } = await retryOnLock(() =>
    props.apiClient.request({
      method: 'POST',
      path: `/projects/${props.projectId}/branches/${branch.id}/reset`,
      body: {
        source_branch_id: branch.parent_id,
        preserve_under_name: props.preserveUnderName || undefined,
      },
    }),
  );

  const resultBranch = data.branch as Branch;

  writer(props).end(resultBranch, {
    // need to reset types until we expose reset api
    fields: BRANCH_FIELDS_RESET as any,
  });
};

const restore = async (
  props: ProjectScopeProps &
    IdOrNameProps & { pointInTime: string; preserveUnderName?: string },
) => {
  const targetBranchId = await branchIdResolve({
    branch: props.id,
    projectId: props.projectId,
    apiClient: props.apiClient,
  });

  const pointInTime = await parsePointInTime({
    pointInTime: props.pointInTime,
    targetBranchId,
    projectId: props.projectId,
    api: props.apiClient,
  });

  log.info(
    `Restoring branch ${targetBranchId} to the branch ${pointInTime.branchId} ${
      (pointInTime.tag === 'lsn' && 'LSN ' + pointInTime.lsn) ||
      (pointInTime.tag === 'timestamp' &&
        'timestamp ' + pointInTime.timestamp) ||
      'head'
    }`,
  );

  const { data } = await retryOnLock(() =>
    props.apiClient.request({
      method: 'POST',
      path: `/projects/${props.projectId}/branches/${targetBranchId}/reset`,
      body: {
        source_branch_id: pointInTime.branchId,
        preserve_under_name: props.preserveUnderName || undefined,
        ...(pointInTime.tag === 'lsn' && { source_lsn: pointInTime.lsn }),
        ...(pointInTime.tag === 'timestamp' && {
          source_timestamp: pointInTime.timestamp,
        }),
      },
    }),
  );

  const branch = data.branch as Branch;

  const writeInst = writer(props).write(branch as Branch, {
    title: 'Restored branch',
    fields: ['id', 'name', 'last_reset_at'],
  });
  if (props.preserveUnderName && branch.parent_id) {
    const { data } = await props.apiClient.getProjectBranch(
      props.projectId,
      branch.parent_id,
    );
    writeInst.write(data.branch, {
      title: 'Backup branch',
      fields: ['id', 'name'],
    });
  }
  writeInst.end();
};
