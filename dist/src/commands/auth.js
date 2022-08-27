"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAuth = exports.validateAuth = exports.authFlow = void 0;
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
const auth_1 = require("../auth");
const user_1 = require("../api/user");
const CREDENTIALS_FILE = 'credentials.json';
const authFlow = ({ configDir, oauthHost, clientId, }) => __awaiter(void 0, void 0, void 0, function* () {
    if (!clientId) {
        throw new Error('Missing client id');
    }
    const tokenSet = yield (0, auth_1.auth)({
        oauthHost: oauthHost,
        clientId: clientId,
    });
    const credentialsPath = (0, node_path_1.join)(configDir, CREDENTIALS_FILE);
    (0, node_fs_1.writeFileSync)(credentialsPath, JSON.stringify(tokenSet));
    return tokenSet.access_token || '';
});
exports.authFlow = authFlow;
const validateAuth = (props) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield (0, user_1.me)(props);
    }
    catch (e) {
        console.error(e);
    }
});
exports.validateAuth = validateAuth;
const ensureAuth = (props) => __awaiter(void 0, void 0, void 0, function* () {
    yield (0, exports.validateAuth)(props);
    const credentialsPath = (0, node_path_1.join)(props.configDir, CREDENTIALS_FILE);
    props.token = (0, node_fs_1.existsSync)(credentialsPath)
        ? (yield Promise.resolve().then(() => __importStar(require(credentialsPath)))).access_token
        : yield (0, exports.authFlow)(props);
});
exports.ensureAuth = ensureAuth;
