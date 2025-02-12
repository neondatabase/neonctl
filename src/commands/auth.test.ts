import { Api } from '@neondatabase/api-client';
import axios from 'axios';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { TokenSet } from 'openid-client';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import { OAuth2Server } from 'oauth2-mock-server';
import * as authModule from '../auth';
import { test } from '../test_utils/fixtures';
import { startOauthServer } from '../test_utils/oauth_server';
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
  let authSpy: any;
  let refreshTokenSpy: any;

  beforeAll(async () => {
    configDir = mkdtempSync('test-config');
    oauthServer = await startOauthServer();
    mockApiClient = {} as Api<unknown>;
    authSpy = vi.spyOn(authModule, 'auth');
    refreshTokenSpy = vi.spyOn(authModule, 'refreshToken');
  });

  afterAll(async () => {
    rmSync(configDir, { recursive: true });
    await oauthServer.stop();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    authSpy.mockClear();
    refreshTokenSpy.mockClear();
  });

  const setupTestProps = (server: any) => ({
    _: ['some-command'],
    configDir,
    oauthHost: `http://localhost:${oauthServer.address().port}`,
    clientId: 'test-client-id',
    forceAuth: true,
    apiKey: '',
    apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
    help: false,
    apiClient: mockApiClient,
  });

  test('should start new auth flow when refresh token fails', async ({
    runMockServer,
  }) => {
    refreshTokenSpy.mockImplementationOnce(() =>
      Promise.reject(new Error('AUTH_REFRESH_FAILED')),
    );

    authSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new TokenSet({
          access_token: 'new-auth-token',
          refresh_token: 'new-refresh-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );

    const server = await runMockServer('main');
    const expiredTokenSet = new TokenSet({
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });

    writeFileSync(
      join(configDir, 'credentials.json'),
      JSON.stringify(expiredTokenSet),
      { mode: 0o700 },
    );

    const props = setupTestProps(server);
    await ensureAuth(props);

    expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
    expect(authSpy).toHaveBeenCalledTimes(1);
    expect(props.apiKey).toBe('new-auth-token');
  });

  test('should try refresh when token is missing access_token but has refresh_token', async ({
    runMockServer,
  }) => {
    const server = await runMockServer('main');
    const tokenWithoutAccess = new TokenSet({
      refresh_token: 'refresh-token',
    });

    writeFileSync(
      join(configDir, 'credentials.json'),
      JSON.stringify(tokenWithoutAccess),
      { mode: 0o700 },
    );

    refreshTokenSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new TokenSet({
          access_token: 'refreshed-token',
          refresh_token: 'new-refresh-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );

    const props = setupTestProps(server);
    await ensureAuth(props);

    expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
    expect(authSpy).not.toHaveBeenCalled();
    expect(props.apiKey).toBe('refreshed-token');
  });

  test('should use existing valid token', async ({ runMockServer }) => {
    const server = await runMockServer('main');
    const validTokenSet = new TokenSet({
      access_token: 'valid-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    });

    writeFileSync(
      join(configDir, 'credentials.json'),
      JSON.stringify(validTokenSet),
      { mode: 0o700 },
    );

    const props = setupTestProps(server);
    await ensureAuth(props);

    expect(authSpy).not.toHaveBeenCalled();
    expect(refreshTokenSpy).not.toHaveBeenCalled();
    expect(props.apiKey).toBe('valid-token');
  });

  test('should successfully refresh expired token', async ({
    runMockServer,
  }) => {
    refreshTokenSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new TokenSet({
          access_token: 'new-token',
          refresh_token: 'new-refresh-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );

    const server = await runMockServer('main');
    const expiredTokenSet = new TokenSet({
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });

    writeFileSync(
      join(configDir, 'credentials.json'),
      JSON.stringify(expiredTokenSet),
      { mode: 0o700 },
    );

    const props = setupTestProps(server);
    await ensureAuth(props);

    expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
    expect(authSpy).not.toHaveBeenCalled();
    expect(props.apiKey).toBe('new-token');
  });
});
