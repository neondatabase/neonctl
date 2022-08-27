"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiCall = void 0;
const https_1 = require("https");
const apiCall = ({ apiHost, token, path, method = 'GET', }) => new Promise((resolve, reject) => {
    (0, https_1.request)(`${apiHost}/api/v1/${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
        method,
    }, (res) => {
        if (res.statusCode !== 200) {
            reject(new Error(`${res.statusCode}: ${res.statusMessage}`));
            return;
        }
        let result = '';
        res.on('data', (data) => {
            result += data;
        });
        res.on('end', () => {
            resolve(result);
        });
    })
        .on('error', reject)
        .end();
});
exports.apiCall = apiCall;
