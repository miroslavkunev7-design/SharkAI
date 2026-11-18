const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const base = new URL(process.env.SHARKAI_TEST_URL || 'http://127.0.0.1:3847');
const database = new URL(process.env.POSTGRES_PRISMA_URL || 'postgresql://localhost');
const local = ['localhost', '127.0.0.1', '[::1]'];
assert(local.includes(base.hostname) && local.includes(database.hostname), 'Run research tests against a local application and test database.');
const prisma = new PrismaClient();
const tag = randomUUID();
const emails = [`research-a-${tag}@example.test`, `research-b-${tag}@example.test`];

async function request(path, cookie, method = 'GET', body) {
  return fetch(new URL(path, base), {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(path, cookie, method = 'GET', body, expected = 200) {
  const response = await request(path, cookie, method, body);
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${data.error || ''}`);
  return data;
}

async function account(email) {
  const response = await request('/api/auth/register', null, 'POST', { email, password: randomUUID() });
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie && data.user.id);
  return { id: data.user.id, cookie };
}

async function waitForJob(path, cookie) {
  const stages = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const { job } = await call(path, cookie);
    stages.push(job.stage);
    if (!['QUEUED', 'RUNNING'].includes(job.status)) return { job, stages };
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  assert.fail(`Research did not complete. Observed stages: ${stages.join(', ')}`);
}

async function run() {
  const [a, b] = await Promise.all(emails.map(account));
  const payload = { message: 'Deep research: marine heatwave', mode: 'work', toolId: 'deep-research', requestId: randomUUID(), conversationId: randomUUID() };
  const response = await call('/api/chat', a.cookie, 'POST', payload);
  const { researchId } = response.toolResult;
  assert(researchId);
  assert.equal((await call('/api/chat', a.cookie, 'POST', payload)).toolResult.researchId, researchId);
  assert.equal(await prisma.researchJob.count({ where: { userId: a.id, requestId: payload.requestId } }), 1);
  const path = `/api/chat/research/${researchId}`;
  await call(path, b.cookie, 'GET', undefined, 404);
  await call(path, b.cookie, 'PATCH', { action: 'cancel' }, 404);
  await call(path, null, 'GET', undefined, 401);
  const { job, stages } = await waitForJob(path, a.cookie);
  assert.equal(job.status, 'COMPLETED', job.error);
  assert.equal(job.topic, 'marine heatwave');
  assert.equal(job.stage, job.totalStages);
  assert(stages.every((value, index) => index === 0 || value >= stages[index - 1]));
  assert(job.sources.some(({ url }) => new URL(url).hostname.endsWith('.wikipedia.org')), JSON.stringify(job.warnings));
  assert(job.sources.some(({ url }) => new URL(url).hostname === 'doi.org'), JSON.stringify(job.warnings));
  const report = await request(job.downloadUrl, a.cookie);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-type'), /text\/markdown/);
  const markdown = await report.text();
  assert.match(markdown, /Marine heatwave/i);
  assert.match(markdown, /https:\/\/doi\.org\//);
  for (const { url } of job.sources) assert(markdown.includes(url));
  const { tokensUsed } = await prisma.user.findUniqueOrThrow({ where: { id: a.id }, select: { tokensUsed: true } });
  if (process.env.SHARKAI_EXPECT_RESEARCH_SYNTHESIS === '1') {
    assert.match(markdown, /## Синтез по източниците/);
    assert.match(markdown.split('## Синтез по източниците')[1].split('## Справочни статии')[0], /\[\d+\]\(https:\/\/[^)]+\) \[\d+\]\(https:\/\/[^)]+\)/);
    assert(tokensUsed > 0);
  }
  await call('/api/chat', a.cookie, 'POST', payload);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: a.id }, select: { tokensUsed: true } })).tokensUsed, tokensUsed);
  await call(job.downloadUrl, b.cookie, 'GET', undefined, 404);
  const history = await call(`/api/chat?conversationId=${payload.conversationId}`, a.cookie);
  assert.equal(history.messages.at(-1).toolResult.researchId, researchId);

  const liveRecord = await prisma.researchJob.findUniqueOrThrow({ where: { id: researchId } });
  const interruptedId = randomUUID();
  await prisma.researchJob.create({ data: {
    id: interruptedId, userId: a.id, requestId: randomUUID(), topic: liveRecord.topic,
    status: 'RUNNING', stage: 3, evidence: liveRecord.evidence, leaseUntil: new Date(Date.now() - 1000),
  } });
  const recovered = await waitForJob(`/api/chat/research/${interruptedId}`, a.cookie);
  assert.equal(recovered.job.status, 'COMPLETED', recovered.job.error);
  assert.equal(recovered.stages[0], 3);
  assert.deepEqual(recovered.job.sources, job.sources);

  const cancelledId = randomUUID();
  await prisma.researchJob.create({ data: {
    id: cancelledId, userId: a.id, requestId: randomUUID(), topic: liveRecord.topic,
    status: 'RUNNING', stage: 2, evidence: liveRecord.evidence, leaseUntil: new Date(Date.now() + 30_000),
  } });
  const cancelledPath = `/api/chat/research/${cancelledId}`;
  assert.equal((await call(cancelledPath, a.cookie, 'PATCH', { action: 'cancel' })).job.status, 'CANCELLED');
  assert.equal((await call(cancelledPath, a.cookie)).job.downloadUrl, null);
  await call(cancelledPath, a.cookie, 'PATCH', { action: 'retry' });
  assert.equal((await waitForJob(cancelledPath, a.cookie)).job.status, 'COMPLETED');
  assert.equal((await call(cancelledPath, a.cookie, 'PATCH', { action: 'retry' })).job.status, 'COMPLETED');

  const search = await call('/api/chat', b.cookie, 'POST', { ...payload, message: 'Търси в интернет: marine heatwave', conversationId: randomUUID(), toolId: 'web-search' });
  assert(search.toolResult.sources.some(({ url }) => /^https:\/\/(?:[a-z]+\.wikipedia\.org|doi\.org)\//.test(url)));
  await prisma.user.update({ where: { id: b.id }, data: { tokensUsed: 5_000 } });
  const noQuota = await call('/api/chat', b.cookie, 'POST', { ...payload, requestId: randomUUID(), conversationId: randomUUID() });
  const evidenceOnly = await waitForJob(`/api/chat/research/${noQuota.toolResult.researchId}`, b.cookie);
  assert.equal(evidenceOnly.job.status, 'COMPLETED', evidenceOnly.job.error);
  const evidenceOnlyReport = await request(evidenceOnly.job.downloadUrl, b.cookie);
  const evidenceOnlyMarkdown = await evidenceOnlyReport.text();
  assert.match(evidenceOnlyMarkdown, /## Връзки към източниците/);
  assert.doesNotMatch(evidenceOnlyMarkdown, /## Синтез по източниците/);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: b.id }, select: { tokensUsed: true } })).tokensUsed, 5_000);
  console.log('Research API passed: Wikimedia, Crossref, report, reloading, owner isolation, idempotency, expired lease recovery, cancel and retry.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});
