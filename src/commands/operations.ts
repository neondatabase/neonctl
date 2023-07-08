import yargs from 'yargs';
import { fillSingleProject } from '../utils/enrichers.js';

import { ProjectScopeProps } from '../types.js';
import { commandFailHandler } from '../utils/middlewares.js';
import { writer } from '../writer.js';

const OPERATIONS_FIELDS = ['id', 'action', 'status', 'created_at'] as const;

export const command = 'operations';
export const describe = 'Manage operations';
export const aliases = ['operation'];
export const builder = (argv: yargs.Argv) =>
  argv
    .demandCommand(1, '')
    .fail(commandFailHandler)
    .usage('usage: $0 operations <sub-command> [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'list',
      'List operations',
      (yargs) => yargs,
      async (args) => await list(args as any)
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

export const list = async (props: ProjectScopeProps & { limit: number }) => {
  const { data } = await props.apiClient.listProjectOperations({
    projectId: props.projectId,
    limit: props.limit,
  });
  writer(props).end(data.operations, {
    fields: OPERATIONS_FIELDS,
  });
};
