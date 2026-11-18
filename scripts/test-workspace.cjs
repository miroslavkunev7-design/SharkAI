const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');

const base = new URL(process.env.SHARKAI_TEST_URL || 'http://127.0.0.1:3847');
assert(process.env.POSTGRES_PRISMA_URL, 'Set POSTGRES_PRISMA_URL for the isolated workspace test database.');
const database = new URL(process.env.POSTGRES_PRISMA_URL);
const local = ['localhost', '127.0.0.1', '[::1]'];
assert(local.includes(base.hostname) && local.includes(database.hostname), 'Run workspace tests against a local application and test database.');
const prisma = new PrismaClient();
const tag = randomUUID();
const accounts = [`workspace-a-${tag}@example.test`, `workspace-b-${tag}@example.test`];
const projectRequestId = randomUUID();

async function request(pathname, { cookie, body, headers, method, ...options } = {}) {
  return fetch(new URL(pathname, base), {
    ...options,
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }), ...headers },
    ...(body && { body: JSON.stringify(body) }),
  });
}

async function json(path, options, status = 200) {
  const response = await request(path, options);
  const data = await response.json();
  assert.equal(response.status, status, `${options?.method || (options?.body ? 'POST' : 'GET')} ${path}: ${data.error || ''}`);
  return data;
}

async function signIn(email) {
  const body = { email, name: 'Workspace integration fixture', password: randomUUID() };
  const register = await request('/api/auth/register', { body });
  assert.equal(register.status, 200, await register.text());
  const login = await request('/api/auth/login', { body });
  const data = await login.json();
  assert.equal(login.status, 200, data.error);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie && data.user.id);
  return { cookie, id: data.user.id };
}

async function uploadImage(cookie) {
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#156baf' } }).png().toBuffer();
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/png' }), 'image.png');
  const response = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { Cookie: cookie }, body: form });
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  return { ...data, bytes };
}

async function run() {
  assert.deepEqual((await json('/api/chat')).messages, []);
  await json('/api/chat', { body: { message: 'unauthenticated' } }, 401);
  await json('/api/projects', { body: { description: 'unauthenticated' } }, 401);
  const [a, b] = await Promise.all(accounts.map(signIn));
  const legacy = await prisma.chatMessage.create({ data: { userId: a.id, role: 'user', content: 'Historical fixture' } });
  const legacyHistory = await json('/api/chat?conversationId=legacy', { cookie: a.cookie });
  assert(legacyHistory.messages.some(({ id }) => id === legacy.id));
  await json('/api/chat?conversationId=legacy', { cookie: b.cookie }, 404);

  const upload = await uploadImage(a.cookie);
  const preview = await request(upload.previewUrl, { cookie: a.cookie });
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), upload.bytes);
  assert.equal((await request(upload.previewUrl, { cookie: b.cookie })).status, 404);
  assert.equal((await request(upload.previewUrl)).status, 401);
  await json('/api/projects', { cookie: b.cookie, body: { featureId: 'screenshot-website', uploadId: upload.uploadId } }, 404);
  await json('/api/chat', { cookie: b.cookie, body: { message: 'Image', uploadId: upload.uploadId } }, 404);

  const conversationId = randomUUID();
  const first = { conversationId, mode: 'work', message: 'Измери изображението', uploadId: upload.uploadId, requestId: randomUUID(), toolId: 'image-properties' };
  const turn = await json('/api/chat', { cookie: a.cookie, body: first });
  assert.equal(turn.toolResult.toolId, 'image-properties');
  assert.match(turn.toolResult.text, /12\s*[×x]\s*8/i);
  const replay = await json('/api/chat', { cookie: a.cookie, body: first });
  assert.deepEqual(replay, turn);
  const loaded = await json(`/api/chat?conversationId=${conversationId}`, { cookie: a.cookie });
  assert.equal(loaded.conversationMode, 'work');
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].attachmentMime, 'image/png');
  assert.equal(loaded.messages[1].toolResult.id, turn.toolResult.id);
  await json(`/api/chat?conversationId=${conversationId}`, { cookie: b.cookie }, 404);
  await json('/api/chat', { cookie: b.cookie, body: { ...first, uploadId: null } }, 404);
  await json('/api/chat', { cookie: b.cookie, method: 'PATCH', body: { conversationId, mode: 'chat' } }, 404);
  await json('/api/chat', { cookie: a.cookie, method: 'PATCH', body: { conversationId, mode: 'chat' } });
  assert.equal((await json(`/api/chat?conversationId=${conversationId}`, { cookie: a.cookie })).conversationMode, 'chat');

  const branch = { ...first, mode: 'work', conversationId: randomUUID(), requestId: randomUUID(),
    branchFrom: { conversationId, messageId: turn.messages[0].id }, message: 'Провери отново' };
  await json('/api/chat', { cookie: b.cookie, body: { ...branch, uploadId: null } }, 404);
  const fork = await json('/api/chat', { cookie: a.cookie, body: branch });
  assert.notEqual(fork.conversationId, conversationId);
  assert.equal(fork.messages[0].content, branch.message);
  assert.equal((await json(`/api/chat?conversationId=${conversationId}`, { cookie: a.cookie })).messages[0].content, first.message);

  const projectInput = { name: 'Workspace integration fixture', description: 'A small website for a local bookstore with opening hours and contact details.', featureId: 'prompt-software', requestId: projectRequestId };
  const { project } = await json('/api/projects', { cookie: a.cookie, body: projectInput });
  const sameProject = await json('/api/projects', { cookie: a.cookie, body: projectInput });
  assert.equal(sameProject.project.id, project.id);
  await json('/api/chat', { cookie: b.cookie, body: { ...first, requestId: randomUUID(), conversationId: randomUUID(), projectId: project.id, uploadId: null } }, 404);
  const detail = `/api/projects/${project.id}`;
  for (const suffix of ['', '/preview', '/download', '/asset?file=public/index.html']) {
    assert.equal((await request(detail + suffix, { cookie: b.cookie })).status, 404);
    assert.equal((await request(detail + suffix)).status, 401);
  }
  let status;
  for (let attempt = 0; attempt < 30; attempt++) {
    status = await json(detail, { cookie: a.cookie });
    if (['COMPLETED', 'FAILED'].includes(status.project.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(status.project.status, 'COMPLETED');
  assert(status.previewUrl && status.downloadUrl && status.fileCount > 0);
  const html = await request(status.previewUrl, { cookie: a.cookie });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(await html.text(), /<html/i);
  const archive = await request(status.downloadUrl, { cookie: a.cookie });
  assert.equal(archive.status, 200);
  assert.equal(Buffer.from(await archive.arrayBuffer()).toString('ascii', 0, 2), 'PK');

  if (process.env.SHARKAI_TEST_CHAT_PROVIDER === '1') {
    assert(loaded.capabilities.models.some(({ id }) => id === 'standard'));
    const response = await request('/api/chat', { cookie: a.cookie, headers: { Accept: 'application/x-ndjson' },
      body: { conversationId: randomUUID(), requestId: randomUUID(), message: 'What animal says meow? Answer in one short sentence.' } });
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const chunks = (await response.text()).trim().split('\n').map(JSON.parse);
    assert(chunks.some(({ type }) => type === 'delta'), JSON.stringify(chunks));
    const done = chunks.at(-1);
    assert.equal(done.type, 'done');
    assert.ok(done.content.trim());
    assert.equal(chunks.filter(({ type }) => type === 'delta').map(({ text }) => text).join(''), done.content);
    const history = await json(`/api/chat?conversationId=${done.conversationId}`, { cookie: a.cookie });
    assert.equal(history.messages.at(-1).content, done.content);
  }

  console.log(`Workspace API passed: two accounts, legacy and conversation isolation, private files, tools, mode, branch, project, preview, ZIP${process.env.SHARKAI_TEST_CHAT_PROVIDER === '1' ? ', real provider stream' : ''}.`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email: { in: accounts } } });
  await prisma.$disconnect();
});
