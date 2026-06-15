/**
 * Push schema + seed to production Supabase (uses .env.production.local from vercel env pull)
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const envFile = path.join(__dirname, '..', '.env.production.local');
if (!fs.existsSync(envFile)) {
  console.error('Missing .env.production.local — run: vercel env pull .env.production.local --environment=production');
  process.exit(1);
}

dotenv.config({ path: envFile });

if (!process.env.POSTGRES_PRISMA_URL) {
  console.error('POSTGRES_PRISMA_URL missing');
  process.exit(1);
}

process.env.USE_DB_UPLOADS = 'true';

console.log('Pushing Prisma schema to Supabase...');
execSync('npx prisma db push', { stdio: 'inherit', cwd: path.join(__dirname, '..'), env: process.env });

console.log('Seeding admin user...');
execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', cwd: path.join(__dirname, '..'), env: process.env });

console.log('Done.');
