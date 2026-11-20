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

async function uploadFile(cookie, bytes, type, name) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type }), name);
  const response = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { Cookie: cookie }, body: form });
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  return { ...data, bytes };
}

async function verifyPrivateAudio(owner, other) {
  const pcm = Buffer.alloc(3200);
  const wave = Buffer.alloc(44);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(36 + pcm.length, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16000, 24);
  wave.writeUInt32LE(32000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(pcm.length, 40);
  const upload = await uploadFile(owner.cookie, Buffer.concat([wave, pcm]), 'audio/x-wav', 'private.wav');
  const path = `/api/upload/${upload.uploadId}`;
  const headers = { Range: 'bytes=0-43' };
  const partial = await request(path, { cookie: owner.cookie, headers });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-type'), 'audio/wav');
  assert.equal(partial.headers.get('content-range'), `bytes 0-43/${upload.bytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), wave);
  assert.equal((await request(path, { cookie: other.cookie, headers })).status, 404);
  assert.equal((await request(path, { headers })).status, 401);
  const download = await request(`${path}?download=private.wav`, { cookie: owner.cookie });
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), upload.bytes);
}

async function verifyStreamingAbort(account) {
  const conversationId = randomUUID();
  const requestId = randomUUID();
  const before = await prisma.user.findUniqueOrThrow({ where: { id: account.id }, select: { tokensUsed: true } });
  const stop = new AbortController();
  const response = await request('/api/chat', {
    cookie: account.cookie, signal: stop.signal, headers: { Accept: 'application/x-ndjson' },
    body: { conversationId, requestId, message: 'Write a long science fiction story in English with multiple sections. Begin the story directly.' },
  });
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const part = await reader.read();
      assert.ok(!part.done, 'The provider ended before cancellation could be tested.');
      pending += decoder.decode(part.value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      const events = lines.filter(Boolean).map(JSON.parse);
      const failure = events.find(({ type }) => type !== 'delta');
      assert.ok(!failure, JSON.stringify(failure));
      if (events.some(({ text }) => text)) break;
    }
    stop.abort();
    await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
    stop.abort();
  }
  const lease = { id: requestId, userId: account.id };
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await prisma.chatRequest.count({ where: lease }))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await prisma.chatRequest.count({ where: lease }), 0, 'The cancelled request lease was not released.');
  assert.equal(await prisma.chatMessage.count({ where: { requestId, userId: account.id } }), 0, 'The incomplete response was saved.');
  assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: account.id }, select: { tokensUsed: true } }), before);
  await json(`/api/chat?conversationId=${conversationId}`, { cookie: account.cookie }, 404);
}

async function verifyEntitlements(actor) {
  const cookie = actor.cookie;
  const user = { id: actor.id };
  const tokenState = { tokensUsed: 50, tokensLimit: 50 };
  const canChat = async () => (await json('/api/chat', { cookie })).capabilities.models.length > 0;
  const trial = { conversationId: randomUUID(), requestId: randomUUID(), message: 'What animal meows? Answer in one sentence.' };
  const select = { plan: true, role: true, tokensLimit: true, tokensUsed: true, stripeId: true };

  await prisma.user.update({ where: user, data: tokenState });
  assert.equal(await canChat(), false);
  await json('/api/chat', { cookie, body: trial }, 429);

  await prisma.user.update({ where: user, data: { plan: 'PRO', tokensUsed: 49 } });
  assert.equal((await json('/api/payments/status', { cookie })).plan, 'PRO');
  assert.equal(await canChat(), true);
  await prisma.user.update({ where: user, data: { tokensUsed: 50 } });
  assert.equal(await canChat(), false);
  await json('/api/chat', { cookie, body: trial }, 429);

  await prisma.user.update({ where: user, data: { plan: 'FREE', role: 'ADMIN' } });
  assert.equal(await canChat(), true);
  assert.deepEqual(await json('/api/payments/status', { cookie }), { plan: 'FREE', period: null, canPurchase: false });
  await json('/api/payments/checkout', { cookie, body: { plan: 'ULTRA' } }, 409);
  const adminResponse = await json('/api/chat', { cookie, body: trial });
  assert.ok(adminResponse.content.trim());
  const admin = await prisma.user.findUniqueOrThrow({ where: user, select });
  assert.equal(admin.plan, 'FREE');
  assert.equal(admin.role, 'ADMIN');
  assert.equal(admin.tokensLimit, 50);
  assert.equal(admin.stripeId, null);
  assert.ok(admin.tokensUsed > 50);
  assert.equal(await prisma.subscription.count({ where: { userId: actor.id } }), 0);

  await prisma.user.update({ where: user, data: { role: 'USER', ...tokenState } });
  const now = Date.now();
  const active = await prisma.subscription.create({ data: {
    userId: actor.id, plan: 'ULTRA', status: 'active',
    currentPeriodStart: new Date(now - 60_000), currentPeriodEnd: new Date(now + 2_678_400_000),
  } });
  const status = await json('/api/payments/status', { cookie });
  assert.equal(status.plan, 'ULTRA');
  assert.equal(status.period.currentPeriodStart, active.currentPeriodStart.toISOString());
  assert.equal(status.period.currentPeriodEnd, active.currentPeriodEnd.toISOString());
  assert.equal(await canChat(), true);
  const ultraResponse = await json('/api/chat', { cookie, body: { ...trial, requestId: randomUUID() } });
  assert.ok(ultraResponse.content.trim());
  const ultra = await prisma.user.findUniqueOrThrow({ where: user, select });
  assert.equal(ultra.plan, 'FREE');
  assert.equal(ultra.tokensLimit, 50);
  assert.ok(ultra.tokensUsed > 50);
  await prisma.subscription.update({ where: { id: active.id }, data: { currentPeriodEnd: new Date(now - 1) } });
  assert.equal((await json('/api/payments/status', { cookie })).plan, 'FREE');
  assert.equal(await canChat(), false);

  await prisma.user.update({ where: user, data: { plan: 'ULTRA' } });
  assert.equal((await json('/api/payments/status', { cookie })).plan, 'ULTRA');
  assert.equal(await canChat(), true);
}

async function run() {
  assert.deepEqual((await json('/api/chat')).messages, []);
  await json('/api/chat', { body: { message: 'unauthenticated' } }, 401);
  await json('/api/projects', { body: { description: 'unauthenticated' } }, 401);
  const [a, b] = await Promise.all(accounts.map(signIn));
  await json('/api/chat', { cookie: a.cookie, body: { message: 'Проверка', model: 'unsupported-model' } }, 400);
  const legacy = await prisma.chatMessage.create({ data: { userId: a.id, role: 'user', content: 'Historical fixture' } });
  const legacyHistory = await json('/api/chat?conversationId=legacy', { cookie: a.cookie });
  assert(legacyHistory.messages.some(({ id }) => id === legacy.id));
  await json('/api/chat?conversationId=legacy', { cookie: b.cookie }, 404);

  const image = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#156baf' } }).png().toBuffer();
  const upload = await uploadFile(a.cookie, image, 'image/png', 'image.png');
  const preview = await request(upload.previewUrl, { cookie: a.cookie });
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), upload.bytes);
  assert.equal((await request(upload.previewUrl, { cookie: b.cookie })).status, 404);
  assert.equal((await request(upload.previewUrl)).status, 401);
  await json('/api/projects', { cookie: b.cookie, body: { featureId: 'screenshot-website', uploadId: upload.uploadId } }, 404);
  await json('/api/chat', { cookie: b.cookie, body: { message: 'Image', uploadId: upload.uploadId } }, 404);
  await verifyPrivateAudio(a, b);

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
  const followUp = await json('/api/chat', { cookie: a.cookie, body: {
    conversationId, mode: 'work', requestId: randomUUID(), toolId: 'image-properties', message: 'Измери отново',
  } });
  assert.equal(followUp.messages[0].imagePath, upload.uploadId);
  assert.match(followUp.toolResult.text, /12\s*[×x]\s*8/i);

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
    assert(loaded.capabilities.models.some(({ id }) => id === 'auto'));
    assert(loaded.capabilities.models.some(({ id }) => id === 'gpt-6-luna'));
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
    await verifyStreamingAbort(a);
    await verifyEntitlements(b);
  }

  console.log(`Workspace API passed: two accounts, legacy and conversation isolation, private files, retained attachment, tools, mode, branch, project, preview, ZIP${process.env.SHARKAI_TEST_CHAT_PROVIDER === '1' ? ', real provider stream, cancellation and plan entitlements' : ''}.`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email: { in: accounts } } });
  await prisma.$disconnect();
});
