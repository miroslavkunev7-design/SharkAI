const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const filename = `SharkAI-Setup-${version}.exe`;
require('./prepare-electron.cjs');
fs.mkdirSync(release, { recursive: true });
const output = fs.mkdtempSync(path.join(release, '.build-'));
try {
  execFileSync(process.execPath, [
    require.resolve('electron-builder/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never',
    ...process.argv.slice(2), `--config.directories.output=${output}`,
  ], { cwd: root, stdio: 'inherit' });
  fs.renameSync(path.join(output, filename), path.join(release, filename));
  console.log(`Installer ready at ${path.join('release', filename)}`);
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
