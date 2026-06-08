import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

export default {
  input: 'dist/cli.js',
  output: {
    dir: 'bundle',
    format: 'cjs',
    entryFileNames: '[name].cjs',
    chunkFileNames: '[name]-[hash].cjs',
  },
  // Belt-and-suspenders: the computed specifier in esbuild.ts already keeps
  // esbuild out of the bundle, but this states the intent and guards anything
  // that does resolve esbuild statically.
  external: [/^esbuild$/, /^@esbuild\//],
  plugins: [
    nodeResolve({
      exportConditions: ['node'],
    }),
    commonjs(),
    json(),
  ],
};
