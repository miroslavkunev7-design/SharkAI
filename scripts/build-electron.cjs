const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');
const { prepareElectron } = require('./prepare-electron.cjs');

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const filename = `SharkAI-Setup-${version}.exe`;
fs.mkdirSync(release, { recursive: true });
const workspace = fs.mkdtempSync(path.join(release, '.build-'));
try {
  const staging = path.join(workspace, 'app');
  const output = path.join(workspace, 'output');
  prepareElectron(staging);
  execFileSync(process.execPath, [
    require.resolve('electron-builder/cli.js'), '--win', 'nsis', '--x64',
    ...process.argv.slice(2), '--publish', 'never',
    `--config.directories.app=${staging}`, `--config.directories.output=${output}`,
  ], { cwd: root, stdio: 'inherit' });
  fs.renameSync(path.join(output, filename), path.join(release, filename));
  console.log(`Installer ready at ${path.join('release', filename)}`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
