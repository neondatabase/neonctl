import axios from 'axios';
import {
  beforeAll,
  describe,
  test,
  jest,
  afterAll,
  expect,
} from '@jest/globals';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { Server } from 'node:http';

import { startOauthServer } from '../test_utils/oauth_server';
import { OAuth2Server } from 'oauth2-mock-server';
import { runMockServer } from '../test_utils/mock_server';

jest.unstable_mockModule('open', () => ({
  __esModule: true,
  default: jest.fn((url: string) => {
    return axios.get(url);
  }),
}));

// "open" module should be imported after mocking
const authModule = await import('./auth');

describe('auth', () => {
  let configDir = '';
  let oauthServer: OAuth2Server;
  let mockServer: Server;

  beforeAll(async () => {
    configDir = mkdtempSync('test-config');
    oauthServer = await startOauthServer();
    mockServer = await runMockServer('main');
  });

  afterAll(async () => {
    rmSync(configDir, { recursive: true });
    await oauthServer.stop();
    await new Promise((resolve) => mockServer.close(resolve));
  });

  test('should auth', async () => {
    await authModule.authFlow({
      _: ['auth'],
      apiHost: `http://localhost:${(mockServer.address() as AddressInfo).port}`,
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
