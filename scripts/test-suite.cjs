const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const cases = require('./test-cases.json');

const BASE = process.env.TEST_BASE || 'http://localhost:3847';
const ROOT = path.join(__dirname, '..');
const RESULTS_FILE = path.join(ROOT, '.test-results.json');

class MissingDependency extends Error {}

async function request(route, options) {
  return fetch(new URL(route, BASE), { signal: AbortSignal.timeout(15_000), ...options });
}

async function json(route, options) {
  const response = await request(route, options);
  assert.ok(response.ok, `${route} returned HTTP ${response.status}`);
  return response.json();
}

function post(body, cookie) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  };
}

let cookie;
async function testSession() {
  if (cookie) return cookie;
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new MissingDependency('Нужни са TEST_USER_EMAIL и TEST_USER_PASSWORD за отделен тестов акаунт.');
  }
  const response = await request('/api/auth/login', post({ email, password }));
  assert.equal(response.status, 200);
  cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie, 'Missing session cookie');
  return cookie;
}

async function waitForBuild(id, headers) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const { project } = await json(`/api/projects/${id}`, { headers });
    if (project.status === 'COMPLETED') return;
    assert.notEqual(project.status, 'FAILED', 'Studio reported a failed project');
    await delay(500);
  }
  assert.fail('Studio did not report completion within 20 seconds');
}

const checks = {
  'files-logo': async () => {
    for (const file of ['logo.png', 'logo-icon.png', 'icon.ico', 'sharkai/shark-hero.webp']) {
      assert.ok(fs.statSync(path.join(ROOT, 'public', file)).size > 0);
    }
  },
  'files-agents': async () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/agents.ts'), 'utf8');
    const agents = source.split('export const AGENTS')[1]?.split('export const AUTONOMOUS_LOOP')[0] || '';
    assert.ok(agents.includes('agent-'), 'Agent registry is missing');
  },
  'api-status': async () => {
    const status = await json('/api/status');
    assert.equal(status.ok, true);
    if (process.env.SHARKAI_TEST_COMMIT) assert.equal(status.commit, process.env.SHARKAI_TEST_COMMIT);
  },
  'api-chat-private': async () => {
    const history = await json('/api/chat');
    assert.deepEqual(history.messages, []);
    assert.deepEqual(history.conversations, []);
    const response = await request('/api/chat', post({ message: 'Unauthenticated smoke' }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  },
  'api-projects-private': async () => {
    const projects = await request('/api/projects');
    if (projects.status === 200) assert.deepEqual((await projects.json()).projects, []);
    else assert.equal(projects.status, 401);
    const create = await request('/api/projects', post({ description: 'Unauthenticated smoke' }));
    assert.equal(create.status, 401);
    const upload = await request('/api/upload', { method: 'POST', body: new FormData() });
    assert.equal(upload.status, 401);
  },
  'api-upload': async () => {
    const headers = { cookie: await testSession() };
    const logo = fs.readFileSync(path.join(ROOT, 'public', 'logo.png'));
    const body = new FormData();
    body.append('file', new Blob([logo], { type: 'image/png' }), 'sharkai-test.png');
    const { uploadId } = await json('/api/upload', { method: 'POST', body, headers });
    assert.ok(uploadId);
    const file = await request(`/api/upload/${uploadId}`, { headers });
    assert.ok(file.ok);
    assert.match(file.headers.get('content-type') || '', /^image\/png/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), logo);
    const privateFile = await request(`/api/upload/${uploadId}`);
    assert.ok([401, 404].includes(privateFile.status));
  },
  'build-prompt-software': async () => {
    const sessionCookie = await testSession();
    const headers = { cookie: sessionCookie };
    const invalid = await request('/api/projects', post({ featureId: 'screenshot-website' }, sessionCookie));
    assert.ok([400, 422].includes(invalid.status));
    const { project } = await json('/api/projects', post({
      name: 'SharkAI Studio regression',
      description: 'Create a Bulgarian landing page for a bookstore with a catalogue and contact details.',
      featureId: 'prompt-software',
    }, sessionCookie));
    await waitForBuild(project.id, headers);
    const preview = await request(`/api/projects/${project.id}/preview`, { headers });
    assert.ok(preview.ok);
    assert.match(await preview.text(), /<(?:!doctype|html)/i);
    const download = await request(`/api/projects/${project.id}/download`, { headers });
    assert.ok(download.ok);
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  },
  'seo-sitemap': async () => {
    const response = await request('/sitemap.xml');
    assert.ok(response.ok);
    assert.match(await response.text(), /\/download<\/loc>/);
    assert.ok((await request('/download')).ok);
  },
  'installer-file': async () => {
    const release = path.join(ROOT, 'release');
    const entry = fs.existsSync(release) && fs.readdirSync(release).find(name => /^SharkAI-Setup-.+\.exe$/i.test(name));
    if (!entry) throw new MissingDependency('Няма локален SharkAI-Setup-*.exe в release/.');
    const filename = path.join(release, entry);
    const handle = fs.openSync(filename, 'r');
    try {
      const magic = Buffer.alloc(2);
      fs.readSync(handle, magic, 0, magic.length, 0);
      assert.equal(magic.toString(), 'MZ');
      assert.ok(fs.fstatSync(handle).size > 1_000_000);
    } finally {
      fs.closeSync(handle);
    }
  },
  'download-route': async () => {
    const response = await request('/api/download/installer', { method: 'HEAD', redirect: 'manual' });
    if (response.status === 404) throw new MissingDependency('Не е конфигуриран инсталатор за този сървър.');
    if (response.headers.has('location')) {
      const target = new URL(response.headers.get('location'), BASE);
      assert.equal(target.protocol, 'https:');
      assert.match(target.pathname, /\.exe$/i);
      return;
    }
    assert.ok(response.ok);
    assert.match(response.headers.get('content-disposition') || '', /SharkAI-Setup-.+\.exe/i);
  },
};

async function runTest(definition) {
  const start = Date.now();
  let status = 'passed';
  let error;
  try {
    await checks[definition.id]();
  } catch (cause) {
    status = cause instanceof MissingDependency ? 'skipped' : 'failed';
    error = cause.message;
  }
  return { ...definition, status, error, duration: Date.now() - start, at: new Date().toISOString() };
}

async function main() {
  const onlyId = process.argv.find(arg => arg.startsWith('--id='))?.slice(5);
  const toRun = onlyId ? cases.filter(test => test.id === onlyId) : cases;
  assert.ok(toRun.length, 'Unknown test ID');

  const previous = new Map();
  if (onlyId && fs.existsSync(RESULTS_FILE)) {
    for (const result of JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')).results || []) {
      if (cases.some(test => test.id === result.id)) previous.set(result.id, result);
    }
  }
  let runFailed = false;
  for (const test of toRun) {
    const result = await runTest(test);
    previous.set(test.id, result);
    console.log(`${result.status}: ${result.name}${result.error ? ` — ${result.error}` : ''}`);
    if (result.status === 'failed') runFailed = true;
  }

  const results = cases.flatMap(test => previous.has(test.id) ? [previous.get(test.id)] : []);
  const passed = results.filter(result => result.status === 'passed').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const skipped = results.filter(result => result.status === 'skipped').length;
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({
    ranAt: new Date().toISOString(), base: BASE, total: results.length,
    passed, failed, skipped, passRate: Math.round(passed * 100 / results.length), results,
  }, null, 2));
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} dependency blocked`);
  if (runFailed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { TESTS: cases, runTest };
