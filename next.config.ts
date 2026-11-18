import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/api/chat': [
      './lib/document-worker.cjs',
      './lib/document-fonts/**/*',
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
