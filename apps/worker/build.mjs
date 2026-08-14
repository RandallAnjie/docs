import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: '../../dist/worker.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
  loader: {
    '.html': 'text',
  },
});
