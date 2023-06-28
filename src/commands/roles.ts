import { RoleCreateRequest } from '@neondatabase/api-client';
import yargs from 'yargs';
import { retryOnLock } from '../api.js';
import { roleCreateRequest } from '../parameters.gen.js';

import { BranchScopeProps } from '../types.js';
import { commandFailHandler } from '../utils.js';
import { writer } from '../writer.js';

const ROLES_FIELDS = ['name', 'created_at'] as const;

export const command = 'roles';
export const describe = 'Manage roles';
export const aliases = ['role'];
export const builder = (argv: yargs.Argv) =>
  argv
    .demandCommand(1, '')
    .fail(commandFailHandler)
    .usage('usage: $0 roles <sub-command> [options]')
    .options({
      'project.id': {
        describe: 'Project ID',
        type: 'string',
        demandOption: true,
      },
      'branch.id': {
        describe: 'Branch ID',
        type: 'string',
        demandOption: true,
      },
    })
    .command(
      'list',
      'List roles',
      (yargs) => yargs,
      async (args) => await list(args as any)
    )
    .command(
      'create',
      'Create a role',
      (yargs) => yargs.options(roleCreateRequest),
      async (args) => await create(args as any)
    )
    .command(
      'delete <role>',
      'Delete a role',
      (yargs) => yargs,
      async (args) => await deleteRole(args as any)
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

export const list = async (props: BranchScopeProps) => {
  const { data } = await props.apiClient.listProjectBranchRoles(
    props.project.id,
    props.branch.id
  );
  writer(props).end(data.roles, {
    fields: ROLES_FIELDS,
  });
};

export const create = async (props: BranchScopeProps & RoleCreateRequest) => {
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectBranchRole(props.project.id, props.branch.id, {
      role: props.role,
    })
  );
  writer(props).end(data.role, {
    fields: ROLES_FIELDS,
  });
};

export const deleteRole = async (
  props: BranchScopeProps & { role: string }
) => {
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectBranchRole(
      props.project.id,
      props.branch.id,
      props.role
    )
  );
  writer(props).end(data.role, {
    fields: ROLES_FIELDS,
  });
};
