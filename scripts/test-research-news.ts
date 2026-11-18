import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { executeResearchJob, getResearchStatus } from '../lib/research';
import { parseNewsFeed, searchNews, wantsNewsCoverage, type NewsHit } from '../lib/research-news';

const indexUrl = 'https://news.google.com/rss/articles/fixture?oc=5';
const pubDate = 'Tue, 17 Nov 2026 10:29:00 GMT';
const sample = (url: string, time = pubDate) => `<item><title>Satellite &amp; launch - Publisher</title><link>${url}</link><pubDate>${time}</pubDate><source>Publisher</source></item>`;
const rss = (...items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;

assert(wantsNewsCoverage('Latest news about the European Space Agency'));
assert(wantsNewsCoverage('Актуални новини за метрото'));
assert(!wantsNewsCoverage('Marine heatwave physiology'));
assert.deepEqual(parseNewsFeed(rss(sample(indexUrl), sample(indexUrl), sample('https://example.test/'),
  sample('https://private@news.google.com/rss/articles/fixture'), sample('file:///tmp/fixture'),
  sample('https://news.google.com/rss/articles/no-date', 'today'))), [
  { title: 'Satellite & launch', publisher: 'Publisher', publishedAt: '2026-11-17T10:29:00.000Z', url: indexUrl },
]);
assert.throws(() => parseNewsFeed('<!DOCTYPE rss SYSTEM "https://example.test/data"><rss />'), /declaration/);
assert.throws(() => parseNewsFeed('<html />'), /Invalid news RSS/);
console.log('Public-news fixtures passed for dated metadata, archive links, duplicate removal and XML restrictions.');

async function live() {
  const local = ['localhost', '127.0.0.1', '[::1]'];
  assert(local.includes(new URL(process.env.POSTGRES_PRISMA_URL || '').hostname), 'Use a disposable local database.');
  const topic = 'latest news about European Space Agency';
  const hits = await searchNews(topic);
  assert(hits.length > 0 && hits.length <= 6);
  const account = await prisma.user.create({ data: {
    email: `public-news-${randomUUID()}@example.test`, passwordHash: 'fixture', tokensLimit: 0,
  } });
  try {
    const job = await prisma.researchJob.create({ data: { id: randomUUID(), userId: account.id, requestId: randomUUID(), topic } });
    const noHosted = async () => { throw new Error('A public-news test must not call a paid provider.'); };
    await executeResearchJob(job.id, account.id, noHosted);
    const stored = await prisma.researchJob.findUniqueOrThrow({ where: { id: job.id } });
    const news = (stored.evidence as { news?: NewsHit[] }).news;
    assert.equal(stored.status, 'COMPLETED', stored.error ?? undefined);
    assert.equal(stored.stage, 4);
    assert(news?.length, 'No live headlines were persisted.');
    assert.match(stored.report ?? '', /## Медийни заглавия от Google Новини/);
    assert.match(stored.report ?? '', /UTC \[\d+\]\(https:\/\/news\.google\.com\/rss\/articles\//);
    for (const item of news) {
      assert(stored.report?.includes(item.url));
      assert(stored.report?.includes(item.publishedAt.slice(0, 16).replace('T', ' ')));
      assert.equal(new URL(item.url).hostname, 'news.google.com');
    }
    const displayed = await getResearchStatus(job.id, account.id);
    assert.equal(displayed.totalStages, 4);
    assert.match(displayed.summary ?? '', /Медийни заглавия/);
    assert(news.every((item) => displayed.sources.some(({ url }) => url === item.url)));
    await assert.rejects(getResearchStatus(job.id, randomUUID()), { status: 404 });
    const checkpoint = await prisma.researchJob.create({ data: {
      id: randomUUID(), userId: account.id, requestId: randomUUID(), topic, stage: 2, status: 'RUNNING',
      evidence: stored.evidence as Prisma.InputJsonValue, leaseUntil: new Date(Date.now() - 1000),
    } });
    await executeResearchJob(checkpoint.id, account.id, noHosted);
    const recovered = await prisma.researchJob.findUniqueOrThrow({ where: { id: checkpoint.id } });
    assert.equal(recovered.status, 'COMPLETED');
    assert.deepEqual((recovered.evidence as unknown as { news: NewsHit[] }).news, news);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).tokensUsed, 0);
    console.log(`Live public-news job persisted ${news.length} real headlines, citations and timestamps, then recovered its source checkpoint.`);
    console.log(`Observed headline: ${news[0].title} · ${news[0].publisher} · ${news[0].publishedAt}`);
  } finally {
    await prisma.user.delete({ where: { id: account.id } });
  }
}

if (process.env.SHARKAI_TEST_NEWS_LIVE === '1') {
  live().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
