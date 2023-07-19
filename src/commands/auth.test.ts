import axios from 'axios';
import {
  beforeAll,
  describe,
  test,
  jest,
  afterAll,
  expect,
} from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';

import { startOauthServer } from '../test_utils/oauth_server';
import { OAuth2Server } from 'oauth2-mock-server';

jest.unstable_mockModule('open', () => ({
  __esModule: true,
  default: jest.fn((url: string) => {
    axios.get(url);
  }),
}));

// "open" module should be imported after mocking
const authModule = await import('./auth');

describe('auth', () => {
  let configDir = '';
  let server: OAuth2Server;

  beforeAll(async () => {
    configDir = mkdtempSync('test-config');
    server = await startOauthServer();
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true });
    server.stop();
  });

  test('should auth', async () => {
    await authModule.authFlow({
      _: ['auth'],
      apiHost: 'http://localhost:1111',
      clientId: 'test-client-id',
      configDir,
      forceAuth: true,
      oauthHost: 'http://localhost:7777',
    });

    const credentials = JSON.parse(
      readFileSync(`${configDir}/credentials.json`, 'utf-8')
    );
    expect(credentials.access_token).toEqual(expect.any(String));
    expect(credentials.refresh_token).toEqual(expect.any(String));
  });
});
