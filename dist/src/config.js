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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureConfigDir = exports.defaultDir = void 0;
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
const DIR_NAME = '.neonctl';
exports.defaultDir = (0, node_path_1.join)(process.cwd(), DIR_NAME);
const ensureConfigDir = ({ configDir, }) => __awaiter(void 0, void 0, void 0, function* () {
    if (!(0, node_fs_1.existsSync)(configDir)) {
        (0, node_fs_1.mkdirSync)(configDir);
    }
});
exports.ensureConfigDir = ensureConfigDir;
