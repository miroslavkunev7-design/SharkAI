import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  async redirects() {
    return [
      {source:'/investment-lab/simulator.html',destination:'/dashboard?view=investments&tab=calculator',permanent:false},
      {source:'/investment-lab/index.html',destination:'/dashboard?view=investments',permanent:false},
    ];
  },
  outputFileTracingIncludes: {
    '/api/chat': [
      './lib/document-worker.cjs',
      './lib/document-fonts/**/*',
      './lib/table-worker.mjs',
      './lib/table-request.mjs',
      './lib/bounded-zip.mjs',
      './node_modules/csv-parse/**/*',
      './node_modules/saxes/**/*',
      './node_modules/xmlchars/**/*',
      './node_modules/yauzl/**/*',
      './node_modules/pend/**/*',
      './node_modules/sharp/**/*',
      './node_modules/detect-libc/**/*',
      './node_modules/semver/**/*',
      './node_modules/@img/**/*',
      './node_modules/pdf-lib/**/*',
      './node_modules/@pdf-lib/**/*',
      './node_modules/pako/**/*',
      './node_modules/tslib/**/*',
    ],
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
