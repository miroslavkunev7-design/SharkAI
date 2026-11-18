const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { version } = require('../package.json');

if (process.platform !== 'win32') throw new Error('Run the installer on Windows.');
execFileSync(path.join(__dirname, '..', 'release', `SharkAI-Setup-${version}.exe`), { stdio: 'inherit' });
