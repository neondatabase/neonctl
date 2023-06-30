import { DatabaseCreateRequest } from '@neondatabase/api-client';
import yargs from 'yargs';
import { retryOnLock } from '../api.js';
import { branchIdFromProps } from '../enrichers.js';
import { databaseCreateRequest } from '../parameters.gen.js';

import { BranchScopeProps } from '../types.js';
import { commandFailHandler } from '../utils.js';
import { writer } from '../writer.js';

const DATABASE_FIELDS = ['name', 'owner_name', 'created_at'] as const;

export const command = 'databases';
export const describe = 'Manage databases';
export const aliases = ['database'];
export const builder = (argv: yargs.Argv) =>
  argv
    .demandCommand(1, '')
    .fail(commandFailHandler)
    .usage('usage: $0 databases <sub-command> [options]')
    .options({
      'project.id': {
        describe: 'Project ID',
        type: 'string',
        demandOption: true,
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
        demandOption: true,
      },
    })
    .command(
      'list',
      'List databases',
      (yargs) => yargs,
      async (args) => await list(args as any)
    )
    .command(
      'create',
      'Create a database',
      (yargs) => yargs.options(databaseCreateRequest),
      async (args) => await create(args as any)
    )
    .command(
      'delete <database>',
      'Delete a database',
      (yargs) => yargs,
      async (args) => await deleteDb(args as any)
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

export const list = async (props: BranchScopeProps) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await props.apiClient.listProjectBranchDatabases(
    props.project.id,
    branchId
  );
  writer(props).end(data.databases, {
    fields: DATABASE_FIELDS,
  });
};

export const create = async (
  props: BranchScopeProps & DatabaseCreateRequest
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectBranchDatabase(props.project.id, branchId, {
      database: props.database,
    })
  );

  writer(props).end(data.database, {
    fields: DATABASE_FIELDS,
  });
};

export const deleteDb = async (
  props: BranchScopeProps & { database: string }
) => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectBranchDatabase(
      props.project.id,
      branchId,
      props.database
    )
  );

  writer(props).end(data.database, {
    fields: DATABASE_FIELDS,
  });
};
