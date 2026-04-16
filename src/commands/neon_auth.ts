import { NeonAuthSupportedAuthProvider } from '@neondatabase/api-client';
import { isAxiosError } from 'axios';
import chalk from 'chalk';
import yargs from 'yargs';
import { retryOnLock } from '../api.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { BranchScopeProps } from '../types.js';
import { writer } from '../writer.js';
import { log } from '../log.js';

// Shared styled output helpers
const printKvBlock = (
  title: string,
  entries: [string, string | undefined][],
) => {
  process.stdout.write(`\n${chalk.green(title)}\n`);
  for (const [key, value] of entries) {
    process.stdout.write(`  ${chalk.green(key)}  ${value ?? ''}\n`);
  }
  process.stdout.write('\n');
};

const printMessage = (message: string) => {
  process.stdout.write(`\n${chalk.green(message)}\n\n`);
};

const INTEGRATION_RESPONSE_FIELDS = [
  'auth_provider',
  'db_name',
  'base_url',
  'schema_name',
  'table_name',
  'jwks_url',
] as const;

const INTEGRATION_STATUS_FIELDS = [
  'auth_provider',
  'branch_id',
  'db_name',
  'base_url',
  'created_at',
  'jwks_url',
] as const;

export const command = 'neon-auth';
export const describe = 'Manage Neon Auth';
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 neon-auth <sub-command> [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'enable',
      'Enable Neon Auth on a branch',
      (yargs) =>
        yargs.options({
          'database-name': {
            describe: 'Database name to use for auth data',
            type: 'string',
          },
        }),
      async (args) => {
        await enable(args as any);
      },
    )
    .command(
      'status',
      'Get Neon Auth status for a branch',
      (yargs) => yargs,
      async (args) => {
        await status(args as any);
      },
    )
    .command(
      'disable',
      'Disable Neon Auth on a branch',
      (yargs) =>
        yargs.options({
          'delete-data': {
            describe: 'Delete the neon_auth schema from the database',
            type: 'boolean',
            default: false,
          },
        }),
      async (args) => {
        await disable(args as any);
      },
    );
};

export const handler = (args: yargs.Argv) => {
  return args;
};

// --- Implementation functions ---

type AuthBranchProps = BranchScopeProps & { branchId?: string };

const resolveBranch = async (props: AuthBranchProps) => {
  return props.branchId ?? (await branchIdFromProps(props));
};

const enable = async (props: AuthBranchProps & { databaseName?: string }) => {
  const branchId = await resolveBranch(props);
  let data: Record<string, unknown>;
  try {
    const result = await retryOnLock(() =>
      props.apiClient.createNeonAuth(props.projectId, branchId, {
        auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
        database_name: props.databaseName,
      }),
    );
    data = result.data as unknown as Record<string, unknown>;
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 409) {
      log.info(
        'Neon Auth is already enabled. Fetching existing configuration.',
      );
      const existing = await props.apiClient.getNeonAuth(
        props.projectId,
        branchId,
      );
      data = existing.data as unknown as Record<string, unknown>;
    } else {
      throw err;
    }
  }
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: INTEGRATION_RESPONSE_FIELDS });
    return;
  }

  printKvBlock('Neon Auth enabled', [
    ['Auth Provider:', data.auth_provider as string],
    ['Base URL:     ', data.base_url as string],
    ['Schema Name:  ', data.schema_name as string],
    ['Table Name:   ', data.table_name as string],
    ['JWKS URL:     ', data.jwks_url as string],
  ]);
  if (typeof data.base_url === 'string') {
    process.stdout.write(
      `  ${chalk.green('Set this environment variable in your application:')}\n`,
    );
    process.stdout.write(`  NEON_AUTH_BASE_URL=${data.base_url}\n\n`);
  }
};

const status = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  let data: Awaited<ReturnType<typeof props.apiClient.getNeonAuth>>['data'];
  try {
    ({ data } = await props.apiClient.getNeonAuth(props.projectId, branchId));
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 404) {
      printMessage('Neon Auth is not configured for this branch');
      return;
    }
    throw err;
  }

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: INTEGRATION_STATUS_FIELDS });
    return;
  }

  printKvBlock('Neon Auth status', [
    ['Auth Provider:', data.auth_provider],
    ['Branch ID:    ', data.branch_id],
    ['Database:     ', data.db_name],
    ['Base URL:     ', data.base_url],
    ['Created At:   ', data.created_at],
    ['JWKS URL:     ', data.jwks_url],
  ]);
};

const disable = async (props: AuthBranchProps & { deleteData: boolean }) => {
  const branchId = await resolveBranch(props);
  await retryOnLock(() =>
    props.apiClient.disableNeonAuth(props.projectId, branchId, {
      delete_data: props.deleteData,
    }),
  );
  printMessage('Neon Auth has been disabled');
};
