import yargs from 'yargs';

import { BranchScopeProps } from '../types.js';
import { fillSingleProject } from '../utils/enrichers.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SETTINGS_FIELDS = [
  'db_aggregates_enabled',
  'db_anon_role',
  'db_extra_search_path',
  'db_max_rows',
  'db_schemas',
  'jwt_role_claim_key',
  'jwt_cache_max_lifetime',
  'openapi_mode',
  'server_cors_allowed_origins',
  'server_timing_enabled',
] as const;

type DataApiProps = BranchScopeProps & {
  database?: string;
};

const settingsFlags = {
  'db-aggregates-enabled': {
    type: 'boolean',
    describe: 'Enable aggregate functions in queries',
  },
  'db-anon-role': {
    type: 'string',
    describe: 'Database role used for anonymous (unauthenticated) requests',
  },
  'db-extra-search-path': {
    type: 'string',
    describe: 'Extra schemas appended to the search path',
  },
  'db-max-rows': {
    type: 'number',
    describe: 'Maximum number of rows returned by a single request',
  },
  'db-schemas': {
    type: 'string',
    describe: 'Comma-separated list of schemas exposed via the Data API',
  },
  'jwt-role-claim-key': {
    type: 'string',
    describe: 'JWT claim path used to extract the role',
  },
  'jwt-cache-max-lifetime': {
    type: 'number',
    describe: 'Maximum JWT cache lifetime in seconds',
  },
  'openapi-mode': {
    type: 'string',
    describe: 'OpenAPI mode (e.g., "ignore-privileges", "disabled")',
  },
  'server-cors-allowed-origins': {
    type: 'string',
    describe: 'CORS allowed origins',
  },
  'server-timing-enabled': {
    type: 'boolean',
    describe: 'Enable Server-Timing response headers',
  },
} as const;

export const command = 'data-api';
export const describe = 'Manage the Neon Data API for a database';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 data-api <sub-command> [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
      },
      database: {
        describe: 'Database name',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'create',
      'Provision the Neon Data API for a database',
      (yargs) =>
        yargs.options({
          'auth-provider': {
            type: 'string',
            choices: ['neon_auth', 'external'],
            describe: 'Authentication provider',
          },
          'jwks-url': {
            type: 'string',
            describe: 'URL that lists the JWKS (used with external auth)',
          },
          'provider-name': {
            type: 'string',
            describe: 'Name of the auth provider (e.g. Clerk, Stytch, Auth0)',
          },
          'jwt-audience': {
            type: 'string',
            describe: 'Expected JWT audience claim',
          },
          'add-default-grants': {
            type: 'boolean',
            describe:
              'Grant all permissions on tables in the public schema to authenticated users',
          },
          'skip-auth-schema': {
            type: 'boolean',
            describe: 'Skip creating the auth schema and RLS functions',
          },
          ...settingsFlags,
        }),
      (args) => create(args as any),
    )
    .command(
      'get',
      'Show the Neon Data API status and settings',
      (yargs) => yargs,
      (args) => get(args as any),
    )
    .command(
      'update',
      'Update Neon Data API settings (merges with current settings by default)',
      (yargs) =>
        yargs.options({
          replace: {
            type: 'boolean',
            default: false,
            describe:
              'Replace settings with only the flags provided. Omitted settings revert to server defaults.',
          },
          ...settingsFlags,
        }),
      (args) => update(args as any),
    )
    .command(
      'delete',
      'Tear down the Neon Data API for a database',
      (yargs) => yargs,
      (args) => deleteDataApi(args as any),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const create = (_props: DataApiProps): Promise<void> => {
  throw new Error('Not yet implemented');
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const get = (_props: DataApiProps): Promise<void> => {
  throw new Error('Not yet implemented');
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const update = (_props: DataApiProps & { replace: boolean }): Promise<void> => {
  throw new Error('Not yet implemented');
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const deleteDataApi = (_props: DataApiProps): Promise<void> => {
  throw new Error('Not yet implemented');
};
