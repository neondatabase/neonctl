import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';

import { rollup } from 'rollup';
import { exec } from 'pkg';
import { system } from 'pkg-fetch';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

console.log('SYSTEM IS:', system.hostPlatform, system.hostArch);

const bundle = await rollup({
  input: 'dist/cli.js',
  plugins: [
    nodeResolve({
      exportConditions: ['node'],
    }),
    commonjs(),
    json(),
  ],
});

await bundle.write({
  dir: 'bundle',
  format: 'cjs',
});

await bundle.close();

const pkgJson = JSON.parse(readFileSync('package.json', 'utf8'));
delete pkgJson.type;

pkgJson.pkg.assets.forEach((asset) => {
  cpSync(join('dist', asset), join('bundle', asset));
});

writeFileSync('bundle/package.json', JSON.stringify(pkgJson, null, 2));

await exec([
  'bundle',
  '--out-path',
  'bundle',
  '--compress',
  'brotli',
  '--options',
  'no-warnings',
]);
