import { EndpointType } from '@neondatabase/api-client';
import yargs from 'yargs';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { BranchScopeProps } from '../types.js';
import { writer } from '../writer.js';
import { psql } from '../utils/psql.js';
import { parsePITBranch } from '../utils/point_in_time.js';

const SSL_MODES = ['require', 'verify-ca', 'verify-full', 'omit'] as const;

export const command = 'connection-string [branch]';
export const aliases = ['cs'];
export const describe = 'Get connection string';
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 connection-string [branch] [options]')
    .example('$0 cs main', 'Get connection string for the main branch')
    .example(
      '$0 cs main@2024-01-01T00:00:00Z',
      'Get connection string for the main branch at a specific point in time',
    )
    .example(
      '$0 cs main@0/234235',
      'Get connection string for the main branch at a specific LSN',
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
      prisma: {
        type: 'boolean',
        describe: 'Use connection string for Prisma setup',
        default: false,
      },
      'endpoint-type': {
        type: 'string',
        choices: Object.values(EndpointType),
        describe: 'Endpoint type',
      },
      extended: {
        type: 'boolean',
        describe: 'Show extended information',
      },
      psql: {
        type: 'boolean',
        describe: 'Connect to a database via psql using connection string',
        default: false,
      },
      ssl: {
        type: 'string',
        choices: SSL_MODES,
        default: 'require',
        describe: 'SSL mode',
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
    prisma: boolean;
    extended: boolean;
    endpointType?: EndpointType;
    psql: boolean;
    ssl: (typeof SSL_MODES)[number];
    '--'?: string[];
  },
) => {
  const projectId = props.projectId;
  const parsedPIT = props.branch
    ? parsePITBranch(props.branch)
    : ({ tag: 'head', branch: '' } as const);
  if (props.branch) {
    props.branch = parsedPIT.branch;
  }
  const branchId = await branchIdFromProps(props);

  const {
    data: { endpoints },
  } = await props.apiClient.listProjectBranchEndpoints(projectId, branchId);
  const matchEndpointType = props.endpointType ?? EndpointType.ReadWrite;
  let endpoint = endpoints.find((e) => e.type === matchEndpointType);
  if (!endpoint && props.endpointType == null) {
    endpoint = endpoints[0];
  }
  if (!endpoint) {
    throw new Error(
      `No ${
        props.endpointType ?? ''
      } endpoint found for the branch: ${branchId}`,
    );
  }

  const role =
    props.roleName ||
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
          `Multiple roles found for the branch, please provide one with the --role-name option: ${data.roles
            .map((r) => r.name)
            .join(', ')}`,
        );
      }));

  const {
    data: { databases: branchDatabases },
  } = await props.apiClient.listProjectBranchDatabases(projectId, branchId);

  const database =
    props.databaseName ||
    (() => {
      if (branchDatabases.length === 0) {
        throw new Error(`No databases found for the branch: ${branchId}`);
      }
      if (branchDatabases.length === 1) {
        return branchDatabases[0].name;
      }
      throw new Error(
        `Multiple databases found for the branch, please provide one with the --database-name option: ${branchDatabases
          .map((d) => d.name)
          .join(', ')}`,
      );
    })();

  if (!branchDatabases.find((d) => d.name === database)) {
    throw new Error(`Database not found: ${database}`);
  }

  const {
    data: { password },
  } = await props.apiClient.getProjectBranchRolePassword(
    props.projectId,
    endpoint.branch_id,
    role,
  );

  let host = props.pooled
    ? endpoint.host.replace(endpoint.id, `${endpoint.id}-pooler`)
    : endpoint.host;
  if (parsedPIT.tag !== 'head') {
    host = endpoint.host.replace(endpoint.id, endpoint.branch_id);
  }
  const connectionString = new URL(`postgresql://${host}`);
  connectionString.pathname = database;
  connectionString.username = role;
  connectionString.password = password;

  if (props.prisma) {
    connectionString.searchParams.set('connect_timeout', '30');
    if (props.pooled) {
      connectionString.searchParams.set('pool_timeout', '30');
      connectionString.searchParams.set('pgbouncer', 'true');
    }
  }

  if (props.ssl !== 'omit') {
    connectionString.searchParams.set('sslmode', props.ssl);
  }

  if (parsedPIT.tag === 'lsn') {
    connectionString.searchParams.set('options', `neon_lsn:${parsedPIT.lsn}`);
  } else if (parsedPIT.tag === 'timestamp') {
    connectionString.searchParams.set(
      'options',
      `neon_timestamp:${parsedPIT.timestamp}`,
    );
  }

  if (props.psql) {
    const psqlArgs = props['--'];
    await psql(connectionString.toString(), psqlArgs);
  } else if (props.extended) {
    writer(props).end(
      {
        connection_string: connectionString.toString(),
        host,
        role,
        password,
        database,
        options: connectionString.searchParams.toString(),
      },
      { fields: ['host', 'role', 'password', 'database'] },
    );
  } else {
    process.stdout.write(connectionString.toString() + '\n');
  }
};
