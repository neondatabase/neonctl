import { EndpointType } from '@neondatabase/api-client';
import yargs from 'yargs';
import { branchIdFromProps } from '../enrichers.js';
import { BranchScopeProps } from '../types.js';

export const command = 'connection-string <branch>';
export const aliases = ['cs'];
export const describe = 'Get connection string';
export const builder = (argv: yargs.Argv) => {
  return argv.usage('usage: $0 connection-string <branch> [options]').options({
    'project.id': {
      type: 'string',
      describe: 'Project ID',
      demandOption: true,
    },
    'role.name': {
      type: 'string',
      describe: 'Role name',
      demandOption: true,
    },
    'database.name': {
      type: 'string',
      describe: 'Database name',
      demandOption: true,
    },
    pooled: {
      type: 'boolean',
      describe: 'Use pooled connection',
      default: false,
    },
    prisma: {
      type: 'boolean',
      describe: 'Use connection string for Prisma setup',
      default: false,
    },
  });
};

export const handler = async (
  props: BranchScopeProps & {
    role: { name: string };
    database: { name: string };
    pooled: boolean;
    prisma: boolean;
  }
) => {
  const branchId = await branchIdFromProps(props);
  const {
    data: { endpoints },
  } = await props.apiClient.listProjectBranchEndpoints(
    props.project.id,
    branchId
  );
  const endpoint = endpoints.find((e) => e.type === EndpointType.ReadWrite);
  if (!endpoint) {
    throw new Error(`No endpoint found for the branch: ${branchId}`);
  }

  const { data: password } = await props.apiClient.getProjectBranchRolePassword(
    props.project.id,
    endpoint.branch_id,
    props.role.name
  );

  const host = props.pooled
    ? endpoint.host.replace(endpoint.id, `${endpoint.id}-pooler`)
    : endpoint.host;
  const connectionString = new URL(`postgres://${host}`);
  connectionString.pathname = props.database.name;
  connectionString.username = props.role.name;
  connectionString.password = password.password;

  if (props.prisma) {
    connectionString.searchParams.set('connect_timeout', '30');
    if (props.pooled) {
      connectionString.searchParams.set('pool_timeout', '30');
      connectionString.searchParams.set('pgbouncer', 'true');
    }
  }

  process.stdout.write(connectionString.toString());
};
