import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

import { auth } from '../auth';
import { log } from '../log';

const CREDENTIALS_FILE = 'credentials.json';

type AuthProps = {
  _: (string | number)[];
  configDir: string;
  oauthHost: string;
  apiHost: string;
  clientId?: string;
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
  writeFileSync(credentialsPath, JSON.stringify(tokenSet));
  log.info(`Saved credentials to ${credentialsPath}`);
  log.info('Auth complete');
  return tokenSet.access_token || '';
};

export const ensureAuth = async (props: AuthProps & { token: string }) => {
  if (props._[0] === 'auth') {
    return;
  }
  const credentialsPath = join(props.configDir, CREDENTIALS_FILE);
  if (existsSync(credentialsPath)) {
    try {
      const token = (await import(credentialsPath)).access_token;
      props.token = token;
    } catch (e) {
      throw new Error('Invalid credentials, please re-authenticate');
    }
  } else {
    throw new Error('No credentials found, please authenticate');
  }
};
