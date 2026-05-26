import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';

import { rollup } from 'rollup';
import { exec } from '@yao-pkg/pkg';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

const bundle = await rollup({
  input: 'dist/cli.js',
  // Keep `jiti` external so its dynamic require of `../dist/babel.cjs`
  // resolves at runtime against node_modules/jiti/ inside the pkg snapshot,
  // not against the rollup-flattened bundle dir. See impl-plan Phase 0.1
  // remediation (spec §11 #42).
  external: ['jiti'],
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

// Copy externalized runtime deps into the bundle so pkg snapshots them.
// `jiti` is externalized above (see rollup `external:` config) — its dynamic
// require of `../dist/babel.cjs` only resolves if the file tree is present.
cpSync('node_modules/jiti', 'bundle/node_modules/jiti', { recursive: true });

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
