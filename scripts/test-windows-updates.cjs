const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setImmediate } = require('node:timers/promises');
const test = require('node:test');
const { configureUpdater, officialInstaller, trustedFeed } = require('../electron/updates.cjs');
const { publishWindowsRelease, readArtifact } = require('./publish-windows-release.cjs');

test('the feed accepts the original HTTPS GitHub release channel with or without a publisher', () => {
  const feed = { provider: 'github', owner: 'miroslavkunev7-design', repo: 'SharkAI', publisherName: ['Acme'] };
  assert.equal(trustedFeed(feed), true);
  assert.equal(trustedFeed({ ...feed, publisherName: undefined }), true);
  for (const bad of [{ owner: 'other' }, { repo: 'other' }, { provider: 'generic' },
    { host: 'example.com' }, { protocol: 'http' }, { channel: 'beta' },
    { publisherName: [] }, { publisherName: [''] }, { verifyUpdateCodeSignature: false }]) {
    assert.equal(trustedFeed({ ...feed, ...bad }), false);
  }
});

const candidate = {
  version: '1.0.4', tag: 'v1.0.4',
  files: [{ url: 'SharkAI-Setup-1.0.4.exe', size: 12, sha512: createHash('sha512').update('test fixture').digest('base64') }],
};

test('only downloads the versioned stable release installer with a full SHA-512 digest', () => {
  assert.ok(officialInstaller(candidate));
  for (const overrides of [{ tag: 'v1.0.5' }, { version: '1.0.4-beta' }, { files: [] },
    ...[{ sha512: '' }, { size: 0 }, { url: 'https://example.com/other.exe' }].map((item) => ({ files: [{ ...candidate.files[0], ...item }] }))]) {
    assert.equal(officialInstaller({ ...candidate, ...overrides }), false);
  }
});

test('download in the background and defer or apply on the user’s choice', async () => {
  for (const response of [0, 1, 2]) {
    const window = new EventEmitter();
    window.isDestroyed = () => false;
    let checks = 0;
    const installs = [];
    let downloads = 0;
    const updater = Object.assign(new EventEmitter(), {
      checkForUpdates: async () => { checks++; return { isUpdateAvailable: true, updateInfo: candidate }; },
      downloadUpdate: async () => { downloads++; },
      quitAndInstall: (...args) => { installs.push(args); },
    });
    configureUpdater(window, { showMessageBox: async () => ({ response }) }, updater);
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.allowDowngrade, false);
    window.emit('focus');
    await setImmediate();
    assert.equal(checks, 1);
    assert.equal(downloads, 1);
    updater.emit('update-downloaded', { version: '1.0.4' });
    await setImmediate();
    assert.deepEqual(installs, response === 2 ? [[false, true]] : []);
    assert.equal(updater.autoInstallOnAppQuit, false);
    window.emit('closed');
    assert.deepEqual(installs, response === 2 ? [[false, true]] : response === 1 ? [[true, false]] : []);
  }
});

test('both supported Windows signing modes publish the verified bytes and reject corrupted artifacts', async (t) => {
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
  for (const signature of ['HashMismatch', 'UnknownError']) {
    await fs.writeFile(path.join(folder, 'windows-installer.json'), JSON.stringify({ ...manifest, signature }));
    let requests = 0;
    await assert.rejects(publishWindowsRelease({ version, env, directory: folder, fetchImpl: () => { requests++; } }), /invalid or unknown/);
    assert.equal(requests, 0);
  }
  for (const signature of ['Valid', 'NotSigned']) {
    await fs.writeFile(path.join(folder, 'windows-installer.json'), JSON.stringify({ ...manifest, signature }));
    const result = await readArtifact(folder, version, { sha, filename });
    assert.equal(result.manifest.signature, signature);
    const metadata = JSON.parse(result.assets.find(({ name }) => name === 'latest.yml').buffer);
    assert.ok(officialInstaller({ tag: `v${version}`, ...metadata }));
    assert.deepEqual(metadata.files, [{ url: filename, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length }]);
  }
  await fs.writeFile(path.join(folder, filename), 'tampered bytes');
  await assert.rejects(readArtifact(folder, version, { sha, filename }), /do not match/);
});
