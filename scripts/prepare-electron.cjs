const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

copyDir(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'));
copyDir(path.join(root, 'public'), path.join(standalone, 'public'));
copyDir(path.join(root, 'prisma'), path.join(standalone, 'prisma'));
if (fs.existsSync(path.join(root, 'prisma', 'dev.db'))) {
  fs.copyFileSync(path.join(root, 'prisma', 'dev.db'), path.join(standalone, 'prisma', 'dev.db'));
}

const envContent = `DATABASE_URL="file:${path.join('%APPDATA%', 'SharkAI', 'sharkai.db').replace(/\\/g, '/')}"
JWT_SECRET="sharkai-desktop-secret"
NEXT_PUBLIC_APP_URL="http://127.0.0.1:3847"
`;
fs.writeFileSync(path.join(standalone, '.env'), envContent);

console.log('Electron standalone prepared.');
