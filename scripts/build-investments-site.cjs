const path = require('node:path');
const { createRequire } = require('node:module');

// Use the esbuild installed with this project's TypeScript runner.
const resolveForTsx = createRequire(require.resolve('tsx/package.json'));
const { build } = resolveForTsx('esbuild');
const outputDirectory = process.argv[2];

if (!outputDirectory) throw new Error('Provide the target Site asset directory.');
build({
  entryPoints: [path.join(__dirname, 'investments-site.tsx')],
  outfile: path.join(path.resolve(outputDirectory), 'portfolio-native.mjs'),
  platform: 'browser',
  target: 'es2020',
  format: 'esm',
  bundle: true,
  minify: true,
  legalComments: 'eof',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  external: ['/investment-lab/*', '/sharkai/*'],
}).catch(error => { console.error(error); process.exitCode = 1; });
