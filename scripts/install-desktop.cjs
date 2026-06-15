const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const releaseDir = path.join(__dirname, '..', 'release');
const files = fs.readdirSync(releaseDir);
const installer = files.find((f) => f.endsWith('.exe') && f.includes('Setup'));

if (!installer) {
  console.error('No installer found in release/');
  process.exit(1);
}

const installerPath = path.join(releaseDir, installer);
console.log(`Installing SharkAI from: ${installerPath}`);

try {
  execSync(`"${installerPath}" /S`, { stdio: 'inherit' });
  console.log('SharkAI installed successfully!');
} catch (err) {
  console.log('Running interactive installer...');
  execSync(`start "" "${installerPath}"`, { shell: true });
}
