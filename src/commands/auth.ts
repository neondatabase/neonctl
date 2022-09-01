import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

import { auth } from '../auth';
import { log } from '../log';

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
  writeFileSync(credentialsPath, JSON.stringify(tokenSet));
  log.info(`Saved credentials to ${credentialsPath}`);
  log.info('Auth complete');
  return tokenSet.access_token || '';
};

export const ensureAuth = async (props: AuthProps & { token: string }) => {
  if (props.token || props._[0] === 'auth') {
    return;
  }
  const credentialsPath = join(props['config-dir'], CREDENTIALS_FILE);
  if (existsSync(credentialsPath)) {
    try {
      const token = (await import(credentialsPath)).access_token;
      props.token = token;
      return;
    } catch (e) {
      props.token = await authFlow(props);
    }
  } else {
    props.token = await authFlow(props);
  }
};
