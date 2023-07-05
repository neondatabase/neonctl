import { EndpointType } from '@neondatabase/api-client';
import yargs from 'yargs';
import { branchIdFromProps, fillSingleProject } from '../enrichers.js';
import { BranchScopeProps } from '../types.js';

export const command = 'connection-string [branch]';
export const aliases = ['cs'];
export const describe = 'Get connection string';
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('usage: $0 connection-string [branch] [options]')
    .positional('branch', {
      describe: 'Branch name or id. If ommited will use the primary branch',
      type: 'string',
    })
    .options({
      'project.id': {
        type: 'string',
        describe: 'Project ID',
      },
      'role.name': {
        type: 'string',
        describe: 'Role name',
      },
      'database.name': {
        type: 'string',
        describe: 'Database name',
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
    })
    .middleware(fillSingleProject as any);
};

export const handler = async (
  props: BranchScopeProps & {
    branch?: string;
    role: { name: string };
    database: { name: string };
    pooled: boolean;
    prisma: boolean;
  }
) => {
  const projectId = props.project.id;
  const branchId = await branchIdFromProps(props);

  const {
    data: { endpoints },
  } = await props.apiClient.listProjectBranchEndpoints(projectId, branchId);
  const endpoint = endpoints.find((e) => e.type === EndpointType.ReadWrite);
  if (!endpoint) {
    throw new Error(`No endpoint found for the branch: ${branchId}`);
  }

  const role =
    props.role?.name ||
    (await props.apiClient
      .listProjectBranchRoles(projectId, branchId)
      .then(({ data }) => {
        if (data.roles.length === 0) {
          throw new Error(`No roles found for the branch: ${branchId}`);
        }
        if (data.roles.length === 1) {
          return data.roles[0].name;
        }
        throw new Error(
          `Multiple roles found for the branch, please provide one with the --role.name option: ${data.roles
            .map((r) => r.name)
            .join(', ')}`
        );
      }));

  const database =
    props.database?.name ||
    (await props.apiClient
      .listProjectBranchDatabases(projectId, branchId)
      .then(({ data }) => {
        if (data.databases.length === 0) {
          throw new Error(`No databases found for the branch: ${branchId}`);
        }
        if (data.databases.length === 1) {
          return data.databases[0].name;
        }
        throw new Error(
          `Multiple databases found for the branch, please provide one with the --database.name option: ${data.databases}`
        );
      }));

  const { data: password } = await props.apiClient.getProjectBranchRolePassword(
    props.project.id,
    endpoint.branch_id,
    role
  );

  const host = props.pooled
    ? endpoint.host.replace(endpoint.id, `${endpoint.id}-pooler`)
    : endpoint.host;
  const connectionString = new URL(`postgres://${host}`);
  connectionString.pathname = database;
  connectionString.username = role;
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
