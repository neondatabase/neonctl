import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { TokenSet } from 'openid-client';

import { auth, refreshToken } from '../auth';
import { log } from '../log';
import { CommonProps } from '../types';
import { apiMe } from '../api/users';
import { ApiError } from '../api/gateway';

const CREDENTIALS_FILE = 'credentials.json';

type AuthProps = {
  _: (string | number)[];
  'config-dir': string;
  'oauth-host': string;
  'api-host': string;
  'client-id': string;
};

export const authFlow = async ({
  'config-dir': configDir,
  'oauth-host': oauthHost,
  'client-id': clientId,
}: AuthProps) => {
  if (!clientId) {
    throw new Error('Missing client id');
  }
  const tokenSet = await auth({
    oauthHost: oauthHost,
    clientId: clientId,
  });

  const credentialsPath = join(configDir, CREDENTIALS_FILE);
  updateCredentialsFile(credentialsPath, JSON.stringify(tokenSet))
  log.info(`Saved credentials to ${credentialsPath}`);
  log.info('Auth complete');
  return tokenSet.access_token || '';
};

const validateToken = async (props: CommonProps) => {
  try {
    await apiMe(props);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.response.statusCode === 401) {
        throw new Error('Invalid token');
      }
    }
  }
};

// updateCredentialsFile correctly sets needed permissions for the credentials file
function updateCredentialsFile(path: string, contents: string) {
  writeFileSync(path, contents, {
    mode: 0o700,
  });
}

export const ensureAuth = async (props: AuthProps & { token: string }) => {
  if (props.token || props._[0] === 'auth') {
    return;
  }
  const credentialsPath = join(props['config-dir'], CREDENTIALS_FILE);
  if (existsSync(credentialsPath)) {
    try {
      const tokenSetContents = (await import(credentialsPath));
      const tokenSet = new TokenSet(tokenSetContents)
      if (tokenSet.expired()) {
        log.info('using refresh token to update access token');
        const refreshedTokenSet = await refreshToken({
          oauthHost: props['oauth-host'],
          clientId: props['client-id'],
        }, tokenSet)
        props.token = refreshedTokenSet.access_token || 'UNKNOWN'
        updateCredentialsFile(credentialsPath, JSON.stringify(refreshedTokenSet))
        return
      }
      const token = tokenSet.access_token || 'UNKNOWN';

      await validateToken({ apiHost: props['api-host'], token });
      props.token = token;
      return;
    } catch (e: any) {
      if (e.code !== 'ENOENT') { // not a "file does not exist" error
        throw e
      }
      props.token = await authFlow(props);
    }
  } else {
    props.token = await authFlow(props);
  }
};
