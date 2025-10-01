import * as client from 'openid-client';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import open from 'open';

import { log } from './log.js';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { sendError } from './analytics.js';
import { matchErrorCode } from './errors.js';
import { ExtendedTokenSet } from './types.js';
import { extendTokenSet } from './utils/auth.js';

// oauth server timeouts
const SERVER_TIMEOUT = 10_000;
// where to wait for incoming redirect request from oauth server to arrive
const REDIRECT_URI = (port: number) => `http://127.0.0.1:${port}/callback`;
// These scopes cannot be cancelled, they are always needed.
const ALWAYS_PRESENT_SCOPES = ['openid', 'offline', 'offline_access'] as const;

const NEONCTL_SCOPES = [
  ...ALWAYS_PRESENT_SCOPES,
  'urn:neoncloud:projects:create',
  'urn:neoncloud:projects:read',
  'urn:neoncloud:projects:update',
  'urn:neoncloud:projects:delete',
  'urn:neoncloud:orgs:create',
  'urn:neoncloud:orgs:read',
  'urn:neoncloud:orgs:update',
  'urn:neoncloud:orgs:delete',
  'urn:neoncloud:orgs:permission',
] as const;

const AUTH_TIMEOUT_SECONDS = 60;

export const defaultClientID = 'neonctl';

export type AuthProps = {
  oauthHost: string;
  clientId: string;
};

export const refreshToken = async (
  { oauthHost, clientId }: AuthProps,
  tokenSet: ExtendedTokenSet,
) => {
  log.debug('Discovering oauth server');
  const configuration = await client.discovery(
    new URL(oauthHost),
    clientId,
    { token_endpoint_auth_method: 'none' },
    client.None(),
    {
      timeout: SERVER_TIMEOUT,
    },
  );

  return await client.refreshTokenGrant(
    configuration,
    tokenSet.refresh_token as string,
  );
};

export const auth = async ({ oauthHost, clientId }: AuthProps) => {
  log.debug('Discovering oauth server');
  const configuration = await client.discovery(
    new URL(oauthHost),
    clientId,
    { token_endpoint_auth_method: 'none' },
    client.None(),
    {
      timeout: SERVER_TIMEOUT,
    },
  );

  //
  // Start HTTP server and wait till /callback is hit
  //
  log.debug('Starting HTTP Server for callback');
  const server = createServer();
  server.listen(0, '127.0.0.1', function (this: typeof server) {
    log.debug(`Listening on port ${(this.address() as AddressInfo).port}`);
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const listen_port = (server.address() as AddressInfo).port;

  // https://datatracker.ietf.org/doc/html/rfc6819#section-4.4.1.8
  const state = client.randomState();

  // we store the code_verifier in memory
  const codeVerifier = client.randomPKCECodeVerifier();

  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  return new Promise<ExtendedTokenSet>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Authentication timed out after ${AUTH_TIMEOUT_SECONDS} seconds`,
        ),
      );
    }, AUTH_TIMEOUT_SECONDS * 1000);

    const onRequest = async (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      //
      // Wait for callback and follow oauth flow.
      //
      if (!request.url?.startsWith('/callback')) {
        response.writeHead(404);
        response.end();
        return;
      }

      // process the CORS preflight OPTIONS request
      if (request.method === 'OPTIONS') {
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        response.end();
        return;
      }

      log.debug(`Callback received: ${request.url}`);
      const tokenSet: client.TokenEndpointResponse =
        await client.authorizationCodeGrant(
          configuration,
          new URL(request.url, `http://127.0.0.1:${listen_port}`),
          {
            pkceCodeVerifier: codeVerifier,
            expectedState: state,
          },
        );

      response.writeHead(200, { 'Content-Type': 'text/html' });
      createReadStream(
        join(fileURLToPath(new URL('.', import.meta.url)), './callback.html'),
      ).pipe(response);

      clearTimeout(timer);
      const exp = new Date();
      exp.setSeconds(exp.getSeconds() + (tokenSet.expires_in ?? 0));
      resolve(extendTokenSet(tokenSet));
      server.close();
    };

    server.on('request', (req, res) => {
      void onRequest(req, res);
    });

    //
    // Open browser to let user authenticate
    //
    const scopes =
      clientId == defaultClientID ? NEONCTL_SCOPES : ALWAYS_PRESENT_SCOPES;

    const authUrl = client.buildAuthorizationUrl(configuration, {
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI(listen_port),
    });

    log.info('Awaiting authentication in web browser.');
    log.info(`Auth Url: ${authUrl}`);

    open(authUrl.href).catch((err: unknown) => {
      const msg = `Failed to open web browser. Please copy & paste auth url to authenticate in browser.`;
      const typedErr = err && err instanceof Error ? err : undefined;
      sendError(typedErr || new Error(msg), matchErrorCode(msg));
      log.error(msg);
    });
  });
};
