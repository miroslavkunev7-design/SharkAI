import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { getAccountSession } from '../lib/auth';
import { prisma } from '../lib/db';
import { executeImageJob, getImageJobStatus, stageImageJob, updateImageJob, type ImageJobTool } from '../lib/image-jobs';
import { readOwnedUpload, saveUpload } from '../lib/uploads';

assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.POSTGRES_PRISMA_URL ?? '').hostname), 'Use a disposable local PostgreSQL database.');

async function run() {
  const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#156baf' } }).png().toBuffer();
  const counts = new Map<string, number>();
  let beganCancel!: () => void;
  let letCanceledReturn!: () => void;
  let beganRemote!: () => void;
  let letRemoteReturn!: () => void;
  const started = new Promise<void>((resolve) => { beganCancel = resolve; });
  const release = new Promise<void>((resolve) => { letCanceledReturn = resolve; });
  const remoteStarted = new Promise<void>((resolve) => { beganRemote = resolve; });
  const remoteRelease = new Promise<void>((resolve) => { letRemoteReturn = resolve; });
  const worker = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/images');
      assert.equal(request.headers.authorization, 'Bearer fixture-token');
      const chunks = [];
      for await (const part of request) chunks.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const prompt: string = body.prompt;
      const count = (counts.get(prompt) ?? 0) + 1;
      counts.set(prompt, count);
      if (prompt === 'Busy fixture' && count === 1) { response.writeHead(429).end(); return; }
      if (prompt === 'Cancel fixture' && count === 1) { beganCancel(); await release; }
      if (prompt === 'Remote cancel fixture') { beganRemote(); await remoteRelease; }
      if (prompt === 'Edit fixture') {
        assert.equal(body.mimeType, 'image/png');
        assert.equal(body.image, png.toString('base64'));
      }
      response.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address();
  assert(address && typeof address === 'object');
  process.env.SHARKAI_IMAGE_WORKER_URL = `http://127.0.0.1:${address.port}`;
  process.env.SHARKAI_IMAGE_WORKER_TOKEN = 'fixture-token';
  const tag = randomUUID();
  const emails = [`async-image-a-${tag}@example.test`, `async-image-b-${tag}@example.test`];
  try {
    const [account, outsider] = await Promise.all(emails.map((email) => prisma.user.create({ data: { email, passwordHash: 'fixture', tokensLimit: 5000 } })));
    const owner = await getAccountSession(account.id);
    const other = await getAccountSession(outsider.id);
    assert(owner && other);
    const stage = async (prompt: string, toolId: ImageJobTool = 'image-generate', uploadId?: string) => {
      const requestId = randomUUID();
      const input = { prompt, toolId, uploadId };
      const job = await stageImageJob(owner, requestId, input);
      return { ...job, requestId, input };
    };
    const receipt = (job: { id: string; requestId: string; input: { toolId: string } }) => prisma.chatMessage.create({ data: {
      userId: owner.id, requestId: job.requestId, role: 'assistant', content: 'Queued fixture',
      toolResult: { id: job.id, imageJobId: job.id, status: 'started', toolId: job.input.toolId, label: 'Fixture' },
    } });
    const outputs = () => prisma.fileUpload.count({ where: { userId: owner.id } });
    async function waitForResult(id: string) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const job = await getImageJobStatus(id, account.id);
        if (job.status === 'COMPLETED') return job;
        assert(!['FAILED', 'CANCELLED'].includes(job.status), job.error ?? job.status);
        await delay(25);
      }
      throw new Error('Image job did not complete');
    }

    const busy = await stage('Busy fixture');
    const initialCount = await outputs();
    await executeImageJob(busy.id, owner.id);
    assert.equal(counts.size, 0, 'A staged job cannot run before its chat receipt is committed');
    assert.deepEqual(await stageImageJob(owner, busy.requestId, busy.input), { id: busy.id });
    await assert.rejects(stageImageJob(owner, busy.requestId, { ...busy.input, prompt: 'Different prompt' }), { status: 409 });
    await assert.rejects(stageImageJob(owner, busy.requestId, { ...busy.input, toolId: 'image-edit' }), { status: 409 });
    await assert.rejects(stageImageJob(owner, busy.requestId, { ...busy.input, uploadId: randomUUID() }), { status: 409 });
    await assert.rejects(getImageJobStatus(busy.id, other.id), { status: 404 });
    await assert.rejects(updateImageJob(busy.id, other.id, 'cancel'), { status: 404 });
    await receipt(busy);
    await executeImageJob(busy.id, owner.id);
    const waiting = await getImageJobStatus(busy.id, owner.id);
    assert.equal(waiting.status, 'QUEUED');
    assert(waiting.nextAttemptAt);
    await executeImageJob(busy.id, owner.id);
    assert.equal(counts.get(busy.input.prompt), 1);
    await prisma.imageJob.update({ where: { id: busy.id }, data: { runAfter: new Date(0) } });
    await Promise.all([executeImageJob(busy.id, owner.id), executeImageJob(busy.id, owner.id)]);
    const done = await waitForResult(busy.id);
    assert.equal(counts.get(busy.input.prompt), 2);
    assert.equal(await outputs(), initialCount + 1);
    assert(done.artifact);
    const outputId = done.artifact.url.split('/').at(-1)!;
    assert(Buffer.from((await readOwnedUpload(outputId, owner.id))?.data ?? []).equals(png));
    assert.equal(await readOwnedUpload(outputId, other.id), null);
    const saved = await prisma.chatMessage.findFirstOrThrow({ where: { userId: owner.id, requestId: busy.requestId, role: 'assistant' } });
    assert.match(saved.content, /готово/);
    assert.deepEqual((saved.toolResult as { artifact?: unknown }).artifact, done.artifact);
    assert.equal((await updateImageJob(busy.id, owner.id, 'retry')).artifact?.url, done.artifact.url);
    assert.equal(await outputs(), initialCount + 1);

    const canceled = await stage('Cancel fixture');
    await receipt(canceled);
    const inflight = executeImageJob(canceled.id, owner.id);
    await Promise.race([started, delay(2000).then(() => { throw new Error('Worker did not start cancellation fixture'); })]);
    assert.equal((await updateImageJob(canceled.id, owner.id, 'cancel')).status, 'CANCELLED');
    letCanceledReturn();
    await inflight;
    assert.equal(await outputs(), initialCount + 1);
    assert.equal((await updateImageJob(canceled.id, owner.id, 'retry')).id, canceled.id);
    const retried = await waitForResult(canceled.id);
    assert.equal(retried.id, canceled.id);
    assert.equal(counts.get(canceled.input.prompt), 2);
    assert.equal(await outputs(), initialCount + 2);

    const remote = await stage('Remote cancel fixture');
    await receipt(remote);
    const remoteInflight = executeImageJob(remote.id, owner.id);
    await Promise.race([remoteStarted, delay(2000).then(() => { throw new Error('Remote cancellation fixture did not start'); })]);
    // A different app process changes the lease in PostgreSQL without access to the local controller.
    await prisma.imageJob.update({ where: { id: remote.id }, data: { status: 'CANCELLED', runnerId: null, leaseUntil: null } });
    await Promise.race([remoteInflight, delay(5500, undefined, { ref: false }).then(() => { throw new Error('Lost lease did not abort worker HTTP'); })]);
    letRemoteReturn();
    assert.equal(await outputs(), initialCount + 2);

    const upload = await saveUpload(png, 'image/png', owner.id);
    await assert.rejects(stageImageJob(other, randomUUID(), { toolId: 'image-edit', prompt: 'Invalid source', uploadId: upload.id }), { status: 404 });
    const edit = await stage('Edit fixture', 'image-edit', upload.id);
    await receipt(edit);
    await prisma.imageJob.update({ where: { id: edit.id }, data: { status: 'RUNNING', runnerId: randomUUID(), leaseUntil: new Date(0) } });
    const resumed = await waitForResult(edit.id);
    assert.equal(resumed.artifact?.filename, 'revision.png');
    assert.equal(counts.get(edit.input.prompt), 1);

    const quota = await stage('Quota fixture');
    await receipt(quota);
    await prisma.user.update({ where: { id: owner.id }, data: { tokensUsed: 5000 } });
    await executeImageJob(quota.id, owner.id);
    const stopped = await getImageJobStatus(quota.id, owner.id);
    assert.equal(stopped.status, 'FAILED');
    assert(stopped.retryable);
    assert.equal(counts.get(quota.input.prompt), undefined);
    await prisma.user.update({ where: { id: owner.id }, data: { tokensUsed: 0 } });
    assert.equal((await updateImageJob(quota.id, owner.id, 'retry')).id, quota.id);
    await waitForResult(quota.id);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).tokensUsed, 0);
    console.log('Image job tests passed against a controlled local worker: commit gate, busy backoff, concurrency, isolation, local and cross-process cancellation, same-ID retry, lease recovery, real receipt persistence and quota.');
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    letCanceledReturn();
    letRemoteReturn();
    worker.closeAllConnections();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
