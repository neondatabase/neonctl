"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.me = void 0;
const gateway_1 = require("./gateway");
const me = (props) => (0, gateway_1.apiCall)(Object.assign(Object.assign({}, props), { path: 'me', method: 'GET' }));
exports.me = me;
