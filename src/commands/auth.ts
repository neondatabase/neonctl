import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TokenSet } from 'openid-client';
import yargs from 'yargs';

import { Api } from '@neondatabase/api-client';

import { getApiClient } from '../api.js';
import { auth, refreshToken } from '../auth.js';
import { CREDENTIALS_FILE } from '../config.js';
import { isCi } from '../env.js';
import { log } from '../log.js';

type AuthProps = {
  _: (string | number)[];
  configDir: string;
  oauthHost: string;
  apiHost: string;
  clientId: string;
  forceAuth: boolean;
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
}: AuthProps) => {
  if (!forceAuth && isCi()) {
    throw new Error('Cannot run interactive auth in CI');
  }
  const tokenSet = await auth({
    oauthHost: oauthHost,
    clientId: clientId,
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
  }
  log.info('Auth complete');
  return tokenSet.access_token || '';
};

const preserveCredentials = async (
  path: string,
  credentials: TokenSet,
  apiClient: Api<unknown>,
) => {
  const {
    data: { id },
  } = await apiClient.getCurrentUserInfo();
  const contents = JSON.stringify({
    ...credentials,
    user_id: id,
  });
  // correctly sets needed permissions for the credentials file
  writeFileSync(path, contents, {
    mode: 0o700,
  });
  log.info('Saved credentials to %s', path);
  log.debug('Credentials MD5 hash: %s', md5hash(contents));
};

type TokenSetContents = {
  user_id: string;
} & TokenSet;

const isCompleteTokenSet = (
  tokenSet: TokenSet,
): tokenSet is Required<TokenSet> => {
  return !!(
    tokenSet.access_token &&
    tokenSet.refresh_token &&
    tokenSet.expires_at
  );
};

const handleExistingToken = async (
  tokenSet: TokenSet,
  props: AuthProps,
  credentialsPath: string,
): Promise<{ apiKey: string; apiClient: Api<unknown> } | null> => {
  // Use existing access_token, if present and valid
  if (!!tokenSet.access_token && !tokenSet.expired()) {
    const apiClient = getApiClient({
      apiKey: tokenSet.access_token,
      apiHost: props.apiHost,
    });

    return { apiKey: tokenSet.access_token, apiClient };
  }

  // Either access_token is missing or its expired. Refresh the token
  log.debug(
    tokenSet.expired()
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
      },
      tokenSet,
    );

    if (!isCompleteTokenSet(refreshedTokenSet)) {
      log.debug('Refreshed token is invalid or missing access_token');
      return null;
    }

    const apiKey = refreshedTokenSet.access_token;
    const apiClient = getApiClient({
      apiKey,
      apiHost: props.apiHost,
    });

    await preserveCredentials(credentialsPath, refreshedTokenSet, apiClient);
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
  // Skip auth for help command or no command
  if (props._.length === 0 || props.help) {
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
      const tokenSetContents: TokenSetContents = JSON.parse(contents);
      const tokenSet = new TokenSet(tokenSetContents);

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

const md5hash = (s: string) => createHash('md5').update(s).digest('hex');
