import { join } from 'node:path';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { TokenSet } from 'openid-client';
import yargs from 'yargs';

import { Api } from '@neondatabase/api-client';

import { auth, refreshToken } from '../auth.js';
import { log } from '../log.js';
import { getApiClient } from '../api.js';
import { isCi } from '../env.js';
import { CREDENTIALS_FILE } from '../config.js';

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
  log.info(`Saved credentials to ${credentialsPath}`);
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
};

export const ensureAuth = async (
  props: AuthProps & { apiKey: string; apiClient: Api<unknown>; help: boolean },
): Promise<void> => {
  if (props._.length === 0 || props.help) {
    return;
  }
  if (props.apiKey || props._[0] === 'auth') {
    props.apiClient = getApiClient({
      apiKey: props.apiKey,
      apiHost: props.apiHost,
    });
    return;
  }
  const credentialsPath = join(props.configDir, CREDENTIALS_FILE);
  if (existsSync(credentialsPath)) {
    try {
      log.debug('checking existing credentials');
      let fileContents;
      try {
        fileContents = readFileSync(credentialsPath, 'utf8');
      } catch (error: unknown) {
        const typedError = error instanceof Error ? error : new Error('Unknown error');
        log.debug('failed to read credentials file: %s, re-authenticating', typedError.message);
        props.apiKey = await authFlow(props);
        return;
      }

      let tokenSetContents;
      try {
        tokenSetContents = JSON.parse(fileContents);
      } catch (error: unknown) {
        const typedError = error instanceof Error ? error : new Error('Unknown error');
        log.debug('failed to parse credentials file: %s, re-authenticating', typedError.message);
        props.apiKey = await authFlow(props);
        return;
      }

      // Validate required fields in token set
      if (!tokenSetContents || typeof tokenSetContents !== 'object') {
        log.debug('invalid credentials format, re-authenticating');
        props.apiKey = await authFlow(props);
        return;
      }

      let tokenSet;
      try {
        tokenSet = new TokenSet(tokenSetContents);
      } catch (error: unknown) {
        const typedError = error instanceof Error ? error : new Error('Unknown error');
        log.debug('invalid token set structure: %s, re-authenticating', typedError.message);
        props.apiKey = await authFlow(props);
        return;
      }

      if (!tokenSet.access_token) {
        log.debug('missing access token, re-authenticating');
        props.apiKey = await authFlow(props);
        return;
      }

      if (tokenSet.expired()) {
        log.debug('using refresh token to update access token');
        const refreshedTokenSet = await refreshToken(
          {
            oauthHost: props.oauthHost,
            clientId: props.clientId,
          },
          tokenSet,
        ).catch(async (err: unknown) => {
          const typedErr = err && err instanceof Error ? err : undefined;
          log.debug(
            'failed to refresh token, re-authenticating\n%s',
            typedErr?.message,
          );
          return await auth({
            oauthHost: props.oauthHost,
            clientId: props.clientId,
          });
        });

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
      }
      const token = tokenSet.access_token || 'UNKNOWN';

      props.apiKey = token;
      props.apiClient = getApiClient({
        apiKey: props.apiKey,
        apiHost: props.apiHost,
      });
      return;
    } catch (e) {
      if ((e as { code: string }).code !== 'ENOENT') {
        // not a "file does not exist" error
        throw e;
      }
      props.apiKey = await authFlow(props);
    }
  } else {
    props.apiKey = await authFlow(props);
  }
  props.apiClient = getApiClient({
    apiKey: props.apiKey,
    apiHost: props.apiHost,
  });
};
