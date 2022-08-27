"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = void 0;
const openid_client_1 = require("openid-client");
const node_http_1 = require("node:http");
const open_1 = __importDefault(require("open"));
const log_1 = require("./log");
// what port to listen on for incoming requests
const CONFIG_LISTEN_PORT = 5555;
// oauth server timeouts
const SERVER_TIMEOUT = 10000;
// where to wait for incoming redirect request from oauth server to arrive
const REDIRECT_URI = 'http://127.0.0.1:5555/callback';
// These scopes cannot be cancelled, they are always needed.
const DEFAULT_SCOPES = ['openid', 'offline'];
const auth = ({ oauthHost, clientId }) => __awaiter(void 0, void 0, void 0, function* () {
    openid_client_1.custom.setHttpOptionsDefaults({
        timeout: SERVER_TIMEOUT,
    });
    log_1.log.info('Discovering oauth server');
    const issuer = yield openid_client_1.Issuer.discover(oauthHost);
    const neonOAuthClient = new issuer.Client({
        token_endpoint_auth_method: 'none',
        client_id: clientId,
        redirect_uris: [REDIRECT_URI],
        response_types: ['code'],
    });
    // https://datatracker.ietf.org/doc/html/rfc6819#section-4.4.1.8
    const state = openid_client_1.generators.state();
    // we store the code_verifier in memory
    const codeVerifier = openid_client_1.generators.codeVerifier();
    const codeChallenge = openid_client_1.generators.codeChallenge(codeVerifier);
    return new Promise((resolve) => {
        //
        // Start HTTP server and wait till /callback is hit
        //
        const server = (0, node_http_1.createServer)((request, response) => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            //
            // Wait for callback and follow oauth flow.
            //
            if (!((_a = request.url) === null || _a === void 0 ? void 0 : _a.startsWith('/callback'))) {
                response.writeHead(404);
                response.end();
                return;
            }
            log_1.log.info('Callback received', request.url);
            const params = neonOAuthClient.callbackParams(request);
            const tokenSet = yield neonOAuthClient.callback(REDIRECT_URI, params, {
                code_verifier: codeVerifier,
                state,
            });
            response.end('Thank you, you may close the window!');
            resolve(tokenSet);
            server.close();
        }));
        server.listen(CONFIG_LISTEN_PORT, () => {
            log_1.log.info(`Listening on port ${CONFIG_LISTEN_PORT}`);
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
        (0, open_1.default)(authUrl);
    });
});
exports.auth = auth;
