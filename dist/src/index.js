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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const yargs = __importStar(require("yargs"));
const package_json_1 = __importDefault(require("../package.json"));
const auth_1 = require("./commands/auth");
const config_1 = require("./config");
const builder = yargs
    .scriptName(package_json_1.default.name)
    .usage('$0 <cmd> [args]')
    .help()
    .option('apiHost', {
    describe: 'The API host',
    default: 'https://console.neon.tech',
})
    .option('oauthHost', {
    description: 'URL to Neon OAUTH host',
    default: 'https://oauth2.neon.tech',
})
    .option('clientId', {
    description: 'OAuth client id',
    type: 'string',
})
    // Setup config directory
    .option('configDir', {
    describe: 'Path to config directory',
    type: 'string',
    default: config_1.defaultDir,
})
    .middleware(config_1.ensureConfigDir)
    // Auth flow
    .command('auth', 'Authenticate user', (yargs) => yargs, (args) => __awaiter(void 0, void 0, void 0, function* () {
    (yield Promise.resolve().then(() => __importStar(require('./commands/auth')))).authFlow(args);
}))
    // Ensure auth token
    .option('token', {
    describe: 'Auth token',
    type: 'string',
    default: '',
})
    .command('projects [sub]', 'Manage projects', (yargs) => __awaiter(void 0, void 0, void 0, function* () {
    return yargs.middleware(auth_1.ensureAuth).positional('sub', {
        describe: 'Subcommand',
        choices: ['list'],
    });
}), (args) => __awaiter(void 0, void 0, void 0, function* () {
    (yield Promise.resolve().then(() => __importStar(require('./commands/projects')))).default(args);
}));
(() => __awaiter(void 0, void 0, void 0, function* () {
    if ((yield builder.argv)._.length === 0) {
        yargs.showHelp();
    }
}))();
