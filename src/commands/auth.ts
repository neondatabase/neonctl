import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

import { auth } from '../auth';
import { listProjects } from '../api/projects';

const CREDENTIALS_FILE = 'credentials.json';

type AuthProps = {
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
  return tokenSet.access_token || '';
};

export const validateAuth = async (props: {
  token: string;
  apiHost: string;
}) => {
  try {
    await listProjects(props);
  } catch (e) {
    if ((e as Error).message.startsWith('401:')) {
      return false;
    }
    throw e;
  }
  return true;
};

export const ensureAuth = async (props: AuthProps & { token: string }) => {
  const credentialsPath = join(props.configDir, CREDENTIALS_FILE);
  if (existsSync(credentialsPath)) {
    const token = (await import(credentialsPath)).access_token;
    if (
      await validateAuth({
        ...props,
        token,
      })
    ) {
      props.token = token;
    } else {
      props.token = await authFlow(props);
    }
  } else {
    props.token = await authFlow(props);
  }
};
