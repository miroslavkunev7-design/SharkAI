const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');

const base = new URL(process.env.SHARKAI_TEST_URL || 'http://127.0.0.1:3847');
assert(process.env.POSTGRES_PRISMA_URL, 'Configure a disposable local PostgreSQL database.');
const local = ['localhost', '127.0.0.1', '[::1]'];
assert(local.includes(base.hostname) && local.includes(new URL(process.env.POSTGRES_PRISMA_URL).hostname));
const prisma = new PrismaClient();
const emails = [];

async function request(route, cookie, payload) {
  const body = payload instanceof FormData ? payload : JSON.stringify(payload);
  return fetch(new URL(route, base), {
    method: payload ? 'POST' : 'GET',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(payload && typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
    body: payload ? body : undefined,
  });
}

async function json(route, cookie, payload, status = 200) {
  const response = await request(route, cookie, payload);
  const data = await response.json();
  assert.equal(response.status, status, data.error);
  return data;
}

async function register() {
  const email = 'studio-activity-' + randomUUID() + '@example.test';
  emails.push(email);
  const response = await request('/api/auth/register', null, { email, name: 'Studio activity fixture', password: randomUUID() });
  assert.equal(response.status, 200);
  const { user } = await response.json();
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  return { userId: user.id, cookie };
}

async function projectFromImage(cookie, name, image) {
  const form = new FormData();
  form.set('file', new Blob([image], { type: 'image/png' }), 'reference.png');
  const { uploadId } = await json('/api/upload', cookie, form);
  const { project } = await json('/api/projects', cookie, { featureId: 'screenshot-website', name, uploadId, requestId: randomUUID() });
  for (let attempt = 0; attempt < 150; attempt++) {
    const detail = await json('/api/projects/' + project.id, cookie);
    if (['COMPLETED', 'FAILED'].includes(detail.project.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Studio project did not reach its final state.');
}

async function run() {
  const owner = await register();
  const other = await register();
  const image = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#24588f' } }).png().toBuffer();
  const completed = await projectFromImage(owner.cookie, 'Completed Studio activity fixture', image);
  assert.equal(completed.project.status, 'COMPLETED');
  assert.equal(completed.agents.length, 6);
  assert.deepEqual(completed.agents.map(({ agentId }) => agentId).sort(), ['agent-1', 'agent-2', 'agent-5', 'agent-8', 'agent-13', 'supreme-brain'].sort());
  assert.ok(completed.agents.every(({ status, activity, duration, createdAt, output }) => status === 'completed' && activity === 'completed'
    && duration >= 0 && Date.parse(createdAt) >= Date.parse(completed.project.createdAt) && output));
  assert.ok(completed.files.includes('design/palette.json'));
  assert.ok(completed.files.includes('Dockerfile'));

  const badImage = Buffer.from('89504e470d0a1a0a', 'hex');
  const failed = await projectFromImage(owner.cookie, 'Failed Studio activity fixture', badImage);
  assert.equal(failed.project.status, 'FAILED');
  assert.deepEqual(failed.agents.map(({ agentId, status, activity }) => ({ agentId, status, activity })),
    [{ agentId: 'agent-1', status: 'failed', activity: 'failed' }]);
  assert.match(failed.agents[0].output, /изображение не можа да се прочете/);
  const latest = (await json('/api/projects/agents', owner.cookie)).runs;
  assert.equal(latest.find(({ agentId }) => agentId === 'agent-1')?.project.id, failed.project.id);
  assert.equal(latest.find(({ agentId }) => agentId === 'agent-1')?.activity, 'failed');
  assert.equal(latest.find(({ agentId }) => agentId === 'agent-8')?.activity, 'completed');

  const staged = await prisma.project.create({ data: {
    userId: owner.userId,
    name: 'In-progress fixture',
    status: 'BUILDING',
    analysis: JSON.stringify({ runSemantics: 'tracked' }),
    agents: { create: { agentId: 'agent-3', agentName: 'Backend Architect', status: 'running' } },
  }, include: { agents: true } });
  const stagedUrl = '/api/projects/' + staged.id;
  const running = await json(stagedUrl, owner.cookie);
  assert.equal(running.project.statusUnknown, false);
  assert.equal(running.agents[0].activity, 'running');
  const runningReceipt = (await json('/api/projects/agents', owner.cookie)).runs.find(({ agentId }) => agentId === 'agent-3');
  assert.equal(runningReceipt?.activity, 'running');
  assert.equal(runningReceipt.startedAt, runningReceipt.createdAt);
  assert.equal((await json('/api/projects', owner.cookie)).summary.active, 1);
  await json(stagedUrl, other.cookie, null, 404);
  assert.deepEqual((await json('/api/projects/agents', other.cookie)).runs, []);

  const expired = new Date(Date.now() - 180_000);
  await prisma.$transaction([
    prisma.project.update({ where: { id: staged.id }, data: { updatedAt: expired } }),
    prisma.agentRun.update({ where: { id: staged.agents[0].id }, data: { createdAt: expired } }),
  ]);
  const abandoned = await json(stagedUrl, owner.cookie);
  assert.equal(abandoned.project.statusUnknown, true);
  assert.equal(abandoned.agents[0].activity, 'unknown');
  assert.equal((await json('/api/projects/agents', owner.cookie)).runs.find(({ agentId }) => agentId === 'agent-3')?.activity, 'unknown');
  const listing = await json('/api/projects', owner.cookie);
  assert.equal(listing.summary.active, 0);
  assert.equal(listing.projects.find(({ id }) => id === staged.id)?.statusUnknown, true);
  console.log('Studio activity passed: six measured completions, real image-analysis failure, running and stale visibility after reload, owner isolation and truthful overview.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});
