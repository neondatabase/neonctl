import { custom, generators, Issuer, TokenSet } from 'openid-client';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import open from 'open';

import { log } from './log';

// what port to listen on for incoming requests
const CONFIG_LISTEN_PORT = 5555;
// oauth server timeouts
const SERVER_TIMEOUT = 10_000;
// where to wait for incoming redirect request from oauth server to arrive
const REDIRECT_URI = 'http://127.0.0.1:5555/callback';
// These scopes cannot be cancelled, they are always needed.
const DEFAULT_SCOPES = ['openid', 'offline'];

export type AuthProps = {
  oauthHost: string;
  clientId: string;
};

export const auth = async ({ oauthHost, clientId }: AuthProps) => {
  custom.setHttpOptionsDefaults({
    timeout: SERVER_TIMEOUT,
  });
  log.info('Discovering oauth server');
  const issuer = await Issuer.discover(oauthHost);

  const neonOAuthClient = new issuer.Client({
    token_endpoint_auth_method: 'none',
    client_id: clientId,
    redirect_uris: [REDIRECT_URI],
    response_types: ['code'],
  });

  // https://datatracker.ietf.org/doc/html/rfc6819#section-4.4.1.8
  const state = generators.state();

  // we store the code_verifier in memory
  const codeVerifier = generators.codeVerifier();

  const codeChallenge = generators.codeChallenge(codeVerifier);

  return new Promise<TokenSet>((resolve) => {
    //
    // Start HTTP server and wait till /callback is hit
    //
    const server = createServer(async (request, response) => {
      //
      // Wait for callback and follow oauth flow.
      //
      if (!request.url?.startsWith('/callback')) {
        response.writeHead(404);
        response.end();
        return;
      }
      log.info(`Callback received: ${request.url}`);
      const params = neonOAuthClient.callbackParams(request);
      const tokenSet = await neonOAuthClient.callback(REDIRECT_URI, params, {
        code_verifier: codeVerifier,
        state,
      });

      response.writeHead(200, { 'Content-Type': 'text/html' });
      createReadStream(join(__dirname, './callback.html')).pipe(response);
      resolve(tokenSet);
      server.close();
    });

    server.listen(CONFIG_LISTEN_PORT, () => {
      log.info(`Listening on port ${CONFIG_LISTEN_PORT}`);
    });

    //
    // Open browser to let user authenticate
    //
    const authUrl = neonOAuthClient.authorizationUrl({
      scope: DEFAULT_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    open(authUrl);
  });
};
