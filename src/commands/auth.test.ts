import axios from 'axios';
import { vi, beforeAll, describe, afterAll, expect } from 'vitest';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';

import { startOauthServer } from '../test_utils/oauth_server';
import { OAuth2Server } from 'oauth2-mock-server';
import { test } from '../test_utils/fixtures';
import { authFlow } from './auth';

vi.mock('open', () => ({ default: vi.fn((url: string) => axios.get(url)) }));
vi.mock('../pkg.ts', () => ({ default: { version: '0.0.0' } }));

describe('auth', () => {
  let configDir = '';
  let oauthServer: OAuth2Server;

  beforeAll(async () => {
    configDir = mkdtempSync('test-config');
    oauthServer = await startOauthServer();
  });

  afterAll(async () => {
    rmSync(configDir, { recursive: true });
    await oauthServer.stop();
  });

  test('should auth', async ({ runMockServer }) => {
    const server = await runMockServer('main');
    await authFlow({
      _: ['auth'],
      apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
      clientId: 'test-client-id',
      configDir,
      forceAuth: true,
      oauthHost: `http://localhost:${oauthServer.address().port}`,
    });

    const credentials = JSON.parse(
      readFileSync(`${configDir}/credentials.json`, 'utf-8'),
    );
    expect(credentials.access_token).toEqual(expect.any(String));
    expect(credentials.refresh_token).toEqual(expect.any(String));
    expect(credentials.user_id).toEqual(expect.any(String));
  });
});
