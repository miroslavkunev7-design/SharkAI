const fs = require('fs');
const t = fs.readFileSync(process.argv[2] || '.vercel/.env.production.local', 'utf8');
for (const k of ['POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'ADMIN_EMAIL', 'JWT_SECRET', 'NEXT_PUBLIC_APP_URL']) {
  const m = t.match(new RegExp(`${k}="([^"]*)"`));
  console.log(k + ':', m ? (m[1].length ? `set (${m[1].length} chars)` : 'EMPTY') : 'missing');
}
