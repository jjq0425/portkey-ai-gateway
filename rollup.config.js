import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import copy from 'rollup-plugin-copy';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'src/start-server.ts',
  output: {
    dir: 'build',
    format: 'es',
  },
  plugins: [
    resolve(),
    commonjs(),
    typescript({
      exclude: ['**/*.test.ts', 'start-test.js', 'cookbook', 'docs', 'tests'],
      tsconfig: './tsconfig.json',
    }),
    terser(),
    json(),
    copy({
      targets: [{ src: 'src/public/*', dest: 'build/public' }],
    }),
  ],
};
