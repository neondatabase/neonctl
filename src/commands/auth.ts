import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import yargs from 'yargs';

import { Api } from '@neondatabase/api-client';

import { getApiClient } from '../api.js';
import { auth, refreshToken } from '../auth.js';
import { CREDENTIALS_FILE } from '../config.js';
import { isCi } from '../env.js';
import { log } from '../log.js';
import { ExtendedTokenSet } from '../types.js';
import { extendTokenSet } from '../utils/auth.js';

type AuthProps = {
  _: (string | number)[];
  configDir: string;
  oauthHost: string;
  apiHost: string;
  clientId: string;
  forceAuth: boolean;
  allowUnsafeTls?: boolean;
};

export const command = 'auth';
export const aliases = ['login'];
export const describe = 'Authenticate';
export const builder = (yargs: yargs.Argv) =>
  yargs.option('context-file', {
    hidden: true,
  });
export const handler = async (args: AuthProps) => {
  await authFlow(args);
};

export const authFlow = async ({
  configDir,
  oauthHost,
  clientId,
  apiHost,
  forceAuth,
  allowUnsafeTls,
}: AuthProps) => {
  if (!forceAuth && isCi()) {
    throw new Error('Cannot run interactive auth in CI');
  }
  const tokenSet = await auth({
    oauthHost: oauthHost,
    clientId: clientId,
    allowUnsafeTls,
  });

  const credentialsPath = join(configDir, CREDENTIALS_FILE);
  try {
    await preserveCredentials(
      credentialsPath,
      tokenSet,
      getApiClient({
        apiKey: tokenSet.access_token || '',
        apiHost,
      }),
    );
  } catch {
    log.error('Failed to save credentials');
    return '';
  }
  log.info('Auth complete');
  return tokenSet.access_token || '';
};

const preserveCredentials = async (
  path: string,
  credentials: ExtendedTokenSet,
  apiClient: Api<unknown>,
) => {
  const {
    data: { id },
  } = await apiClient.getCurrentUserInfo();
  const contents = JSON.stringify({
    // Making the linter happy by explicitly confirming we don't care about @typescript-eslint/no-misused-spread
    ...(credentials as Record<string, unknown>),
    user_id: id,
  });
  // correctly sets needed permissions for the credentials file
  writeFileSync(path, contents, {
    mode: 0o700,
  });
  log.debug('Saved credentials to %s', path);
  log.debug('Credentials MD5 hash: %s', md5hash(contents));
};

const handleExistingToken = async (
  tokenSet: ExtendedTokenSet,
  props: AuthProps,
  credentialsPath: string,
): Promise<{ apiKey: string; apiClient: Api<unknown> } | null> => {
  // Use existing access_token, if present and valid
  if (tokenSet.access_token && tokenSet.expires_at > Date.now()) {
    log.debug('Using existing valid access_token');
    const apiClient = getApiClient({
      apiKey: tokenSet.access_token,
      apiHost: props.apiHost,
    });

    return { apiKey: tokenSet.access_token, apiClient };
  }

  // Either access_token is missing or its expired. Refresh the token
  log.debug(
    tokenSet.expires_at < Date.now()
      ? 'Token is expired, attempting refresh'
      : 'Token is missing access_token, attempting refresh',
  );

  if (!tokenSet.refresh_token) {
    log.debug('TokenSet is missing refresh_token, starting authentication');
    return null;
  }

  try {
    const refreshedTokenSet = await refreshToken(
      {
        oauthHost: props.oauthHost,
        clientId: props.clientId,
        allowUnsafeTls: props.allowUnsafeTls,
      },
      tokenSet,
    );

    // Extend the token set with expires_at
    const extendedTokenSet = extendTokenSet(refreshedTokenSet);

    const apiKey = extendedTokenSet.access_token;
    const apiClient = getApiClient({
      apiKey,
      apiHost: props.apiHost,
    });

    await preserveCredentials(credentialsPath, extendedTokenSet, apiClient);
    log.debug('Token refresh successful');

    return { apiKey, apiClient };
  } catch (err: unknown) {
    const typedErr = err instanceof Error ? err : new Error('Unknown error');
    log.debug('Failed to refresh token: %s', typedErr.message);
    throw new Error('AUTH_REFRESH_FAILED');
  }
};

export const ensureAuth = async (
  props: AuthProps & {
    apiKey: string;
    apiClient: Api<unknown>;
    help: boolean;
  },
) => {
  // Skip auth for help command, no command, or init command
  if (props._.length === 0 || props.help || props._[0] === 'init') {
    return;
  }

  // Use existing API key or handle auth command
  if (props.apiKey || props._[0] === 'auth') {
    if (props.apiKey) {
      log.debug('Using an API key to authorize requests');
    }
    props.apiClient = getApiClient({
      apiKey: props.apiKey,
      apiHost: props.apiHost,
    });
    return;
  }

  const credentialsPath = join(props.configDir, CREDENTIALS_FILE);

  // Handle case when credentials file exists
  if (existsSync(credentialsPath)) {
    log.debug('Trying to read credentials from %s', credentialsPath);
    try {
      const contents = readFileSync(credentialsPath, 'utf8');
      log.debug('Credentials MD5 hash: %s', md5hash(contents));
      const tokenSet: ExtendedTokenSet = JSON.parse(contents);

      // Try to use existing token or refresh it
      const result = await handleExistingToken(
        tokenSet,
        props,
        credentialsPath,
      );
      if (result) {
        props.apiKey = result.apiKey;
        props.apiClient = result.apiClient;
        return;
      }
    } catch (err) {
      if (
        !(err instanceof Error && err.message === 'AUTH_REFRESH_FAILED') &&
        (err as { code: string }).code !== 'ENOENT' &&
        !(err instanceof SyntaxError)
      ) {
        // Throw for any errors except auth refresh failure, missing file, or invalid credentials file
        throw err;
      }

      // Fall through to new auth flow for auth failures
      log.debug('Ensure auth failed, starting authentication', err);
    }
  } else {
    log.debug(
      'Credentials file %s does not exist, starting authentication',
      credentialsPath,
    );
  }

  // Start new auth flow if no valid token exists or refresh failed
  const apiKey = await authFlow(props);
  props.apiKey = apiKey;
  props.apiClient = getApiClient({
    apiKey,
    apiHost: props.apiHost,
  });
};

/**
 * Deletes the credentials file at the specified path
 * @param configDir Directory where credentials file is stored
 */
export const deleteCredentials = (configDir: string): void => {
  const credentialsPath = join(configDir, CREDENTIALS_FILE);
  try {
    if (existsSync(credentialsPath)) {
      rmSync(credentialsPath);
      log.info('Deleted credentials from %s', credentialsPath);
    } else {
      log.debug('Credentials file %s does not exist', credentialsPath);
    }
  } catch (err) {
    const typedErr = err instanceof Error ? err : new Error('Unknown error');
    log.error('Failed to delete credentials: %s', typedErr.message);
    throw new Error('CREDENTIALS_DELETE_FAILED');
  }
};

const md5hash = (s: string) => createHash('md5').update(s).digest('hex');
