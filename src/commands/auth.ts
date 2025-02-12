import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { TokenSet } from 'openid-client';
import yargs from 'yargs';

import { Api } from '@neondatabase/api-client';

import { auth, refreshToken } from '../auth.js';
import { log } from '../log.js';
import { getApiClient } from '../api.js';
import { isCi } from '../env.js';
import { CREDENTIALS_FILE } from '../config.js';

type AuthError = {
  code:
    | 'FILE_READ_ERROR'
    | 'PARSE_ERROR'
    | 'INVALID_FORMAT'
    | 'INVALID_TOKEN'
    | 'MISSING_TOKEN'
    | 'REFRESH_FAILED';
  message: string;
};

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
  await preserveCredentials(
    credentialsPath,
    tokenSet,
    getApiClient({
      apiKey: tokenSet.access_token || '',
      apiHost,
    }),
  );
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

export const ensureAuth = async (
  props: AuthProps & {
    apiKey: string;
    apiClient: Api<unknown>;
    help: boolean;
  },
) => {
  if (props._.length === 0 || props.help) {
    return;
  }

  if (props.apiKey || props._[0] === 'auth') {
    if (props.apiKey) {
      log.debug('using an API key to authorize requests');
    }
    props.apiClient = getApiClient({
      apiKey: props.apiKey,
      apiHost: props.apiHost,
    });
    return;
  }

  const credentialsPath = join(props.configDir, CREDENTIALS_FILE);
  if (!existsSync(credentialsPath)) {
    log.debug(
      'Credentials file %s does not exist, starting authentication',
      credentialsPath,
    );
    props.apiKey = await authFlow(props);
    props.apiClient = getApiClient({
      apiKey: props.apiKey,
      apiHost: props.apiHost,
    });
    return;
  }

  try {
    log.debug('Trying to read credentials from %s', credentialsPath);
    const contents = readCredentials(credentialsPath);
    log.debug('Credentials MD5 hash: %s', md5hash(contents));

    const tokenSet = validateTokenSet(contents);
    if (!tokenSet.expired()) {
      props.apiKey = tokenSet.access_token || 'UNKNOWN';
      props.apiClient = getApiClient({
        apiKey: props.apiKey,
        apiHost: props.apiHost,
      });
      return;
    }

    log.debug('Using refresh token to update access token');
    try {
      const refreshedTokenSet = await refreshToken(
        {
          oauthHost: props.oauthHost,
          clientId: props.clientId,
        },
        tokenSet,
      );

      props.apiKey = refreshedTokenSet.access_token || 'UNKNOWN';
      props.apiClient = getApiClient({
        apiKey: props.apiKey,
        apiHost: props.apiHost,
      });
      await preserveCredentials(
        credentialsPath,
        refreshedTokenSet,
        props.apiClient,
      );
      return;
    } catch (err) {
      const typedErr = err instanceof Error ? err : undefined;
      log.error('Failed to refresh token\n%s', typedErr?.message);
      throw new Error('Token refresh failed');
    }
  } catch (error) {
    const authError = error as AuthError;
    log.debug('re-authenticating: %s', authError.message);
    props.apiKey = await authFlow(props);
    props.apiClient = getApiClient({
      apiKey: props.apiKey,
      apiHost: props.apiHost,
    });
  }
};

const validateTokenSet = (contents: string): TokenSet => {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Failed to parse credentials file');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid credentials format');
  }

  let tokenSet;
  try {
    tokenSet = new TokenSet(parsed);
  } catch (error) {
    throw new Error(
      `Invalid token set structure: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!tokenSet.access_token) {
    throw new Error('Missing access token');
  }

  return tokenSet;
};

const readCredentials = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read credentials file: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
};

const md5hash = (s: string) => createHash('md5').update(s).digest('hex');
