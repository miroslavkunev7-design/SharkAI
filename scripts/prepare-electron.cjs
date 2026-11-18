const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const staging = path.join(root, '.desktop-app');
const defaultOrigin = 'https://mm-auto-nadq-jeleva-s-projects.vercel.app';
const service = new URL(process.env.SHARKAI_DESKTOP_ORIGIN?.trim() || defaultOrigin);
if (service.protocol !== 'https:' || service.username || service.password || service.pathname !== '/' || service.search || service.hash) {
  throw new Error('SHARKAI_DESKTOP_ORIGIN must be a trusted HTTPS origin with no path or credentials.');
}

fs.rmSync(staging, { recursive: true, force: true });
const electron = path.join(staging, 'electron');
const assets = path.join(electron, 'assets');
fs.mkdirSync(assets, { recursive: true });
for (const name of ['main.cjs', 'offline.html', 'offline.css', 'offline.js']) {
  fs.copyFileSync(path.join(root, 'electron', name), path.join(electron, name));
}
fs.copyFileSync(path.join(root, 'public', 'logo-icon.png'), path.join(assets, 'logo-icon.png'));
fs.copyFileSync(path.join(root, 'public', 'sharkai', 'shark-hero.webp'), path.join(assets, 'shark-hero.webp'));
fs.writeFileSync(path.join(electron, 'service.json'), JSON.stringify({ origin: service.origin }));
fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
  name: 'sharkai', version, description: 'SharkAI for Windows', author: 'SharkAI', main: 'electron/main.cjs',
}));
console.log('Prepared the SharkAI desktop application.');
