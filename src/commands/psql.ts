import { EndpointType } from '@neondatabase/api-client';
import yargs from 'yargs';
import { fillSingleProject } from '../utils/enrichers.js';
import { BranchScopeProps } from '../types.js';
import {
  handler as connectionStringHandler,
  SSL_MODES,
} from './connection_string.js';

export const command = 'psql [branch]';
export const describe = 'Connect to a database via psql';
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 psql [branch] [options] [-- psql-args]')
    .example('$0 psql', 'Connect to the default branch via psql')
    .example('$0 psql main', 'Connect to the main branch via psql')
    .example(
      '$0 psql main -- -c "SELECT 1"',
      'Run a single query against the main branch',
    )
    .example(
      '$0 psql main@2024-01-01T00:00:00Z',
      'Connect to the main branch at a specific point in time',
    )
    .positional('branch', {
      describe: `Branch name or id. Defaults to the default branch if omitted. Can be written in the point-in-time format: "branch@timestamp" or "branch@lsn"`,
      type: 'string',
    })
    .options({
      'project-id': {
        type: 'string',
        describe: 'Project ID',
      },
      'role-name': {
        type: 'string',
        describe: 'Role name',
      },
      'database-name': {
        type: 'string',
        describe: 'Database name',
      },
      pooled: {
        type: 'boolean',
        describe: 'Use pooled connection',
        default: false,
      },
      'endpoint-type': {
        type: 'string',
        choices: Object.values(EndpointType),
        describe: 'Endpoint type',
      },
      ssl: {
        type: 'string',
        choices: SSL_MODES,
        default: 'require',
        describe: 'SSL mode',
      },
      fallback: {
        type: 'boolean',
        describe: 'Force the embedded TypeScript psql fallback (for testing)',
        default: false,
        hidden: true,
      },
    })
    .middleware(fillSingleProject as any);
};

export const handler = async (
  props: BranchScopeProps & {
    branch?: string;
    roleName: string;
    databaseName: string;
    pooled: boolean;
    endpointType?: EndpointType;
    ssl: (typeof SSL_MODES)[number];
    fallback: boolean;
    '--'?: string[];
  },
) => {
  await connectionStringHandler({
    ...props,
    psql: true,
    prisma: false,
    extended: false,
  });
};
