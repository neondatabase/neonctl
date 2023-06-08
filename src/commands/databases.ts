import { DatabaseCreateRequest } from '@neondatabase/api-client';
import yargs from 'yargs';
import { databaseCreateRequest } from '../parameters.gen.js';

import { BranchScopeProps } from '../types.js';
import { commandFailHandler } from '../utils.js';
import { writer } from '../writer.js';

const DATABASE_FIELDS = ['name', 'owner_name'] as const;

export const command = 'databases';
export const describe = 'Manage databases';
export const builder = (argv: yargs.Argv) =>
  argv
    .demandCommand(1, '')
    .fail(commandFailHandler)
    .usage('usage: $0 databases <cmd> [args]')
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
      'delete',
      'Delete a database',
      (yargs) =>
        yargs.options({
          'database.name': {
            describe: 'Database name',
            type: 'string',
            demandOption: true,
          },
        }),
      async (args) => await deleteDb(args as any)
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

export const list = async (props: BranchScopeProps) => {
  const { data } = await props.apiClient.listProjectBranchDatabases(
    props.project.id,
    props.branch.id
  );
  writer(props).end(data.databases, {
    fields: DATABASE_FIELDS,
  });
};

export const create = async (
  props: BranchScopeProps & DatabaseCreateRequest
) => {
  const { data } = await props.apiClient.createProjectBranchDatabase(
    props.project.id,
    props.branch.id,
    {
      database: props.database,
    }
  );
  writer(props).end(data.database, {
    fields: DATABASE_FIELDS,
  });
};

export const deleteDb = async (
  props: BranchScopeProps & { database: { name: string } }
) => {
  const { data } = await props.apiClient.deleteProjectBranchDatabase(
    props.project.id,
    props.branch.id,
    props.database.name
  );
  writer(props).end(data.database, {
    fields: DATABASE_FIELDS,
  });
};
