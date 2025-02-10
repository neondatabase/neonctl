import axios from 'axios';
import { vi, beforeAll, describe, afterAll, expect } from 'vitest';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { TokenSet } from 'openid-client';
import { Api } from '@neondatabase/api-client';

import { startOauthServer } from '../test_utils/oauth_server';
import { OAuth2Server } from 'oauth2-mock-server';
import { test } from '../test_utils/fixtures';
import { authFlow, ensureAuth } from './auth';

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

describe('ensureAuth', () => {
  let configDir = '';
  let oauthServer: OAuth2Server;
  let mockApiClient: Api<unknown>;

  beforeAll(async () => {
    configDir = mkdtempSync('test-config');
    oauthServer = await startOauthServer();
    mockApiClient = {} as Api<unknown>;
  });

  afterAll(async () => {
    rmSync(configDir, { recursive: true });
    await oauthServer.stop();
  });

  test('should start new auth flow when refresh token fails', async ({
    runMockServer,
  }) => {
    // Mock refresh token to fail
    vi.mock('../auth.ts', async (importOriginal) => {
      const actual = await importOriginal<object>();
      return {
        ...actual,
        refreshToken: vi.fn(() =>
          Promise.reject(new Error('AUTH_REFRESH_FAILED')),
        ),
      };
    });

    const server = await runMockServer('main');
    // Setup expired token
    const expiredTokenSet = new TokenSet({
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });

    const credentialsPath = join(configDir, 'credentials.json');
    writeFileSync(credentialsPath, JSON.stringify(expiredTokenSet), {
      mode: 0o700,
    });

    const props = {
      _: ['some-command'],
      configDir,
      oauthHost: `http://localhost:${oauthServer.address().port}`,
      clientId: 'test-client-id',
      forceAuth: true,
      apiKey: '',
      apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
      help: false,
      apiClient: mockApiClient,
    };

    await ensureAuth(props);
    expect(props.apiKey).not.toBe('expired-token');
    expect(props.apiKey).toEqual(expect.any(String));
  });
});
