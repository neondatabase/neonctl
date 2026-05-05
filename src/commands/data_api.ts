import yargs from 'yargs';
import { isAxiosError } from 'axios';

import { retryOnLock } from '../api.js';
import { BranchScopeProps } from '../types.js';
import {
  branchIdFromProps,
  fillSingleProject,
  resolveSingleDatabase,
} from '../utils/enrichers.js';
import { log } from '../log.js';
import { writer } from '../writer.js';
import type {
  DataAPICreateRequest,
  DataAPISettings,
  DataAPIUpdateRequest,
} from '@neondatabase/api-client';

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

const TOP_LEVEL_CREATE_FIELDS = [
  'auth_provider',
  'jwks_url',
  'provider_name',
  'jwt_audience',
  'add_default_grants',
  'skip_auth_schema',
] as const;

const argKey = (snake: string) => snake.replace(/_/g, '-');

const buildSettings = (
  args: Record<string, unknown>,
): DataAPISettings | undefined => {
  const settings: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    const value = args[argKey(field)];
    if (value === undefined) continue;
    if (field === 'db_schemas' && typeof value === 'string') {
      settings[field] = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      settings[field] = value;
    }
  }
  return Object.keys(settings).length > 0
    ? (settings as DataAPISettings)
    : undefined;
};

const buildCreateBody = (
  args: Record<string, unknown>,
): DataAPICreateRequest => {
  const body: Record<string, unknown> = {};
  for (const field of TOP_LEVEL_CREATE_FIELDS) {
    const value = args[argKey(field)];
    if (value !== undefined) body[field] = value;
  }
  const settings = buildSettings(args);
  if (settings) body.settings = settings;
  return body as DataAPICreateRequest;
};

const create = async (
  props: DataApiProps & Record<string, unknown>,
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const database = await resolveSingleDatabase({
    apiClient: props.apiClient,
    projectId: props.projectId,
    branchId,
    database: props.database,
  });
  const body = buildCreateBody(props);
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectBranchDataApi(
      props.projectId,
      branchId,
      database,
      body,
    ),
  );
  writer(props).end(data, { fields: ['url'] });
};

const GET_FIELDS = ['url', 'status', 'db_schemas'] as const;

const get = async (props: DataApiProps): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const database = await resolveSingleDatabase({
    apiClient: props.apiClient,
    projectId: props.projectId,
    branchId,
    database: props.database,
  });
  const { data } = await props.apiClient.getProjectBranchDataApi(
    props.projectId,
    branchId,
    database,
  );

  // Drop available_schemas from json/yaml output (not part of the public surface).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { available_schemas: _ignored, ...publicData } = data;

  // For table output, flatten db_schemas onto the top-level for column rendering.
  const tableRow = {
    url: publicData.url,
    status: publicData.status,
    db_schemas: (publicData.settings?.db_schemas ?? []).join(', '),
  };

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(publicData, { fields: GET_FIELDS });
    return;
  }
  writer(props).end(tableRow, { fields: GET_FIELDS });
};

const update = async (
  props: DataApiProps & { replace: boolean } & Record<string, unknown>,
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const database = await resolveSingleDatabase({
    apiClient: props.apiClient,
    projectId: props.projectId,
    branchId,
    database: props.database,
  });

  const userSettings = buildSettings(props);

  let settings: DataAPISettings | undefined;
  if (props.replace) {
    settings = userSettings;
  } else {
    let current: DataAPISettings | undefined;
    try {
      const { data } = await props.apiClient.getProjectBranchDataApi(
        props.projectId,
        branchId,
        database,
      );
      current = data.settings ?? undefined;
    } catch (err: unknown) {
      if (isAxiosError(err) && err.response?.status === 404) {
        throw new Error(
          `Data API is not provisioned for ${database} on branch ${branchId}. Run \`neonctl data-api create\` first.`,
        );
      }
      throw err;
    }
    if (!current) {
      throw new Error(
        `Could not read current Data API settings for ${database} on branch ${branchId}. Retry, or pass --replace to overwrite.`,
      );
    }
    settings = { ...current, ...(userSettings ?? {}) };
  }

  const body: DataAPIUpdateRequest = {};
  if (settings) body.settings = settings;

  try {
    await retryOnLock(() =>
      props.apiClient.updateProjectBranchDataApi(
        props.projectId,
        branchId,
        database,
        body,
      ),
    );
  } catch (err: unknown) {
    if (isAxiosError(err) && err.response?.status === 404) {
      throw new Error(
        `Data API is not provisioned for ${database} on branch ${branchId}. Run \`neonctl data-api create\` first.`,
      );
    }
    throw err;
  }
  log.info(`Data API settings updated for ${database} on branch ${branchId}`);
};

const deleteDataApi = async (props: DataApiProps): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const database = await resolveSingleDatabase({
    apiClient: props.apiClient,
    projectId: props.projectId,
    branchId,
    database: props.database,
  });
  await retryOnLock(() =>
    props.apiClient.deleteProjectBranchDataApi(
      props.projectId,
      branchId,
      database,
    ),
  );
  log.info(`Data API deleted for ${database} on branch ${branchId}`);
};
