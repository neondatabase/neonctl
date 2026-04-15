import {
  NeonAuthSupportedAuthProvider,
  NeonAuthCreateIntegrationResponse,
  NeonAuthIntegration,
  NeonAuthOauthProviderId,
  NeonAuthOauthProviderType,
} from '@neondatabase/api-client';
import { isAxiosError } from 'axios';
import chalk from 'chalk';
import yargs from 'yargs';
import { retryOnLock } from '../api.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { BranchScopeProps } from '../types.js';
import { writer } from '../writer.js';

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

const OAUTH_PROVIDER_FIELDS = ['id', 'type', 'client_id'] as const;

const ALLOW_LOCALHOST_FIELDS = ['allow_localhost'] as const;

const SUPPORTED_OAUTH_PROVIDERS = [
  NeonAuthOauthProviderId.Google,
  NeonAuthOauthProviderId.Github,
  NeonAuthOauthProviderId.Vercel,
] as const;

const DOMAIN_FIELDS = ['domain'] as const;

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
            describe:
              'Permanently delete all Neon Auth data and schema from the database',
            type: 'boolean',
            default: false,
          },
        }),
      async (args) => {
        await disable(args as any);
      },
    )
    .command('oauth-provider', 'Manage OAuth providers', (yargs) => {
      return yargs
        .usage('$0 neon-auth oauth-provider <sub-command> [options]')
        .command(
          'list',
          'List OAuth providers',
          (yargs) => yargs,
          async (args) => {
            await oauthProviderList(args as any);
          },
        )
        .command(
          'add',
          'Add an OAuth provider',
          (yargs) =>
            yargs.options({
              'provider-id': {
                describe: `OAuth provider ID. Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(', ')}`,
                type: 'string',
                choices: SUPPORTED_OAUTH_PROVIDERS,
                demandOption: true,
              },
              'oauth-client-id': {
                describe:
                  "OAuth client ID from your provider app. Omit to use Neon's shared OAuth app.",
                type: 'string',
              },
              'oauth-client-secret': {
                describe:
                  "OAuth client secret from your provider app. Omit to use Neon's shared OAuth app.",
                type: 'string',
              },
            }),
          async (args) => {
            await oauthProviderAdd(args as any);
          },
        )
        .command(
          'update',
          'Update an OAuth provider',
          (yargs) =>
            yargs.options({
              'provider-id': {
                describe: `OAuth provider ID. Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(', ')}`,
                type: 'string',
                choices: SUPPORTED_OAUTH_PROVIDERS,
                demandOption: true,
              },
              'oauth-client-id': {
                describe:
                  "OAuth client ID from your provider app. Omit to use Neon's shared OAuth app.",
                type: 'string',
              },
              'oauth-client-secret': {
                describe:
                  "OAuth client secret from your provider app. Omit to use Neon's shared OAuth app.",
                type: 'string',
              },
            }),
          async (args) => {
            await oauthProviderUpdate(args as any);
          },
        )
        .command(
          'delete',
          'Delete an OAuth provider',
          (yargs) =>
            yargs.options({
              'provider-id': {
                describe: `OAuth provider ID. Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(', ')}`,
                type: 'string',
                choices: SUPPORTED_OAUTH_PROVIDERS,
                demandOption: true,
              },
            }),
          async (args) => {
            await oauthProviderDelete(args as any);
          },
        );
    })
    .command('domain', 'Manage redirect URI trusted domains', (yargs) => {
      return yargs
        .usage('$0 neon-auth domain <sub-command> [options]')
        .command(
          'list',
          'List trusted domains',
          (yargs) => yargs,
          async (args) => {
            await domainList(args as any);
          },
        )
        .command(
          'add <domain>',
          'Add a trusted domain',
          (yargs) =>
            yargs
              .usage('$0 neon-auth domain add <domain> [options]')
              .positional('domain', {
                describe: 'Domain to add',
                type: 'string',
                demandOption: true,
              }),
          async (args) => {
            await domainAdd(args as any);
          },
        )
        .command(
          'delete <domain>',
          'Delete a trusted domain',
          (yargs) =>
            yargs
              .usage('$0 neon-auth domain delete <domain> [options]')
              .positional('domain', {
                describe: 'Domain to delete',
                type: 'string',
                demandOption: true,
              }),
          async (args) => {
            await domainRemove(args as any);
          },
        )
        .command(
          'allow-localhost',
          'Manage localhost connection settings',
          (yargs) =>
            yargs
              .usage(
                '$0 neon-auth domain allow-localhost <sub-command> [options]',
              )
              .command(
                'get',
                'Get localhost connection setting',
                (yargs) => yargs,
                async (args) => {
                  await allowLocalhostGet(args as any);
                },
              )
              .command(
                'enable',
                'Allow localhost connections',
                (yargs) => yargs,
                async (args) => {
                  await allowLocalhostEnable(args as any);
                },
              )
              .command(
                'disable',
                'Restrict localhost connections',
                (yargs) => yargs,
                async (args) => {
                  await allowLocalhostDisable(args as any);
                },
              ),
        );
    })
    .command('user', 'Manage Neon Auth users', (yargs) => {
      return yargs
        .usage('$0 neon-auth user <sub-command> [options]')
        .command(
          'create',
          'Create an auth user',
          (yargs) =>
            yargs.options({
              email: {
                describe: 'User email address',
                type: 'string',
                demandOption: true,
              },
              name: {
                describe:
                  'User display name (defaults to email if not provided)',
                type: 'string',
              },
            }),
          async (args) => {
            await userCreate(args as any);
          },
        )
        .command(
          'delete <user-id>',
          'Delete an auth user',
          (yargs) => yargs,
          async (args) => {
            await userDelete(args as any);
          },
        )
        .command(
          'set-role <user-id>',
          'Set roles for an auth user',
          (yargs) =>
            yargs.options({
              roles: {
                describe: 'Roles to assign',
                type: 'string',
                array: true,
                demandOption: true,
              },
            }),
          async (args) => {
            await userSetRole(args as any);
          },
        );
    });
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
  let data: NeonAuthCreateIntegrationResponse | NeonAuthIntegration;
  let alreadyEnabled = false;
  try {
    ({ data } = await retryOnLock(() =>
      props.apiClient.createNeonAuth(props.projectId, branchId, {
        auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
        database_name: props.databaseName,
      }),
    ));
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 409) {
      alreadyEnabled = true;
      ({ data } = await props.apiClient.getNeonAuth(props.projectId, branchId));
    } else {
      throw err;
    }
  }
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data as any, { fields: INTEGRATION_RESPONSE_FIELDS });
    return;
  }

  // Access type-specific fields loosely — CREATE response has schema/table,
  // GET response (already-enabled path) has db_name instead.
  const d = data as unknown as Record<string, string | undefined>;
  printKvBlock(
    alreadyEnabled ? 'Neon Auth is already enabled' : 'Neon Auth enabled',
    [
      ['Auth Provider:', data.auth_provider],
      ...(d.db_name ? [['Database:     ', d.db_name] as [string, string]] : []),
      ['Base URL:     ', data.base_url],
      ...(d.schema_name
        ? [['Schema Name:  ', d.schema_name] as [string, string]]
        : []),
      ...(d.table_name
        ? [['Table Name:   ', d.table_name] as [string, string]]
        : []),
      ['JWKS URL:     ', data.jwks_url],
    ],
  );
  if (data.base_url) {
    process.stdout.write(
      `  ${chalk.green('Set this environment variable in your application:')}\n`,
    );
    process.stdout.write(`  NEON_AUTH_BASE_URL=${data.base_url}\n\n`);
  }
};

const status = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  let data: NeonAuthIntegration;
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

// --- OAuth provider ---

const SHARED_PROVIDER_DISCLAIMER =
  'Caution: Shared keys are created by the Neon team for development only ' +
  'and should not be used for production apps. It helps you get started, ' +
  'but will show Neon branding (logo and name) on the OAuth consent screen.';

const oauthProviderList = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.listBranchNeonAuthOauthProviders(
    props.projectId,
    branchId,
  );
  writer(props).end(data.providers, { fields: OAUTH_PROVIDER_FIELDS });
  const hasShared = data.providers.some(
    (p) => p.type === NeonAuthOauthProviderType.Shared,
  );
  if (hasShared && props.output === 'table') {
    process.stdout.write(
      `\n${chalk.yellow('Caution:')} ${SHARED_PROVIDER_DISCLAIMER.slice('Caution: '.length)}\n\n`,
    );
  }
};

const oauthProviderAdd = async (
  props: AuthBranchProps & {
    providerId: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
  },
) => {
  if (
    !(SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(props.providerId)
  ) {
    throw new Error(
      `Unsupported provider "${props.providerId}". Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(', ')}`,
    );
  }
  const branchId = await resolveBranch(props);
  let data: Awaited<
    ReturnType<typeof props.apiClient.addBranchNeonAuthOauthProvider>
  >['data'];
  try {
    ({ data } = await props.apiClient.addBranchNeonAuthOauthProvider(
      props.projectId,
      branchId,
      {
        id: props.providerId as NeonAuthOauthProviderId,
        client_id: props.oauthClientId,
        client_secret: props.oauthClientSecret,
      },
    ));
  } catch (err) {
    if (
      isAxiosError(err) &&
      (err.response?.data as { code?: string } | undefined)?.code ===
        'INVALID_SHARED_OAUTH_PROVIDER'
    ) {
      throw new Error(
        `The "${props.providerId}" provider requires your own OAuth app credentials.\n` +
          `Re-run with --oauth-client-id and --oauth-client-secret to provide them.\n` +
          `Create an OAuth app at your provider and use those credentials.`,
      );
    }
    throw err;
  }
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: OAUTH_PROVIDER_FIELDS });
  } else {
    const kv = (key: string, value: string | undefined) =>
      process.stdout.write(`  ${chalk.green(key)}  ${value ?? ''}\n`);

    process.stdout.write(`\n${chalk.green('OAuth provider added')}\n`);
    kv('ID:         ', data.id);
    kv('Type:       ', data.type);
    if (data.client_id) kv('Client ID:  ', data.client_id);
    process.stdout.write('\n');
  }
  await printCallbackInstructions(props, branchId, props.providerId);
};

const oauthProviderUpdate = async (
  props: AuthBranchProps & {
    providerId: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
  },
) => {
  if (
    !(SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(props.providerId)
  ) {
    throw new Error(
      `Unsupported provider "${props.providerId}". Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(', ')}`,
    );
  }
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.updateBranchNeonAuthOauthProvider(
    props.projectId,
    branchId,
    props.providerId as NeonAuthOauthProviderId,
    {
      client_id: props.oauthClientId,
      client_secret: props.oauthClientSecret,
    },
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: OAUTH_PROVIDER_FIELDS });
  } else {
    const kv = (key: string, value: string | undefined) =>
      process.stdout.write(`  ${chalk.green(key)}  ${value ?? ''}\n`);

    process.stdout.write(`\n${chalk.green('OAuth provider updated')}\n`);
    kv('ID:         ', data.id);
    kv('Type:       ', data.type);
    if (data.client_id) kv('Client ID:  ', data.client_id);
    process.stdout.write('\n');
  }
  await printCallbackInstructions(props, branchId, props.providerId);
};

const CALLBACK_INSTRUCTIONS: Record<
  string,
  { lead: string; urlLabel: string }
> = {
  github: {
    lead: 'Create an OAuth app in the GitHub Developer Portal and add the following authorization callback URL:',
    urlLabel: 'callback/github',
  },
  vercel: {
    lead: 'Create a Vercel App in your Vercel Dashboard and add the following authorization callback URL:',
    urlLabel: 'callback/vercel',
  },
  google: {
    lead: 'Get Google credentials by creating an OAuth client in Google Cloud Console > Credentials, and add the following authorized redirect URL:',
    urlLabel: 'callback/google',
  },
};

const printCallbackInstructions = async (
  props: AuthBranchProps,
  branchId: string,
  providerId: string,
) => {
  const instructions = CALLBACK_INSTRUCTIONS[providerId];
  if (!instructions) return;
  if (props.output === 'json' || props.output === 'yaml') return;

  let baseUrl: string | undefined;
  try {
    const { data } = await props.apiClient.getNeonAuth(
      props.projectId,
      branchId,
    );
    baseUrl = data.base_url;
  } catch {
    return;
  }
  if (!baseUrl) return;

  const callbackUrl = `${baseUrl}/${instructions.urlLabel}`;
  process.stdout.write(`\n${chalk.green(instructions.lead)}\n`);
  process.stdout.write(`  ${callbackUrl}\n\n`);
};

const oauthProviderDelete = async (
  props: AuthBranchProps & { providerId: string },
) => {
  const branchId = await resolveBranch(props);
  await props.apiClient.deleteBranchNeonAuthOauthProvider(
    props.projectId,
    branchId,
    props.providerId as NeonAuthOauthProviderId,
  );
  process.stdout.write(
    `\n${chalk.green(`OAuth provider "${props.providerId}" deleted`)}\n\n`,
  );
};

// --- Domains ---

const domainList = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.listBranchNeonAuthTrustedDomains(
    props.projectId,
    branchId,
  );
  if (data.domains.length === 0 && props.output === 'table') {
    process.stdout.write(
      `\n${chalk.green('No trusted domains are configured for this branch.')}\n\n`,
    );
    return;
  }
  writer(props).end(data.domains, { fields: DOMAIN_FIELDS });
};

const validateDomainUri = (domain: string) => {
  try {
    const url = new URL(domain);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error(
      `Invalid domain URI "${domain}". Must be a full URI including scheme, e.g. https://${domain.replace(/^https?:\/\//, '')}`,
    );
  }
};

const domainAdd = async (props: AuthBranchProps & { domain: string }) => {
  validateDomainUri(props.domain);
  const branchId = await resolveBranch(props);
  await props.apiClient.addBranchNeonAuthTrustedDomain(
    props.projectId,
    branchId,
    {
      domain: props.domain,
      auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
    },
  );
  process.stdout.write(
    `\n${chalk.green(`Domain "${props.domain}" added`)}\n\n`,
  );
};

const domainRemove = async (props: AuthBranchProps & { domain: string }) => {
  validateDomainUri(props.domain);
  const branchId = await resolveBranch(props);
  const { data: existing } =
    await props.apiClient.listBranchNeonAuthTrustedDomains(
      props.projectId,
      branchId,
    );
  if (!existing.domains.some((d) => d.domain === props.domain)) {
    throw new Error(
      `Domain "${props.domain}" is not in the trusted domains list.`,
    );
  }
  await props.apiClient.deleteBranchNeonAuthTrustedDomain(
    props.projectId,
    branchId,
    {
      auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
      domains: [{ domain: props.domain }],
    },
  );
  process.stdout.write(
    `\n${chalk.green(`Domain "${props.domain}" deleted`)}\n\n`,
  );
};

// --- Allow localhost ---

const allowLocalhostGet = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthAllowLocalhost(
    props.projectId,
    branchId,
  );
  writer(props).end(data, { fields: ALLOW_LOCALHOST_FIELDS });
};

const allowLocalhostEnable = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  await props.apiClient.updateNeonAuthAllowLocalhost(
    props.projectId,
    branchId,
    {
      allow_localhost: true,
    },
  );
  process.stdout.write(`\n${chalk.green('Localhost connections allowed')}\n\n`);
};

const allowLocalhostDisable = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  await props.apiClient.updateNeonAuthAllowLocalhost(
    props.projectId,
    branchId,
    {
      allow_localhost: false,
    },
  );
  process.stdout.write(
    `\n${chalk.green('Localhost connections restricted')}\n\n`,
  );
};

// --- User ---

const userCreate = async (
  props: AuthBranchProps & { email: string; name?: string },
) => {
  const branchId = await resolveBranch(props);
  const requestBody = {
    email: props.email,
    name: props.name ?? props.email,
  };
  const { data } = await props.apiClient.createBranchNeonAuthNewUser(
    props.projectId,
    branchId,
    requestBody,
  );
  const displayName =
    requestBody.name !== props.email ? requestBody.name : undefined;
  const kv = (key: string, value: string | undefined) =>
    process.stdout.write(`  ${chalk.green(key)}  ${value ?? ''}\n`);
  process.stdout.write(`\n${chalk.green('User created')}\n`);
  kv('ID:    ', data.id);
  kv('Email: ', requestBody.email);
  if (displayName) kv('Name:  ', displayName);
  process.stdout.write('\n');
};

const userDelete = async (props: AuthBranchProps & { userId: string }) => {
  const branchId = await resolveBranch(props);
  await props.apiClient.deleteBranchNeonAuthUser(
    props.projectId,
    branchId,
    props.userId,
  );
  process.stdout.write(
    `\n${chalk.green(`User "${props.userId}" deleted`)}\n\n`,
  );
};

const userSetRole = async (
  props: AuthBranchProps & { userId: string; roles: string[] },
) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.updateNeonAuthUserRole(
    props.projectId,
    branchId,
    props.userId,
    { roles: props.roles },
  );
  const kv = (key: string, value: string | undefined) =>
    process.stdout.write(`  ${chalk.green(key)}  ${value ?? ''}\n`);
  process.stdout.write(`\n${chalk.green('Roles updated')}\n`);
  kv('User ID: ', data.id);
  kv('Roles:   ', props.roles.join(', '));
  process.stdout.write('\n');
};
