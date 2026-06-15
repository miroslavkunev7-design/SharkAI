const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = fs.readFileSync(envPath, 'utf8');
const match = env.match(/OPENAI_API_KEY="([^"]+)"/);
const key = match?.[1];

if (!key) {
  console.error('No key in .env');
  process.exit(1);
}

const prisma = new PrismaClient();
prisma.systemConfig
  .upsert({
    where: { key: 'openai_api_key' },
    create: { key: 'openai_api_key', value: key },
    update: { value: key },
  })
  .then(() => console.log('API key saved to database'))
  .finally(() => prisma.$disconnect());
