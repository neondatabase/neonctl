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
  plugins: [
    nodeResolve({
      exportConditions: ['node'],
    }),
    commonjs(),
    json(),
  ],
};
