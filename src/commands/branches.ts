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
import { parseSchemaDiffParams, schemaDiff } from './schema_diff.js';
import { getComputeUnits } from '../utils/compute_units.js';

export const BRANCH_FIELDS: readonly (keyof Branch)[] = [
  'id',
  'name',
  'default',
  'current_state',
  'created_at',
];

const BRANCH_FIELDS_RESET: readonly (keyof Branch)[] = [
  'id',
  'name',
  'default',
  'current_state',
  'created_at',
  'last_reset_at',
];

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
      (args) => list(args as any),
    )
    .command(
      'create',
      'Create a branch',
      (yargs) =>
        yargs.options({
          name: branchCreateRequest['branch.name'],
          parent: {
            describe:
              'Parent branch name or id or timestamp or LSN. Defaults to the default branch',
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
          cu: {
            describe:
              'The number of Compute Units. Could be a fixed size (e.g. "2") or a range delimited by a dash (e.g. "0.5-3").',
            type: 'string',
            implies: 'compute',
          },
          psql: {
            type: 'boolean',
            describe: 'Connect to a new branch via psql',
            default: false,
          },
          annotation: {
            type: 'string',
            hidden: true,
            default: '{}',
          },
        }),
      (args) => create(args as any),
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
      (args) => reset(args as any),
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
              'Restores main to the head of the branch with id br-source-branch-123456',
            ],
            [
              '$0 branches restore main source@2021-01-01T00:00:00Z',
              'Restores main to the timestamp 2021-01-01T00:00:00Z of the source branch',
            ],
            [
              '$0 branches restore my-branch ^self@0/123456',
              'Restores my-branch to the LSN 0/123456 from its own history',
            ],
            [
              '$0 branches restore my-branch ^parent',
              'Restore my-branch to the head of its parent branch',
            ],
          ]),
      (args) => restore(args as any),
    )
    .command(
      'rename <id|name> <new-name>',
      'Rename a branch',
      (yargs) => yargs,
      (args) => rename(args as any),
    )
    .command(
      'set-default <id|name>',
      'Set a branch as default',
      (yargs) => yargs,
      (args) => setDefault(args as any),
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
          cu: {
            describe:
              'The number of Compute Units. Could be a fixed size (e.g. "2") or a range delimited by a dash (e.g. "0.5-3").',
            type: 'string',
          },
        }),
      (args) => addCompute(args as any),
    )
    .command(
      'delete <id|name>',
      'Delete a branch',
      (yargs) => yargs,
      (args) => deleteBranch(args as any),
    )
    .command(
      'get <id|name>',
      'Get a branch',
      (yargs) => yargs,
      (args) => get(args as any),
    )
    .command({
      command: 'schema-diff [base-branch] [compare-source[@(timestamp|lsn)]]',
      aliases: ['sd'],
      describe:
        "Compare the latest schemas of any two branches, or compare a branch to its own or another branch's history.",
      builder: (yargs) => {
        return yargs
          .middleware(
            (args: any) =>
              (args.compareSource = args['compare-source@(timestamp']),
          )
          .middleware(parseSchemaDiffParams as any)
          .options({
            database: {
              alias: 'db',
              type: 'string',
              description:
                'Name of the database for which the schema comparison is performed',
            },
          })
          .example([
            [
              '$0 branches schema-diff main br-compare-branch-123456',
              'Compares the main branch to the head of the branch with ID br-compare-branch-123456',
            ],
            [
              '$0 branches schema-diff main compare@2024-06-01T00:00:00Z',
              'Compares the main branch to the state of the compare branch at timestamp 2024-06-01T00:00:00.000Z',
            ],
            [
              '$0 branches schema-diff my-branch ^self@0/123456',
              'Compares my-branch to LSN 0/123456 from its own history',
            ],
            [
              '$0 branches schema-diff my-branch ^parent',
              'Compares my-branch to the head of its parent branch',
            ],
            [
              '$0 branches schema-diff',
              "If a branch is specified in 'set-context', compares this branch to its parent. Otherwise, compares the default branch to its parent.",
            ],
          ]);
      },

      handler: (args) => schemaDiff(args as any),
    });

export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: ProjectScopeProps) => {
  const { data } = await props.apiClient.listProjectBranches({
    projectId: props.projectId,
  });
  writer(props).end(data.branches, {
    fields: BRANCH_FIELDS,
  });
};

const create = async (
  props: ProjectScopeProps & {
    name: string;
    compute: boolean;
    cu?: string;
    parent?: string;
    type: EndpointType;
    psql: boolean;
    suspendTimeout: number;
    annotation?: string;
    '--'?: string[];
  },
) => {
  const branches = await props.apiClient
    .listProjectBranches({ projectId: props.projectId })
    .then(({ data }) => data.branches);

  const parentProps = (() => {
    if (!props.parent) {
      const branch = branches.find((b) => b.default);
      if (!branch) {
        throw new Error('No default branch found');
      }
      return { parent_id: branch.id };
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

    const branch = branches.find((b) => b.name === props.parent);
    if (!branch) {
      throw new Error(`Branch ${props.parent} not found`);
    }
    return { parent_id: branch.id };
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
              ...(props.cu ? getComputeUnits(props.cu) : undefined),
            },
          ]
        : [],
      annotation_value: props.annotation
        ? JSON.parse(props.annotation)
        : undefined,
    }),
  );

  const parent = branches.find((b) => b.id === data.branch.parent_id);
  if (parent?.protected) {
    log.warning(
      'The parent branch is protected; a unique role password has been generated for the new branch.',
    );
  }

  const out = writer(props);

  out.write(data.branch, {
    fields: BRANCH_FIELDS,
    title: 'branch',
    emptyMessage: 'No branches have been found.',
  });

  if (data.endpoints?.length > 0) {
    out.write(data.endpoints, {
      fields: ['id', 'created_at'],
      title: 'endpoints',
      emptyMessage: 'No endpoints have been found.',
    });
  }
  if (data.connection_uris?.length) {
    out.write(data.connection_uris, {
      fields: ['connection_uri'],
      title: 'connection_uris',
      emptyMessage: 'No connection uris have been found',
    });
  }
  out.end();

  if (props.psql) {
    if (!data.connection_uris?.length) {
      throw new Error(`Branch ${data.branch.id} doesn't have a connection uri`);
    }
    const connection_uri = data.connection_uris[0].connection_uri;
    const psqlArgs = props['--'];
    await psql(connection_uri, psqlArgs);
  }
};

const rename = async (
  props: ProjectScopeProps &
    IdOrNameProps & { newName: string; branchId: string },
) => {
  props.branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.updateProjectBranch(props.projectId, props.branchId, {
      branch: {
        name: props.newName,
      },
    }),
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const setDefault = async (
  props: ProjectScopeProps & IdOrNameProps & { branchId: string },
) => {
  props.branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.setDefaultProjectBranch(props.projectId, props.branchId),
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const deleteBranch = async (
  props: ProjectScopeProps & IdOrNameProps & { branchId: string },
) => {
  props.branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectBranch(props.projectId, props.branchId),
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const get = async (
  props: ProjectScopeProps & IdOrNameProps & { branchId: string },
) => {
  props.branchId = await branchIdFromProps(props);
  const { data } = await props.apiClient.getProjectBranch(
    props.projectId,
    props.branchId,
  );
  writer(props).end(data.branch, {
    fields: BRANCH_FIELDS,
  });
};

const addCompute = async (
  props: ProjectScopeProps &
    IdOrNameProps & {
      type: EndpointType;
      cu?: string;
    } & { branchId: string },
) => {
  props.branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectEndpoint(props.projectId, {
      endpoint: {
        branch_id: props.branchId,
        type: props.type,
        ...(props.cu ? getComputeUnits(props.cu) : undefined),
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
    } & { branchId: string },
) => {
  if (!props.parent) {
    throw new Error('Only resetting to parent is supported for now');
  }
  props.branchId = await branchIdFromProps(props);
  const {
    data: {
      branch: { parent_id },
    },
  } = await props.apiClient.getProjectBranch(props.projectId, props.branchId);
  if (!parent_id) {
    throw new Error('Branch has no parent');
  }
  const { data } = await retryOnLock(() =>
    props.apiClient.restoreProjectBranch(props.projectId, props.branchId, {
      source_branch_id: parent_id,
      preserve_under_name: props.preserveUnderName || undefined,
    }),
  );

  writer(props).end(data.branch, {
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
    props.apiClient.restoreProjectBranch(props.projectId, targetBranchId, {
      source_branch_id: pointInTime.branchId,
      preserve_under_name: props.preserveUnderName || undefined,
      ...(pointInTime.tag === 'lsn' && { source_lsn: pointInTime.lsn }),
      ...(pointInTime.tag === 'timestamp' && {
        source_timestamp: pointInTime.timestamp,
      }),
    }),
  );

  const writeInst = writer(props).write(data.branch, {
    title: 'Restored branch',
    fields: ['id', 'name', 'last_reset_at'],
    emptyMessage: 'No branches have been restored.',
  });
  const parentId = data.branch.parent_id;
  if (props.preserveUnderName && parentId) {
    const { data } = await props.apiClient.getProjectBranch(
      props.projectId,
      parentId,
    );
    writeInst.write(data.branch, {
      title: 'Backup branch',
      fields: ['id', 'name'],
      emptyMessage: 'Backup branch has not been found.',
    });
  }
  writeInst.end();
};
