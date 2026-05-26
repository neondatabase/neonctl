import yargs from 'yargs';
import { fillSingleProject } from '../utils/enrichers.js';
import { PROJECT_ID_DESC } from '../utils/help_text.js';

import { ProjectScopeProps } from '../types.js';
import { writer } from '../writer.js';

const OPERATIONS_FIELDS = ['id', 'action', 'status', 'created_at'] as const;

export const command = 'operations';
export const describe = 'View and inspect async background operations';
export const aliases = ['operation'];
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 operations <sub-command> [options]')
    .options({
      'project-id': {
        describe: PROJECT_ID_DESC,
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'list',
      'List operations',
      (yargs) =>
        yargs.options({
          limit: {
            describe: 'Maximum number of operations to return',
            type: 'number',
          },
        }),
      (args) => list(args as any),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

export const list = async (props: ProjectScopeProps & { limit?: number }) => {
  const { data } = await props.apiClient.listProjectOperations({
    projectId: props.projectId,
    limit: props.limit,
  });
  writer(props).end(data.operations, {
    fields: OPERATIONS_FIELDS,
  });
};
