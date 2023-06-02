import { join } from 'node:path';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { TokenSet } from 'openid-client';
import yargs from 'yargs';

import { Api } from '@neondatabase/api-client';

import { auth, refreshToken } from '../auth.js';
import { log } from '../log.js';
import { getApiClient } from '../api.js';

const CREDENTIALS_FILE = 'credentials.json';

type AuthProps = {
  _: (string | number)[];
  configDir: string;
  oauthHost: string;
  apiHost: string;
  clientId: string;
};

export const command = 'auth';
export const describe = 'Authenticate';
export const builder = (yargs: yargs.Argv) => yargs;
export const handler = async (args: AuthProps) => {
  await authFlow(args);
};

export const authFlow = async ({
  configDir,
  oauthHost,
  clientId,
}: AuthProps) => {
  if (!clientId) {
    throw new Error('Missing client id');
  }
  const tokenSet = await auth({
    oauthHost: oauthHost,
    clientId: clientId,
  });

  const credentialsPath = join(configDir, CREDENTIALS_FILE);
  updateCredentialsFile(credentialsPath, JSON.stringify(tokenSet));
  log.info(`Saved credentials to ${credentialsPath}`);
  log.info('Auth complete');
  return tokenSet.access_token || '';
};

// updateCredentialsFile correctly sets needed permissions for the credentials file
function updateCredentialsFile(path: string, contents: string) {
  writeFileSync(path, contents, {
    mode: 0o700,
  });
}

export const ensureAuth = async (
  props: AuthProps & { apiKey: string; apiClient: Api<unknown> }
) => {
  if (props._.length === 0) {
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
      const tokenSetContents = await JSON.parse(
        readFileSync(credentialsPath, 'utf8')
      );
      const tokenSet = new TokenSet(tokenSetContents);
      if (tokenSet.expired()) {
        log.info('using refresh token to update access token');
        const refreshedTokenSet = await refreshToken(
          {
            oauthHost: props.oauthHost,
            clientId: props.clientId,
          },
          tokenSet
        ).catch((e) => {
          log.error('failed to refresh token\n%s', e?.message);
          process.exit(1);
        });

        props.apiKey = refreshedTokenSet.access_token || 'UNKNOWN';
        props.apiClient = getApiClient({
          apiKey: props.apiKey,
          apiHost: props.apiHost,
        });
        updateCredentialsFile(
          credentialsPath,
          JSON.stringify(refreshedTokenSet)
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
