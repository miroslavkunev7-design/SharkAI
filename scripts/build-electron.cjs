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
  // Use the same npm CLI that launched the build, keeping the website's dependencies out of the installer.
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  execFileSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: staging, stdio: 'inherit',
  });
  execFileSync(process.execPath, [
    require.resolve('electron-builder/cli.js'), '--win', 'nsis', '--x64',
    ...process.argv.slice(2), '--publish', 'never',
    `--config.directories.app=${staging}`, `--config.directories.output=${output}`,
  ], { cwd: root, stdio: 'inherit' });
  const archive = path.join(output, 'win-unpacked/resources/app.asar');
  const { extractFile } = require('@electron/asar');
  for (const moduleName of ['electron-updater', 'js-yaml']) {
    const folder = path.join('node_modules', moduleName);
    const manifest = JSON.parse(extractFile(archive, path.join(folder, 'package.json')));
    extractFile(archive, path.join(folder, manifest.main || 'index.js'));
  }
  fs.renameSync(path.join(output, filename), path.join(release, filename));
  console.log(`Installer ready at ${path.join('release', filename)}`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
