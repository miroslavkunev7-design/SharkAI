import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { executeResearchJob, getResearchStatus } from '../lib/research';

const rawDatabase = process.env.POSTGRES_PRISMA_URL ?? 'postgresql://localhost';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(rawDatabase).hostname), 'Use a disposable local database.');
const left = 'https://science.example.test/ocean-studies';
const right = 'https://publisher.example.test/record';
const text = 'The first fixture describes an increase in marine heatwaves.\n\nThe second fixture describes impacts on coral reefs.';
const topic = 'marine heatwave';

async function run() {
  const account = await prisma.user.create({ data: { email: `hosted-research-${randomUUID()}@example.test`, passwordHash: 'fixture', tokensLimit: 5000 } });
  try {
    const makeJob = (extra: Partial<Prisma.ResearchJobUncheckedCreateInput> = {}) => prisma.researchJob.create({ data: {
      id: randomUUID(), userId: account.id, requestId: randomUUID(), topic, ...extra,
    } });
    const finished = await makeJob();
    let searches = 0;
    let wireFailure: unknown;
    const controlled = createOpenAI({ apiKey: 'fixture-key', fetch: async (input, init) => {
      searches += 1;
      try {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).hostname, 'api.openai.com');
        assert.equal(new URL(request.url).pathname, '/v1/responses');
        const body = await request.json();
        assert.equal(body.store, false);
        assert.equal(body.tool_choice.type, 'web_search');
        assert(body.tools.some((tool: { type: string }) => tool.type === 'web_search'));
        const claimed = await prisma.researchJob.findUniqueOrThrow({ where: { id: finished.id } });
        assert.equal((claimed.evidence as { web?: { status: string } })?.web?.status, 'attempted');
        const split = text.indexOf('\n\n');
        return Response.json({
          id: 'resp_test', model: 'gpt-4.1', created_at: Math.floor(Date.now() / 1000),
          output: [
            { type: 'web_search_call', id: 'ws_test', status: 'completed', action: { type: 'search', query: topic } },
            { type: 'message', role: 'assistant', id: 'msg_test', content: [
              { type: 'output_text', text, annotations: [
                { type: 'url_citation', start_index: split - 10, end_index: split, url: left, title: 'Ocean studies' },
                { type: 'url_citation', start_index: text.length - 10, end_index: text.length, url: right, title: 'Publisher record' },
                { type: 'url_citation', start_index: 0, end_index: 5, url: 'file:///etc/passwd', title: 'Invalid citation' },
              ] },
            ] },
          ],
          usage: { input_tokens: 340, output_tokens: 70, total_tokens: 410 },
        });
      } catch (error) {
        wireFailure = error;
        throw error;
      }
    } });
    const resolve = async () => controlled;
    await Promise.all([executeResearchJob(finished.id, account.id, resolve), executeResearchJob(finished.id, account.id, resolve)]);
    if (wireFailure) throw wireFailure;
    const stored = await prisma.researchJob.findUniqueOrThrow({ where: { id: finished.id } });
    assert.equal(stored.status, 'COMPLETED', stored.error ?? undefined);
    assert.equal(stored.stage, 4);
    assert.equal(searches, 1);
    assert(stored.report?.includes('## Публично уеб търсене чрез OpenAI'), 'The controlled provider response was rejected.');
    assert.match(stored.report ?? '', /marine heatwaves\. \[\d+\]\(https:\/\/science\.example\.test\/ocean-studies\)/);
    assert.match(stored.report ?? '', /coral reefs\. \[\d+\]\(https:\/\/publisher\.example\.test\/record\)/);
    assert.doesNotMatch(stored.report ?? '', /file:\/\//);
    const overview = await getResearchStatus(stored.id, account.id);
    assert(overview.sources.some(({ url }) => url === left));
    assert(overview.sources.some(({ url }) => url === right));
    assert(overview.sources.some(({ url }) => new URL(url).hostname.endsWith('.wikipedia.org')));
    assert(overview.sources.some(({ url }) => new URL(url).hostname === 'doi.org'));
    await executeResearchJob(finished.id, account.id, resolve);
    const accountAfter = () => prisma.user.findUniqueOrThrow({ where: { id: account.id }, select: { tokensUsed: true } });
    assert.equal((await accountAfter()).tokensUsed, 410);

    const checkpoint = await makeJob({ status: 'RUNNING', stage: 3, evidence: stored.evidence as Prisma.InputJsonValue,
      leaseUntil: new Date(Date.now() - 1000) });
    await executeResearchJob(checkpoint.id, account.id, resolve);
    assert.equal((await getResearchStatus(checkpoint.id, account.id)).status, 'COMPLETED');
    assert.equal(searches, 1);
    assert.equal((await accountAfter()).tokensUsed, 410);

    const interrupted = await makeJob({ status: 'RUNNING', evidence: { wiki: [], papers: [], web: { status: 'attempted' } },
      leaseUntil: new Date(Date.now() - 1000) });
    await executeResearchJob(interrupted.id, account.id, resolve);
    const fallback = await getResearchStatus(interrupted.id, account.id);
    assert.equal(fallback.status, 'COMPLETED', fallback.error ?? undefined);
    assert.match(fallback.warnings.join(' '), /OpenAI бе прекъснато/);
    assert(fallback.sources.every(({ url }) => ['en.wikipedia.org', 'doi.org'].includes(new URL(url).hostname)));
    assert.equal(searches, 1);
    assert.equal((await accountAfter()).tokensUsed, 410);

    await prisma.user.update({ where: { id: account.id }, data: { tokensUsed: 5000 } });
    const exhausted = await makeJob();
    await executeResearchJob(exhausted.id, account.id, async () => { assert.fail('Exhausted account must not load hosted provider'); });
    assert.equal((await getResearchStatus(exhausted.id, account.id)).status, 'COMPLETED');
    assert.equal(searches, 1);
    assert.equal((await accountAfter()).tokensUsed, 5000);
    console.log('Hosted research passed with a controlled Responses fixture and real public fallback. No live OpenAI credentials used.');
  } finally {
    await prisma.user.delete({ where: { id: account.id } });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
