import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ResearchJob } from '@prisma/client';
import { prisma } from '../lib/db';
import { executeResearchJob, getResearchStatus, stageResearch, updateResearch } from '../lib/research';

const local = ['localhost', '127.0.0.1', '[::1]'];
assert(local.includes(new URL(process.env.POSTGRES_PRISMA_URL ?? '').hostname), 'Use a disposable local PostgreSQL database.');
const sourceRoutes: Record<string, string> = { 'en.wikipedia.org': '/wiki', 'api.crossref.org': '/crossref', 'news.google.com': '/news' };

function gate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => { open = resolve; });
  return { waiting, open };
}

function within<T>(operation: Promise<T>, message: string, ms = 5000) {
  return Promise.race([operation, delay(ms, undefined, { ref: false }).then(() => { throw new Error(message); })]);
}

async function pauseTransition(id: string, status: 'CANCELLED' | 'QUEUED', exercise: (entered: () => Promise<void>, resume: () => void) => Promise<void>) {
  const arrived = gate();
  const resume = gate();
  const original = prisma.researchJob.updateMany;
  let paused = false;
  Reflect.set(prisma.researchJob, 'updateMany', async (args: Parameters<typeof original>[0]) => {
    if (!paused && args.where?.id === id && args.data.status === status) {
      paused = true;
      arrived.open();
      await resume.waiting;
    }
    return original(args);
  });
  try {
    await exercise(() => within(arrived.waiting, `Research transition ${status} did not reach the write`), resume.open);
  } finally {
    resume.open();
    Reflect.set(prisma.researchJob, 'updateMany', original);
  }
}

function researchFixtures() {
  const scenarios = new Map<string, ReturnType<typeof scenario>>();
  const unexpected: string[] = [];
  function scenario(topic: string, heldRequests = 0, hasSources = true) {
    const blocks = Array.from({ length: heldRequests }, () => ({ started: gate(), closed: gate(), release: gate() }));
    return { topic, blocks, hasSources, calls: 0 };
  }
  const add = (...args: Parameters<typeof scenario>) => {
    const entry = scenario(...args);
    scenarios.set(entry.topic, entry);
    return entry;
  };
  const worker = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (value: unknown) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    async function respond() {
      if (url.pathname === '/wiki' && url.searchParams.get('prop') === 'extracts') {
        json({ query: { pages: [{ pageid: 1, extract: 'The fixture article describes a documented source for research.' }] } });
      } else if (url.pathname === '/wiki' && url.searchParams.get('list') === 'search') {
        const entry = scenarios.get(url.searchParams.get('srsearch') ?? '');
        assert(entry, 'Unknown fixture topic');
        const block = entry.blocks[entry.calls++];
        if (block) {
          response.once('close', block.closed.open);
          block.started.open();
          await Promise.race([block.closed.waiting, block.release.waiting]);
        }
        if (response.destroyed) return;
        const search = entry.hasSources ? [{ title: entry.topic, pageid: 1, snippet: 'Documented fixture.' }] : [];
        json({ query: { search } });
      } else if (url.pathname === '/crossref') {
        json({ message: { items: [] } });
      } else if (url.pathname === '/news') {
        response.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end('<rss><channel /></rss>');
      } else {
        throw new Error('Unexpected fixture route');
      }
    }
    void respond().catch((error: unknown) => {
      unexpected.push(error instanceof Error ? error.message : 'Unknown fixture request error');
      if (!response.destroyed) response.writeHead(500).end();
    });
  });
  return { add, scenarios, unexpected, worker };
}

const [childAction, childId, childUser] = process.argv.slice(2);
if (childAction === '--cancel-in-worker') {
  void updateResearch(childId, childUser, 'cancel').then((job) => {
    console.log(job.status);
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
} else {
  void test('Research job concurrency against PostgreSQL and loopback sources', async (t) => {
    const { add, scenarios, unexpected, worker } = researchFixtures();
    const originalFetch = globalThis.fetch;
    const emails = ['owner', 'outsider'].map((person) => `research-worker-${person}-${randomUUID()}@example.test`);
    t.after(async () => {
      for (const { blocks } of scenarios.values()) for (const block of blocks) block.release.open();
      globalThis.fetch = originalFetch;
      worker.closeAllConnections();
      await new Promise<void>((resolve) => worker.close(() => resolve()));
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
      await prisma.$disconnect();
      assert.deepEqual(unexpected, []);
    });
    worker.listen(0, '127.0.0.1');
    await once(worker, 'listening');
    const address = worker.address();
    assert(address && typeof address === 'object');
    globalThis.fetch = async (input, init) => {
      const source = new URL(input instanceof Request ? input.url : input);
      const route = sourceRoutes[source.hostname];
      if (!route) {
        unexpected.push(source.hostname);
        throw new Error('Research test attempted an unconfigured external request');
      }
      const target = new URL(route, `http://127.0.0.1:${address.port}`);
      target.search = source.search;
      return originalFetch(target, init);
    };
    const [owner, outsider] = await Promise.all(emails.map((email) => prisma.user.create({ data: {
      email, passwordHash: 'fixture', tokensLimit: 5000, tokensUsed: 5000,
    } })));
    const receipt = (job: Pick<ResearchJob, 'id' | 'requestId' | 'userId'>) => prisma.chatMessage.create({ data: {
      userId: job.userId, requestId: job.requestId, role: 'assistant', content: 'Research fixture',
      toolResult: { id: job.id, researchId: job.id, status: 'started', toolId: 'deep-research', label: 'Research fixture' },
    } });
    async function jobFor(topic: string, failed = false) {
      const job = await prisma.researchJob.create({ data: {
        id: randomUUID(), userId: owner.id, requestId: randomUUID(), topic,
        ...(failed ? { status: 'FAILED', stage: 3, evidence: { wiki: [], papers: [] }, error: 'Fixture failure' } : {}),
      } });
      await receipt(job);
      return job;
    }
    async function terminal(id: string) {
      for (let attempt = 0; attempt < 160; attempt++) {
        const job = await prisma.researchJob.findUniqueOrThrow({ where: { id } });
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return job;
        await delay(25);
      }
      throw new Error(`Research job ${id} did not finish`);
    }

    await t.test('a late cancel preserves the replacement attempt', async () => {
      const fixture = add('Concurrent cancellation magnetosphere', 2);
      const job = await jobFor(fixture.topic);
      const original = executeResearchJob(job.id, owner.id);
      try {
        await within(fixture.blocks[0].started.waiting, 'Initial research request did not start');
        await pauseTransition(job.id, 'CANCELLED', async (entered, resume) => {
          const stale = updateResearch(job.id, owner.id, 'cancel');
          await entered();
          assert.equal((await updateResearch(job.id, owner.id, 'cancel')).status, 'CANCELLED');
          await within(original, 'Original research run did not stop');
          assert.equal((await updateResearch(job.id, owner.id, 'retry')).id, job.id);
          await within(fixture.blocks[1].started.waiting, 'Replacement research request did not start');
          resume();
          assert.equal((await stale).status, 'RUNNING', 'A delayed cancel must preserve the replacement research run');
        });
      } finally {
        for (const block of fixture.blocks) block.release.open();
        await original;
        await terminal(job.id);
      }
      const done = await getResearchStatus(job.id, owner.id);
      assert.equal(done.status, 'COMPLETED');
      assert.equal(done.stage, done.totalStages);
      assert.equal(fixture.calls, 2);
      assert.deepEqual(done.sources, [{ title: fixture.topic, url: 'https://en.wikipedia.org/?curid=1' }]);
      assert.match((await terminal(job.id)).report ?? '', /https:\/\/en\.wikipedia\.org\/\?curid=1/);
      await assert.rejects(getResearchStatus(job.id, outsider.id), { status: 404 });
      await assert.rejects(updateResearch(job.id, outsider.id, 'retry'), { status: 404 });
      assert.equal((await updateResearch(job.id, owner.id, 'cancel')).downloadUrl, done.downloadUrl);
      assert.equal((await updateResearch(job.id, owner.id, 'retry')).downloadUrl, done.downloadUrl);
      assert.equal(fixture.calls, 2);
    });

    await t.test('a late retry preserves the replacement failure', async () => {
      const fixture = add('Repeated failure magnetosphere', 0, false);
      const job = await jobFor(fixture.topic, true);
      try {
        await pauseTransition(job.id, 'QUEUED', async (entered, resume) => {
          const stale = updateResearch(job.id, owner.id, 'retry');
          await entered();
          assert.equal((await updateResearch(job.id, owner.id, 'retry')).id, job.id);
          const failed = await terminal(job.id);
          assert.equal(failed.status, 'FAILED');
          assert.notEqual(failed.error, job.error);
          assert.equal(fixture.calls, 1);
          resume();
          assert.equal((await stale).status, 'FAILED', 'A delayed retry must preserve the replacement research failure');
        });
      } finally {
        await terminal(job.id);
      }
      assert.equal(fixture.calls, 1);
    });

    await t.test('cancel follows a queued attempt into its claim', async () => {
      const fixture = add('Claimed cancellation magnetosphere', 1);
      const job = await jobFor(fixture.topic);
      let execution: Promise<void> | undefined;
      try {
        await pauseTransition(job.id, 'CANCELLED', async (entered, resume) => {
          const cancel = updateResearch(job.id, owner.id, 'cancel');
          await entered();
          execution = executeResearchJob(job.id, owner.id);
          await within(fixture.blocks[0].started.waiting, 'The queued research attempt was not claimed');
          resume();
          assert.equal((await cancel).status, 'CANCELLED');
          await within(fixture.blocks[0].closed.waiting, 'Same-process cancellation left the source open');
        });
      } finally {
        fixture.blocks[0].release.open();
        await execution;
      }
      assert.equal((await terminal(job.id)).report, null);
    });

    await t.test('cancellation from a second process stops an open source request', async () => {
      const fixture = add('Cross-process cancellation magnetosphere', 1);
      const job = await jobFor(fixture.topic);
      const execution = executeResearchJob(job.id, owner.id);
      try {
        await within(fixture.blocks[0].started.waiting, 'Cross-process research request did not start');
        const sourceStarted = performance.now();
        const testPath = process.argv[1];
        const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', testPath, '--cancel-in-worker', job.id, owner.id], { timeout: 5000 });
        assert.equal(stdout.trim(), 'CANCELLED');
        await within(fixture.blocks[0].closed.waiting, 'Source socket did not close before the 8-second source timeout', Math.max(0, 6500 - (performance.now() - sourceStarted)));
        await within(execution, 'Cancelled worker did not settle');
      } finally {
        fixture.blocks[0].release.open();
        await execution;
      }
      const stopped = await terminal(job.id);
      assert.equal(stopped.status, 'CANCELLED');
      assert.equal(stopped.stage, 0);
      assert.equal(stopped.report, null);
    });

    await t.test('two workers recover an expired legacy lease once', async () => {
      const fixture = add('Expired research lease magnetosphere');
      const job = await jobFor(fixture.topic);
      await prisma.researchJob.update({ where: { id: job.id }, data: { status: 'RUNNING', leaseUntil: new Date(0), runnerId: randomUUID() } });
      await Promise.all([executeResearchJob(job.id, owner.id), executeResearchJob(job.id, owner.id)]);
      assert.equal((await terminal(job.id)).status, 'COMPLETED');
      assert.equal(fixture.calls, 1);
    });

    await t.test('a staged request only starts after its owner commits the matching receipt', async () => {
      const fixture = add('Staged research receipt magnetosphere');
      const requestId = randomUUID();
      const job = await stageResearch(owner.id, fixture.topic, requestId);
      assert.equal((await stageResearch(owner.id, `Deep research: ${fixture.topic}`, requestId)).id, job.id);
      await assert.rejects(stageResearch(owner.id, 'A different topic', requestId), { status: 409 });
      await receipt({ ...job, userId: outsider.id });
      await executeResearchJob(job.id, owner.id);
      assert.equal(fixture.calls, 0);
      await assert.rejects(getResearchStatus(job.id, owner.id), { status: 404 });
      await assert.rejects(updateResearch(job.id, owner.id, 'cancel'), { status: 404 });
      const queued = await prisma.researchJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(queued.status, 'QUEUED');
      assert.equal(queued.runnerId, null);
      await receipt(job);
      await executeResearchJob(job.id, owner.id);
      assert.equal((await getResearchStatus(job.id, owner.id)).status, 'COMPLETED');
      assert.equal(fixture.calls, 1);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).tokensUsed, 5000);
    });
  });
}
