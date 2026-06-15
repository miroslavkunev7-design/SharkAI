const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.vercel', '.env.production.local');
if (!fs.existsSync(envFile)) {
  console.error('Run: vercel env pull .vercel/.env.production.local --environment=production --yes');
  process.exit(1);
}
dotenv.config({ path: envFile });
process.env.USE_DB_UPLOADS = 'true';

execSync('npx prisma db push', { stdio: 'inherit', cwd: root, env: process.env });
execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', cwd: root, env: process.env });
console.log('Production DB ready.');
