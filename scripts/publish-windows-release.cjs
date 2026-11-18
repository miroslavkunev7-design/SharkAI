const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const repository = 'miroslavkunev7-design/SharkAI';
const metadataName = 'windows-installer.json';
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function releaseIdentity(version, env) {
  const tag = `v${version}`;
  if (!versionPattern.test(version) || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REPOSITORY !== repository
    || env.GITHUB_REF !== `refs/heads/release/windows-${tag}` || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '')) {
    throw new Error('A Windows release requires an exact release/windows-v<package version> push in the SharkAI repository.');
  }
  return { tag, sha: env.GITHUB_SHA, filename: `SharkAI-Setup-${version}.exe` };
}

async function digest(chunks) {
  const hash = createHash('sha256');
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

async function readArtifact(directory, version, { sha, filename }) {
  const names = (await fs.readdir(directory)).sort();
  if (names.join('\n') !== [metadataName, filename].sort().join('\n')) {
    throw new Error('The verified Windows artifact must contain exactly the installer and its verification manifest.');
  }
  const manifest = JSON.parse((await fs.readFile(path.join(directory, metadataName), 'utf8')).replace(/^\uFEFF/, ''));
  if (manifest.filename !== filename || manifest.version !== version || manifest.sourceCommit !== sha || manifest.architecture !== 'x64'
    || typeof manifest.os !== 'string' || !manifest.os.startsWith('Microsoft Windows')
    || !['offlineStartup', 'restartAndOccupiedPort', 'upgradeAndProfile', 'uninstall'].every((check) => manifest[check] === 'passed')
    || !['Valid', 'NotSigned'].includes(manifest.signature) || !/^[0-9a-f]{64}$/.test(manifest.sha256 ?? '')) {
    throw new Error('The manifest does not confirm a verified Windows x64 build of the pushed commit.');
  }
  const assets = await Promise.all([filename, metadataName].map(async (name) => {
    const file = path.join(directory, name);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size === 0) throw new Error(`Invalid release asset ${name}.`);
    return { name, file, size: info.size, sha256: await digest(createReadStream(file)) };
  }));
  if (assets[0].size !== manifest.sizeBytes || assets[0].sha256 !== manifest.sha256) {
    throw new Error('The installer bytes do not match the verified Windows size and SHA-256.');
  }
  return { assets, manifest };
}

function githubClient(token, fetchImpl) {
  const apiRoot = `https://api.github.com/repos/${repository}`;
  const uploadRoot = `https://uploads.github.com/repos/${repository}`;
  async function request(route, { method = 'GET', json, asset, binary = false, missing = false } = {}) {
    const endpoint = asset ? uploadRoot : apiRoot;
    const response = await fetchImpl(`${endpoint}${route}`, {
      method, signal: AbortSignal.timeout(asset ? 240_000 : 120_000),
      headers: {
        authorization: `Bearer ${token}`, accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'SharkAI Windows release',
        ...(asset ? { 'content-type': 'application/octet-stream', 'content-length': String(asset.size) } : {}),
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      ...(asset ? { body: createReadStream(asset.file), duplex: 'half' } : json ? { body: JSON.stringify(json) } : {}),
    });
    if (response.status === 404 && missing) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${route} returned HTTP ${response.status}.`);
    return binary ? response.body : response.status === 204 ? null : response.json();
  }
  return request;
}

async function existingRelease(request, tag) {
  const published = await request(`/releases/tags/${tag}`, { missing: true });
  if (published) return published;
  for (let page = 1; ; page += 1) {
    const releases = await request(`/releases?per_page=100&page=${page}`);
    const matches = releases.filter((release) => release.tag_name === tag);
    if (matches.length > 1) throw new Error(`Multiple drafts exist for ${tag}.`);
    if (matches.length) return matches[0];
    if (releases.length < 100) return null;
  }
}

async function verifyTag(request, tag, sha) {
  const reference = await request(`/git/ref/tags/${tag}`, { missing: true });
  if (!reference) return false;
  const actual = reference.object.type === 'commit' ? reference.object.sha : (await request(`/commits/${tag}`)).sha;
  if (actual !== sha) throw new Error(`Tag ${tag} already points to a different source commit.`);
  return true;
}

async function requireExactAsset(request, remote, expected) {
  if (!remote || remote.state !== 'uploaded' || remote.size !== expected.size) {
    throw new Error(`GitHub asset ${expected.name} is missing or has a different size/state.`);
  }
  const sha = remote.digest?.startsWith('sha256:') ? remote.digest.slice(7)
    : await digest(await request(`/releases/assets/${remote.id}`, { binary: true }));
  if (sha !== expected.sha256) throw new Error(`GitHub asset ${expected.name} has a different SHA-256.`);
}

async function publishWindowsRelease({ version, env, directory, fetchImpl = fetch }) {
  const { tag, sha, filename } = releaseIdentity(version, env);
  const { manifest, assets } = await readArtifact(directory, version, { sha, filename });
  if (!env.GH_TOKEN) throw new Error('The release job requires scoped GitHub Actions credentials.');
  const request = githubClient(env.GH_TOKEN, fetchImpl);
  const tagMatches = await verifyTag(request, tag, sha);
  let release = await existingRelease(request, tag);
  if (release && !release.draft) {
    if (!tagMatches) throw new Error(`The published release ${tag} does not have the expected tag.`);
    for (const asset of assets) await requireExactAsset(request, release.assets.find(({ name }) => name === asset.name), asset);
    return { url: release.html_url, unchanged: true };
  }
  if (release && !tagMatches && release.target_commitish !== sha) {
    throw new Error(`Draft ${tag} belongs to a different source commit.`);
  }
  if (!release) {
    release = await request('/releases', { method: 'POST', json: {
      tag_name: tag, target_commitish: sha, name: `SharkAI ${version}`, draft: true, prerelease: false,
      body: [
        'Windows x64 NSIS installer and verification manifest.', '',
        `Source commit: ${sha}`, `Size: ${manifest.sizeBytes} bytes`, `SHA-256: ${manifest.sha256}`,
        `Authenticode: ${manifest.signature}`, `Windows build and installer verification: ${manifest.os} (${manifest.osBuild})`,
      ].join('\n'),
    } });
  }
  if (!release.draft || release.tag_name !== tag) throw new Error(`GitHub did not return the expected draft ${tag}.`);
  for (const asset of assets) {
    const existing = release.assets.find(({ name }) => name === asset.name);
    if (existing?.state === 'starter' && existing.size === 0) await request(`/releases/assets/${existing.id}`, { method: 'DELETE' });
    else if (existing) { await requireExactAsset(request, existing, asset); continue; }
    const uploaded = await request(`/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, { method: 'POST', asset });
    await requireExactAsset(request, uploaded, asset);
  }
  if (!(await verifyTag(request, tag, sha))) {
    await request('/git/refs', { method: 'POST', json: { ref: `refs/tags/${tag}`, sha } });
  }
  if (!(await verifyTag(request, tag, sha))) throw new Error(`GitHub did not confirm the expected tag ${tag}.`);
  const verified = await request(`/releases/${release.id}`);
  if (verified.tag_name !== tag) throw new Error(`GitHub changed the draft tag for ${tag}.`);
  for (const asset of assets) await requireExactAsset(request, verified.assets.find(({ name }) => name === asset.name), asset);
  if (!verified.draft) return { url: verified.html_url, unchanged: true };
  const published = await request(`/releases/${release.id}`, { method: 'PATCH', json: { draft: false } });
  if (published.draft || published.tag_name !== tag) throw new Error(`GitHub did not publish the verified release ${tag}.`);
  return { url: published.html_url, unchanged: false };
}

if (require.main === module) {
  const { version } = require('../package.json');
  const env = process.env;
  if (process.argv.includes('--validate-ref')) releaseIdentity(version, env);
  else void publishWindowsRelease({ version, env, directory: process.argv[2] || 'verified-windows-release' })
    .then(({ url, unchanged }) => console.log(`${unchanged ? 'Verified existing release' : 'Published verified release'}: ${url}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { publishWindowsRelease };
