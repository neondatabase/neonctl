import yargs from 'yargs';
import { retryOnLock } from '../api.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';

import { BranchScopeProps } from '../types.js';
import { writer } from '../writer.js';

const ROLES_FIELDS = ['name', 'created_at'] as const;

export const command = 'roles';
export const describe = 'Manage roles';
export const aliases = ['role'];
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 roles <sub-command> [options]')
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
      'List roles',
      (yargs) => yargs,
      async (args) => await list(args as any),
    )
    .command(
      'create',
      'Create a role',
      (yargs) =>
        yargs.options({
          name: {
            describe: 'Role name',
            type: 'string',
            demandOption: true,
          },
        }),
      async (args) => await create(args as any),
    )
    .command(
      'delete <role>',
      'Delete a role',
      (yargs) => yargs,
      async (args) => await deleteRole(args as any),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

export const list = async (props: BranchScopeProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await props.apiClient.listProjectBranchRoles(
    props.projectId,
    branchId,
  );
  writer(props).end(data.roles, {
    fields: ROLES_FIELDS,
  });
};

export const create = async (
  props: BranchScopeProps & {
    name: string;
  },
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectBranchRole(props.projectId, branchId, {
      role: {
        name: props.name,
      },
    }),
  );
  writer(props).end(data.role, {
    fields: ROLES_FIELDS,
  });
};

export const deleteRole = async (
  props: BranchScopeProps & { role: string },
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectBranchRole(
      props.projectId,
      branchId,
      props.role,
    ),
  );
  writer(props).end(data.role, {
    fields: ROLES_FIELDS,
  });
};
