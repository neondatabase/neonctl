import {
  NeonAuthSupportedAuthProvider,
  NeonAuthCreateIntegrationResponse,
  NeonAuthIntegration,
  NeonAuthOauthProviderId,
  NeonAuthOauthProviderType,
  NeonAuthEmailVerificationMethod,
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

const EMAIL_PASSWORD_FIELDS = [
  'enabled',
  'email_verification_method',
  'require_email_verification',
  'auto_sign_in_after_verification',
  'send_verification_email_on_sign_up',
  'send_verification_email_on_sign_in',
  'disable_sign_up',
] as const;

const EMAIL_PROVIDER_FIELDS = [
  'type',
  'host',
  'port',
  'username',
  'sender_email',
  'sender_name',
] as const;

const ORGANIZATION_FIELDS = [
  'enabled',
  'organization_limit',
  'creator_role',
] as const;

const WEBHOOK_FIELDS = [
  'enabled',
  'webhook_url',
  'enabled_events',
  'timeout_seconds',
] as const;

const TEST_EMAIL_FIELDS = ['success', 'error_message'] as const;

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
            await domainDelete(args as any);
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
    .command('config', 'Manage Neon Auth configuration', (yargs) => {
      return yargs
        .usage('$0 neon-auth config <sub-command> [options]')
        .command(
          'email-password',
          'Manage email and password authentication settings',
          (yargs) => {
            return yargs
              .usage(
                '$0 neon-auth config email-password <sub-command> [options]',
              )
              .command(
                'get',
                'Get email and password config',
                (yargs) => yargs,
                async (args) => {
                  await emailPasswordGet(args as any);
                },
              )
              .command(
                'update',
                'Update email and password config',
                (yargs) =>
                  yargs.options({
                    enabled: {
                      describe: 'Enable email and password authentication',
                      type: 'boolean',
                    },
                    'email-verification-method': {
                      describe: 'Email verification method',
                      type: 'string',
                      choices: Object.values(NeonAuthEmailVerificationMethod),
                    },
                    'require-email-verification': {
                      describe:
                        'Require email verification before users can sign in',
                      type: 'boolean',
                    },
                    'auto-sign-in-after-verification': {
                      describe:
                        'Auto sign in users after verifying their email',
                      type: 'boolean',
                    },
                    'send-verification-email-on-sign-up': {
                      describe: 'Send verification email on sign up',
                      type: 'boolean',
                    },
                    'send-verification-email-on-sign-in': {
                      describe: 'Send verification email on sign in',
                      type: 'boolean',
                    },
                    'disable-sign-up': {
                      describe: 'Disable new user sign ups',
                      type: 'boolean',
                    },
                  }),
                async (args) => {
                  await emailPasswordUpdate(args as any);
                },
              );
          },
        )
        .command(
          'email-provider',
          'Manage email provider configuration',
          (yargs) => {
            return yargs
              .usage(
                '$0 neon-auth config email-provider <sub-command> [options]',
              )
              .command(
                'get',
                'Get email provider config',
                (yargs) => yargs,
                async (args) => {
                  await emailProviderGet(args as any);
                },
              )
              .command(
                'update',
                'Update email provider config',
                (yargs) =>
                  yargs.options({
                    type: {
                      describe: 'Email provider type',
                      type: 'string',
                      choices: ['standard', 'shared'] as const,
                      demandOption: true,
                    },
                    host: {
                      describe: 'SMTP host (required for standard)',
                      type: 'string',
                    },
                    port: {
                      describe: 'SMTP port (required for standard)',
                      type: 'number',
                    },
                    username: {
                      describe: 'SMTP username (required for standard)',
                      type: 'string',
                    },
                    password: {
                      describe: 'SMTP password (required for standard)',
                      type: 'string',
                    },
                    'sender-email': {
                      describe: 'Sender email address',
                      type: 'string',
                    },
                    'sender-name': {
                      describe: 'Sender display name',
                      type: 'string',
                    },
                  }),
                async (args) => {
                  await emailProviderUpdate(args as any);
                },
              )
              .command(
                'test',
                'Send a test email',
                (yargs) =>
                  yargs.options({
                    'recipient-email': {
                      describe: 'Email address to send test email to',
                      type: 'string',
                      demandOption: true,
                    },
                    host: {
                      describe: 'SMTP host',
                      type: 'string',
                      demandOption: true,
                    },
                    port: {
                      describe: 'SMTP port',
                      type: 'number',
                      demandOption: true,
                    },
                    username: {
                      describe: 'SMTP username',
                      type: 'string',
                      demandOption: true,
                    },
                    password: {
                      describe: 'SMTP password',
                      type: 'string',
                      demandOption: true,
                    },
                    'sender-email': {
                      describe: 'Sender email address',
                      type: 'string',
                      demandOption: true,
                    },
                    'sender-name': {
                      describe: 'Sender display name',
                      type: 'string',
                      demandOption: true,
                    },
                  }),
                async (args) => {
                  await emailProviderTest(args as any);
                },
              );
          },
        )
        .command(
          'organization',
          'Manage organization plugin settings',
          (yargs) => {
            return yargs
              .usage('$0 neon-auth config organization <sub-command> [options]')
              .command(
                'get',
                'Get organization plugin config',
                (yargs) => yargs,
                async (args) => {
                  await organizationGet(args as any);
                },
              )
              .command(
                'update',
                'Update organization plugin config',
                (yargs) =>
                  yargs.options({
                    enabled: {
                      describe: 'Enable the organization plugin',
                      type: 'boolean',
                    },
                    limit: {
                      describe:
                        'Maximum number of organizations a user can create',
                      type: 'number',
                    },
                    'creator-role': {
                      describe: 'Role assigned to organization creator',
                      type: 'string',
                      choices: ['admin', 'owner'] as const,
                    },
                  }),
                async (args) => {
                  await organizationUpdate(args as any);
                },
              );
          },
        )
        .command('webhook', 'Manage webhook configuration', (yargs) => {
          return yargs
            .usage('$0 neon-auth config webhook <sub-command> [options]')
            .command(
              'get',
              'Get webhook config',
              (yargs) => yargs,
              async (args) => {
                await webhookGet(args as any);
              },
            )
            .command(
              'update',
              'Update webhook config',
              (yargs) =>
                yargs.options({
                  enabled: {
                    describe: 'Enable webhooks',
                    type: 'boolean',
                    demandOption: true,
                  },
                  url: {
                    describe: 'Webhook endpoint URL',
                    type: 'string',
                  },
                  'enabled-events': {
                    describe: 'Events to enable',
                    type: 'string',
                    choices: [
                      'user.before_create',
                      'user.created',
                      'send.otp',
                      'send.magic_link',
                    ] as const,
                    array: true,
                  },
                  timeout: {
                    describe: 'Webhook timeout in seconds (1-10)',
                    type: 'number',
                  },
                }),
              async (args) => {
                await webhookUpdate(args as any);
              },
            );
        });
    })
    .command(
      'plugins',
      'View and update Neon Auth plugin configurations',
      (yargs) => {
        return yargs
          .usage('$0 neon-auth plugins <sub-command> [options]')
          .command(
            'list',
            'List all plugin configurations',
            (yargs) => yargs,
            async (args) => {
              await pluginsList(args as any);
            },
          )
          .command(
            'get <plugin-name>',
            'Get a specific plugin configuration',
            (yargs) =>
              yargs
                .usage('$0 neon-auth plugins get <plugin-name> [options]')
                .positional('plugin-name', {
                  describe:
                    'Plugin name (e.g. organization, email_provider, email_and_password, oauth_providers, allow_localhost)',
                  type: 'string',
                  demandOption: true,
                }),
            async (args) => {
              await pluginsGet(args as any);
            },
          )
          .command(
            'update <plugin-name>',
            'Update a plugin configuration using JSON',
            (yargs) =>
              yargs
                .usage(
                  '$0 neon-auth plugins update <plugin-name> --json \'{"key": "value"}\' [options]',
                )
                .positional('plugin-name', {
                  describe:
                    'Plugin name (e.g. organization, email_and_password, email_provider, allow_localhost, webhook)',
                  type: 'string',
                  demandOption: true,
                })
                .options({
                  json: {
                    describe: 'JSON configuration to apply',
                    type: 'string',
                    demandOption: true,
                  },
                }),
            async (args) => {
              await pluginsUpdate(args as any);
            },
          );
      },
    )
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
          (yargs) =>
            yargs
              .usage('$0 neon-auth user delete <user-id> [options]')
              .positional('user-id', {
                describe: 'ID of the user to delete',
                type: 'string',
                demandOption: true,
              }),
          async (args) => {
            await userDelete(args as any);
          },
        )
        .command(
          'set-role <user-id>',
          'Set roles for an auth user',
          (yargs) =>
            yargs
              .usage('$0 neon-auth user set-role <user-id> [options]')
              .positional('user-id', {
                describe: 'ID of the user to update',
                type: 'string',
                demandOption: true,
              })
              .options({
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
  'Shared keys are created by the Neon team for development only ' +
  'and should not be used for production apps. It helps you get started, ' +
  'but will show Neon branding (logo and name) on the OAuth consent screen.';

const oauthProviderList = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.listBranchNeonAuthOauthProviders(
    props.projectId,
    branchId,
  );
  if (data.providers.length === 0 && props.output === 'table') {
    printMessage('No OAuth providers are configured for this branch.');
    return;
  }
  writer(props).end(data.providers, { fields: OAUTH_PROVIDER_FIELDS });
  const hasShared = data.providers.some(
    (p) => p.type === NeonAuthOauthProviderType.Shared,
  );
  if (hasShared && props.output === 'table') {
    process.stdout.write(
      `\n${chalk.yellow('Caution:')} ${SHARED_PROVIDER_DISCLAIMER}\n\n`,
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
    printKvBlock('OAuth provider added', [
      ['ID:         ', data.id],
      ['Type:       ', data.type],
      ...(data.client_id
        ? [['Client ID:  ', data.client_id] as [string, string]]
        : []),
    ]);
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
  const branchId = await resolveBranch(props);
  let data: Awaited<
    ReturnType<typeof props.apiClient.updateBranchNeonAuthOauthProvider>
  >['data'];
  try {
    ({ data } = await props.apiClient.updateBranchNeonAuthOauthProvider(
      props.projectId,
      branchId,
      props.providerId as NeonAuthOauthProviderId,
      {
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
    printKvBlock('OAuth provider updated', [
      ['ID:         ', data.id],
      ['Type:       ', data.type],
      ...(data.client_id
        ? [['Client ID:  ', data.client_id] as [string, string]]
        : []),
    ]);
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

  const callbackUrl = `${baseUrl.replace(/\/$/, '')}/${instructions.urlLabel}`;
  printKvBlock(instructions.lead, [['URL:  ', callbackUrl]]);
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
  printMessage(`OAuth provider "${props.providerId}" deleted`);
};

// --- Domains ---

const domainList = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.listBranchNeonAuthTrustedDomains(
    props.projectId,
    branchId,
  );
  if (data.domains.length === 0 && props.output === 'table') {
    printMessage('No trusted domains are configured for this branch.');
    return;
  }
  writer(props).end(data.domains, { fields: DOMAIN_FIELDS });
};

const validateDomainUri = (domain: string) => {
  let url: URL;
  try {
    url = new URL(domain);
  } catch {
    throw new Error(
      `Invalid domain URI "${domain}". Must be a full URI including scheme, e.g. https://${domain}`,
    );
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(
      `Invalid domain URI "${domain}". Must use http or https scheme, e.g. https://${url.host}`,
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
  printMessage(`Domain "${props.domain}" added`);
};

const domainDelete = async (props: AuthBranchProps & { domain: string }) => {
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
  printMessage(`Domain "${props.domain}" deleted`);
};

// --- Allow localhost ---

const allowLocalhostGet = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthAllowLocalhost(
    props.projectId,
    branchId,
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: ALLOW_LOCALHOST_FIELDS });
    return;
  }
  printKvBlock('Localhost connection settings', [
    ['Allow localhost:', String(data.allow_localhost)],
  ]);
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
  printMessage('Localhost connections allowed');
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
  printMessage('Localhost connections restricted');
};

// --- Email and password ---

const printEmailPasswordEntries = (data: {
  enabled: boolean;
  email_verification_method: string;
  require_email_verification: boolean;
  auto_sign_in_after_verification: boolean;
  send_verification_email_on_sign_up: boolean;
  send_verification_email_on_sign_in: boolean;
  disable_sign_up: boolean;
}): [string, string][] => [
  ['Enabled:                    ', String(data.enabled)],
  ['Verification Method:        ', data.email_verification_method],
  ['Require Verification:       ', String(data.require_email_verification)],
  [
    'Auto Sign In After Verify:  ',
    String(data.auto_sign_in_after_verification),
  ],
  [
    'Send Email On Sign Up:      ',
    String(data.send_verification_email_on_sign_up),
  ],
  [
    'Send Email On Sign In:      ',
    String(data.send_verification_email_on_sign_in),
  ],
  ['Disable Sign Up:            ', String(data.disable_sign_up)],
];

const emailPasswordGet = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthEmailAndPasswordConfig(
    props.projectId,
    branchId,
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: EMAIL_PASSWORD_FIELDS });
    return;
  }
  printKvBlock(
    'Email & password auth configuration',
    printEmailPasswordEntries(data),
  );
};

const emailPasswordUpdate = async (
  props: AuthBranchProps & {
    enabled?: boolean;
    emailVerificationMethod?: string;
    requireEmailVerification?: boolean;
    autoSignInAfterVerification?: boolean;
    sendVerificationEmailOnSignUp?: boolean;
    sendVerificationEmailOnSignIn?: boolean;
    disableSignUp?: boolean;
  },
) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.updateNeonAuthEmailAndPasswordConfig(
    props.projectId,
    branchId,
    {
      enabled: props.enabled,
      email_verification_method:
        props.emailVerificationMethod as NeonAuthEmailVerificationMethod,
      require_email_verification: props.requireEmailVerification,
      auto_sign_in_after_verification: props.autoSignInAfterVerification,
      send_verification_email_on_sign_up: props.sendVerificationEmailOnSignUp,
      send_verification_email_on_sign_in: props.sendVerificationEmailOnSignIn,
      disable_sign_up: props.disableSignUp,
    },
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: EMAIL_PASSWORD_FIELDS });
    return;
  }
  printKvBlock(
    'Email & password auth configuration updated',
    printEmailPasswordEntries(data),
  );
};

// --- Email provider ---

const printEmailProviderEntries = (data: {
  type: string;
  host?: string;
  port?: number;
  username?: string;
  sender_email?: string;
  sender_name?: string;
}): [string, string | undefined][] => [
  ['Type:          ', data.type],
  ...(data.type === 'standard'
    ? ([
        ['Host:          ', data.host],
        ['Port:          ', data.port != null ? String(data.port) : undefined],
        ['Username:      ', data.username],
      ] as [string, string | undefined][])
    : []),
  ['Sender Email:  ', data.sender_email],
  ['Sender Name:   ', data.sender_name],
];

const emailProviderGet = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthEmailProvider(
    props.projectId,
    branchId,
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data as any, { fields: EMAIL_PROVIDER_FIELDS as any });
    return;
  }
  printKvBlock(
    'Email provider configuration',
    printEmailProviderEntries(data as any),
  );
};

const emailProviderUpdate = async (
  props: AuthBranchProps & {
    type: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    senderEmail?: string;
    senderName?: string;
  },
) => {
  if (
    props.type === 'standard' &&
    (!props.host || !props.port || !props.username || !props.password)
  ) {
    throw new Error(
      '--host, --port, --username, and --password are required for standard email provider',
    );
  }
  const warnSharedSender =
    props.type === 'shared' && (props.senderEmail || props.senderName);
  const branchId = await resolveBranch(props);
  let config: any;
  if (props.type === 'standard') {
    config = {
      type: 'standard',
      host: props.host,
      port: props.port,
      username: props.username,
      password: props.password,
      sender_email: props.senderEmail,
      sender_name: props.senderName,
    };
  } else {
    config = {
      type: 'shared',
    };
  }
  const { data } = await props.apiClient.updateNeonAuthEmailProvider(
    props.projectId,
    branchId,
    config,
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data as any, { fields: EMAIL_PROVIDER_FIELDS as any });
  } else {
    printKvBlock(
      'Email provider configuration updated',
      printEmailProviderEntries(data as any),
    );
  }
  if (warnSharedSender) {
    process.stderr.write(
      `${chalk.yellow('Warning:')} --sender-email and --sender-name are ignored for the shared email provider. ` +
        `These values only take effect with --type standard.\n\n`,
    );
  }
};

const emailProviderTest = async (
  props: AuthBranchProps & {
    recipientEmail: string;
    host: string;
    port: number;
    username: string;
    password: string;
    senderEmail: string;
    senderName: string;
  },
) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.sendNeonAuthTestEmail(
    props.projectId,
    branchId,
    {
      recipient_email: props.recipientEmail,
      host: props.host,
      port: props.port,
      username: props.username,
      password: props.password,
      sender_email: props.senderEmail,
      sender_name: props.senderName,
    },
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: TEST_EMAIL_FIELDS });
  } else if (data.success) {
    printMessage('Test email sent successfully');
  } else {
    process.stdout.write(
      `\n${chalk.red('Test email failed')}\n  ${data.error_message ?? 'Unknown error'}\n\n`,
    );
  }
};

// --- Organization plugin ---

const printOrganizationEntries = (data: {
  enabled: boolean;
  organization_limit: number;
  creator_role: string;
}): [string, string][] => [
  ['Enabled:          ', String(data.enabled)],
  ['Org Limit:        ', String(data.organization_limit)],
  ['Creator Role:     ', data.creator_role],
];

const organizationGet = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthPluginConfigs(
    props.projectId,
    branchId,
  );
  const org = data.organization;
  if (!org) {
    if (props.output === 'json' || props.output === 'yaml') {
      writer(props).end({} as any, { fields: ORGANIZATION_FIELDS as any });
      return;
    }
    printMessage('No organization plugin config found.');
    return;
  }
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(org as any, { fields: ORGANIZATION_FIELDS as any });
    return;
  }
  printKvBlock('Organization configuration', printOrganizationEntries(org));
};

const organizationUpdate = async (
  props: AuthBranchProps & {
    enabled?: boolean;
    limit?: number;
    creatorRole?: string;
  },
) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.updateNeonAuthOrganizationPlugin(
    props.projectId,
    branchId,
    {
      enabled: props.enabled,
      organization_limit: props.limit,
      creator_role: props.creatorRole as 'admin' | 'owner',
    },
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data as any, { fields: ORGANIZATION_FIELDS as any });
    return;
  }
  printKvBlock(
    'Organization configuration updated',
    printOrganizationEntries(data),
  );
};

// --- Webhook ---

const printWebhookEntries = (data: {
  enabled: boolean;
  webhook_url?: string;
  enabled_events?: string[];
  timeout_seconds?: number;
}): [string, string][] => [
  ['Enabled:        ', String(data.enabled)],
  ['URL:            ', data.webhook_url ?? ''],
  ['Events:         ', (data.enabled_events ?? []).join(', ')],
  [
    'Timeout (sec):  ',
    data.timeout_seconds != null ? String(data.timeout_seconds) : '',
  ],
];

const webhookGet = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthWebhookConfig(
    props.projectId,
    branchId,
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: WEBHOOK_FIELDS });
    return;
  }
  printKvBlock('Webhook configuration', printWebhookEntries(data));
};

const webhookUpdate = async (
  props: AuthBranchProps & {
    enabled: boolean;
    url?: string;
    enabledEvents?: string[];
    timeout?: number;
  },
) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.updateNeonAuthWebhookConfig(
    props.projectId,
    branchId,
    {
      enabled: props.enabled,
      webhook_url: props.url,
      enabled_events: props.enabledEvents as
        | (
            | 'user.before_create'
            | 'user.created'
            | 'send.otp'
            | 'send.magic_link'
          )[]
        | undefined,
      timeout_seconds: props.timeout,
    },
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, { fields: WEBHOOK_FIELDS });
    return;
  }
  printKvBlock('Webhook configuration updated', printWebhookEntries(data));
};

// --- Plugins ---

const pluginTitle = (name: string): string =>
  name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) +
  ' configuration';

const formatValue = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
};

const PLUGIN_UPDATE_METHODS: Record<
  string,
  (props: AuthBranchProps, branchId: string, data: any) => Promise<any>
> = {
  organization: (props, branchId, data) =>
    props.apiClient.updateNeonAuthOrganizationPlugin(
      props.projectId,
      branchId,
      data,
    ),
  email_and_password: (props, branchId, data) =>
    props.apiClient.updateNeonAuthEmailAndPasswordConfig(
      props.projectId,
      branchId,
      data,
    ),
  email_provider: (props, branchId, data) =>
    props.apiClient.updateNeonAuthEmailProvider(
      props.projectId,
      branchId,
      data,
    ),
  allow_localhost: (props, branchId, data) =>
    props.apiClient.updateNeonAuthAllowLocalhost(
      props.projectId,
      branchId,
      data,
    ),
  webhook: (props, branchId, data) =>
    props.apiClient.updateNeonAuthWebhookConfig(
      props.projectId,
      branchId,
      data,
    ),
};

const pluginsList = async (props: AuthBranchProps) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthPluginConfigs(
    props.projectId,
    branchId,
  );
  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data as any, {
      fields: Object.keys(data) as any,
    });
    return;
  }
  const summarize = (value: unknown): string => {
    if (value == null) return 'not configured';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value))
      return value.length === 1 ? '1 item' : `${String(value.length)} items`;
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if ('enabled' in obj) return obj.enabled ? 'enabled' : 'disabled';
      if ('type' in obj) return formatValue(obj.type);
    }
    return JSON.stringify(value);
  };
  const entries: [string, string][] = Object.entries(data).map(
    ([key, value]) => [key.padEnd(24), summarize(value)],
  );
  printKvBlock('Neon Auth plugins', entries);
};

const pluginsGet = async (props: AuthBranchProps & { pluginName: string }) => {
  const branchId = await resolveBranch(props);
  const { data } = await props.apiClient.getNeonAuthPluginConfigs(
    props.projectId,
    branchId,
  );
  const plugin = (data as any)[props.pluginName];
  if (plugin === undefined) {
    const available = Object.keys(data).join(', ');
    throw new Error(
      `Unknown plugin "${props.pluginName}". Available plugins: ${available}`,
    );
  }
  if (props.output === 'json' || props.output === 'yaml') {
    const fields =
      typeof plugin === 'object' && !Array.isArray(plugin)
        ? Object.keys(plugin)
        : [];
    writer(props).end(plugin, { fields: fields as any });
    return;
  }
  if (typeof plugin === 'object' && !Array.isArray(plugin) && plugin != null) {
    const entries: [string, string][] = Object.entries(plugin).map(([k, v]) => [
      `${k}:`.padEnd(18),
      formatValue(v),
    ]);
    printKvBlock(pluginTitle(props.pluginName), entries);
  } else if (Array.isArray(plugin)) {
    const entries: [string, string][] = plugin.map((item, i) => [
      `[${i}]:`.padEnd(18),
      typeof item === 'object' ? JSON.stringify(item) : String(item),
    ]);
    printKvBlock(pluginTitle(props.pluginName), entries);
  } else {
    printKvBlock(pluginTitle(props.pluginName), [
      ['Value:'.padEnd(18), String(plugin)],
    ]);
  }
};

const pluginsUpdate = async (
  props: AuthBranchProps & { pluginName: string; json: string },
) => {
  let parsed: any;
  try {
    parsed = JSON.parse(props.json);
  } catch {
    throw new Error('Invalid JSON. Please provide valid JSON with --json.');
  }

  const updateMethod = PLUGIN_UPDATE_METHODS[props.pluginName];
  if (!updateMethod) {
    const available = Object.keys(PLUGIN_UPDATE_METHODS).join(', ');
    throw new Error(
      `Unknown plugin "${props.pluginName}". Updatable plugins: ${available}`,
    );
  }

  const branchId = await resolveBranch(props);
  const { data } = await updateMethod(props, branchId, parsed);

  if (props.output === 'json' || props.output === 'yaml') {
    const fields =
      typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
    writer(props).end(data, { fields: fields as any });
    return;
  }
  if (typeof data === 'object' && !Array.isArray(data) && data != null) {
    const entries: [string, string][] = Object.entries(data).map(([k, v]) => [
      `${k}:`.padEnd(18),
      formatValue(v),
    ]);
    printKvBlock(`${pluginTitle(props.pluginName)} updated`, entries);
  } else {
    printKvBlock(`${pluginTitle(props.pluginName)} updated`, [
      ['Value:'.padEnd(18), String(data)],
    ]);
  }
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
  printKvBlock('User created', [
    ['ID:    ', data.id],
    ['Email: ', requestBody.email],
    ...(displayName ? [['Name:  ', displayName] as [string, string]] : []),
  ]);
};

const userDelete = async (props: AuthBranchProps & { userId: string }) => {
  const branchId = await resolveBranch(props);
  await props.apiClient.deleteBranchNeonAuthUser(
    props.projectId,
    branchId,
    props.userId,
  );
  printMessage(`User "${props.userId}" deleted`);
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
  printKvBlock('Roles updated', [
    ['User ID: ', data.id],
    ['Roles:   ', props.roles.join(', ')],
  ]);
};
