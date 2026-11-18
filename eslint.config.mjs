import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';

const compatibility = new FlatCompat({ baseDirectory: fileURLToPath(new URL('.', import.meta.url)) });

const config = [
  { ignores: ['.next/**', '.desktop-app/**', 'dist/**', 'release/**', 'generated/**', 'uploads/**', 'next-env.d.ts'] },
  ...compatibility.extends('next/core-web-vitals', 'next/typescript'),
  // Electron and the Node workers use explicit CommonJS entry points.
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
];

export default config;
