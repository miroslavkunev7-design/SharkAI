const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setImmediate } = require('node:timers/promises');
const test = require('node:test');
const { configureUpdater, trustedFeed } = require('../electron/updates.cjs');
const { publishWindowsRelease, readArtifact } = require('./publish-windows-release.cjs');

test('the feed is pinned to the project and requires Authenticode publisher verification', () => {
  const feed = { provider: 'github', owner: 'miroslavkunev7-design', repo: 'SharkAI', publisherName: ['Acme'] };
  assert.equal(trustedFeed(feed), true);
  for (const bad of [{ owner: 'other' }, { repo: 'other' }, { provider: 'generic' },
    { publisherName: undefined }, { publisherName: [] }, { publisherName: [''] }, { verifyUpdateCodeSignature: false }]) {
    assert.equal(trustedFeed({ ...feed, ...bad }), false);
  }
});

test('download in the background and defer or apply on the user’s choice', async () => {
  for (const response of [0, 1, 2]) {
    const window = new EventEmitter();
    window.isDestroyed = () => false;
    let checks = 0;
    const installs = [];
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: async () => { checks++; return { downloadPromise: Promise.resolve() }; },
      quitAndInstall: (...args) => { installs.push(args); },
    });
    configureUpdater(window, { showMessageBox: async () => ({ response }) }, updater);
    assert.equal(updater.autoDownload, true);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowDowngrade, false);
    window.emit('focus');
    assert.equal(checks, 1);
    updater.emit('update-downloaded', { version: '1.0.4' });
    await setImmediate();
    assert.deepEqual(installs, response === 2 ? [[false, true]] : []);
    assert.equal(updater.autoInstallOnAppQuit, false);
    window.emit('closed');
    assert.deepEqual(installs, response === 2 ? [[false, true]] : response === 1 ? [[true, false]] : []);
  }
});

test('update channel contains only the verified signed installer and its exact digest', async (t) => {
  const base = path.resolve(__dirname, '../release');
  await fs.mkdir(base, { recursive: true });
  const folder = await fs.mkdtemp(path.join(base, '.test-updates-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const version = '1.0.4';
  const filename = `SharkAI-Setup-${version}.exe`;
  const bytes = Buffer.from('test fixture');
  const sha = 'a'.repeat(40);
  const manifest = { version, filename, sourceCommit: sha, architecture: 'x64', os: 'Microsoft Windows',
    offlineStartup: 'passed', restartAndOccupiedPort: 'passed', upgradeAndProfile: 'passed', uninstall: 'passed',
    sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(path.join(folder, filename), bytes);
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'miroslavkunev7-design/SharkAI',
    GITHUB_REF: `refs/heads/release/windows-v${version}`, GITHUB_SHA: sha };
  for (const signature of ['NotSigned', 'HashMismatch', 'UnknownError']) {
    await fs.writeFile(path.join(folder, 'windows-installer.json'), JSON.stringify({ ...manifest, signature }));
    let requests = 0;
    await assert.rejects(publishWindowsRelease({ version, env, directory: folder, fetchImpl: () => { requests++; } }), /signed installer is required/);
    assert.equal(requests, 0);
  }
  await fs.writeFile(path.join(folder, 'windows-installer.json'), JSON.stringify({ ...manifest, signature: 'Valid' }));
  const { assets } = await readArtifact(folder, version, { sha, filename });
  const metadata = JSON.parse(assets.find(({ name }) => name === 'latest.yml').buffer);
  assert.equal(metadata.version, version);
  assert.deepEqual(metadata.files, [{ url: filename, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length }]);
  await fs.writeFile(path.join(folder, filename), 'tampered bytes');
  await assert.rejects(readArtifact(folder, version, { sha, filename }), /do not match/);
});
