import { Prisma, type ResearchJob } from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import { getAccountSession } from './auth';
import { remainingChatTokens } from './ai/workspace-chat';
import { prisma } from './db';
import { getHostedOpenAI, HostedWebSearchError, runHostedWebSearch, type HostedOpenAI, type HostedWebSearchResult } from './hosted-web-search';
import { searchNews, wantsNewsCoverage, type NewsHit } from './research-news';
import {
  readWikiArticles, researchTopic, searchCrossref, searchWiki,
  type ResearchSource, type ScholarlyHit, type WikiHit,
} from './research-sources';
import { synthesizeResearch, type ResearchFinding } from './research-synthesis';

const TOTAL_STAGES = 4;
const LEASE_TIME = 35_000;
const running = new Map<string, AbortController>();
const stageLabels = [
  'Търсене в Wikipedia', 'Търсене на публикации в Crossref', 'Извличане на текст от източниците', 'Подготовка на отчета', 'Отчетът е готов',
];

type WebEvidence = { status: 'attempted' | 'interrupted' | 'failed' } | { status: 'done'; result: HostedWebSearchResult };
type Evidence = { wiki: WikiHit[]; papers: ScholarlyHit[]; news?: NewsHit[]; web?: WebEvidence };
type ResolveHostedSearch = () => Promise<HostedOpenAI | null>;

export class ResearchInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function getTopic(raw: string) {
  const topic = researchTopic(raw).replace(/\s+/g, ' ');
  if (topic.length < 3 || topic.length > 300) throw new ResearchInputError('Въведи тема с дължина от 3 до 300 знака.');
  return topic;
}

export async function quickPublicSearch(raw: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const topic = getTopic(raw);
  const [wiki, papers] = await Promise.allSettled([searchWiki(topic, signal), searchCrossref(topic, signal)]);
  signal?.throwIfAborted();
  if (wiki.status === 'rejected' && papers.status === 'rejected') {
    throw new ResearchInputError('Wikipedia и Crossref не отговарят. Опитай отново.', 502);
  }
  const hits = [...(wiki.status === 'fulfilled' ? wiki.value.slice(0, 3) : []), ...(papers.status === 'fulfilled' ? papers.value.slice(0, 3) : [])];
  return hits.map(({ title, url, excerpt }) => ({ title, url, excerpt }));
}

function evidenceFor(job: ResearchJob): Evidence {
  return job.evidence as Evidence | null ?? { wiki: [], papers: [] };
}

function webWarning(evidence: Evidence) {
  if (evidence.web?.status === 'interrupted') return ['Предишното търсене чрез OpenAI бе прекъснато.'];
  if (evidence.web?.status === 'failed') return ['Търсенето чрез OpenAI не върна проверими резултати.'];
  if (evidence.web?.status === 'done' && evidence.web.result.partial) return ['OpenAI върна частичен синтез от уеб търсенето.'];
  return [];
}

function sourcesFor(evidence: Evidence) {
  const hosted = evidence.web?.status === 'done' ? evidence.web.result.sources : [];
  return [...new Map([...evidence.wiki, ...evidence.papers, ...(evidence.news ?? []), ...hosted].map((source) => [source.url, { title: source.title, url: source.url }])).values()];
}

function hostedParagraphs(result: HostedWebSearchResult, sourceIds: Map<string, number>, escape: (value: string) => string) {
  const paragraphs: string[] = [];
  let offset = 0;
  for (const paragraph of result.text.split(/\n\s*\n/)) {
    if (!paragraph.trim()) continue;
    const start = result.text.indexOf(paragraph, offset);
    offset = start + paragraph.length;
    const urls = [...new Set(result.citations.filter(({ end }) => end > start && end <= offset).map(({ url }) => url))];
    const links = urls.flatMap((url) => {
      const id = sourceIds.get(url);
      return id ? [`[${id}](${markdownUrl(url)})`] : [];
    });
    const text = escape(paragraph.replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/gi, '$1').replace(/https?:\/\/[^\s)\]<>]+/gi, '').trim());
    if (text) paragraphs.push([text, ...links].join(' '), '');
  }
  return paragraphs;
}

function markdownUrl(url: string) {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function reportMarkdown(topic: string, evidence: Evidence, warnings: string[], findings: ResearchFinding[]) {
  const escape = (value: string) => value.replace(/[\\`*_\[\]<>|]/g, '\\$&');
  const lines = [
    '# Проучване на SharkAI', '', `**Тема** · ${escape(topic)}`, '',
    `**Дата на проучването** · ${new Date().toISOString().slice(0, 10)} (UTC)`, '',
  ];
  const collection = [evidence.wiki.length ? 'Wikipedia' : '', evidence.papers.length ? 'Crossref' : ''].filter(Boolean);
  if (collection.length) lines.push(`Справочните материали са от ${collection.join(' и ')}. Те включват наличните извлечения и резюмета.`, '');
  const sources = sourcesFor(evidence);
  const sourceIds = new Map(sources.map((source, index) => [source.url, index + 1]));
  if (evidence.web?.status === 'done') {
    const result = evidence.web.result;
    lines.push('## Публично уеб търсене чрез OpenAI', '',
      'Този раздел съдържа синтеза на доставчика и връзките от неговите цитати.', '',
      ...hostedParagraphs(result, sourceIds, escape));
  }
  if (evidence.news?.length) {
    lines.push('## Медийни заглавия от Google Новини', '',
      'Публичният индекс предоставя заглавия, издания и време на публикация. Връзките се отварят през индекса.', '');
    for (const article of evidence.news) {
      const sourceId = sourceIds.get(article.url);
      const published = article.publishedAt.slice(0, 16).replace('T', ' ');
      lines.push(`- ${escape(article.title)} · ${escape(article.publisher)} · ${published} UTC [${sourceId}](${markdownUrl(article.url)})`);
    }
    lines.push('');
  }
  if (findings.length) {
    lines.push('## Синтез по източниците', '');
    for (const finding of findings) {
      const links = finding.sourceIds.map((id) => `[${id}](${sources[id - 1].url})`);
      lines.push(`- ${escape(finding.text)} ${links.join(' ')}`);
    }
    lines.push('');
  }
  if (evidence.wiki.length) lines.push('## Справочни статии', '');
  evidence.wiki.forEach((hit, index) => {
    lines.push(`### [${index + 1}] ${escape(hit.title)}`, '', hit.excerpt ? escape(hit.excerpt) : 'Източникът предоставя заглавие.', '');
  });
  if (evidence.papers.length) lines.push('## Публикации и DOI', '');
  evidence.papers.forEach((hit, offset) => {
    const details = [hit.publisher, hit.year].filter(Boolean).join(' · ');
    lines.push(`### [${evidence.wiki.length + offset + 1}] ${escape(hit.title)}`, '');
    if (details) lines.push(escape(details), '');
    lines.push(hit.excerpt ? escape(hit.excerpt) : 'Crossref предоставя библиографски запис за тази публикация.', '');
  });
  const notices = [...warnings, ...webWarning(evidence)];
  if (notices.length) lines.push('## Достъп до източниците', '', ...notices.map((warning) => `- ${warning}`), '');
  lines.push('## Връзки към източниците', '', ...sources.map((source, index) => `${index + 1}. [${escape(source.title)}](${markdownUrl(source.url)})`), '');
  return lines.join('\n');
}

export async function executeResearchJob(jobId: string, userId: string, resolveHosted: ResolveHostedSearch = getHostedOpenAI) {
  const now = new Date();
  const runnerId = randomUUID();
  const claim = await prisma.researchJob.updateMany({
    where: { id: jobId, userId, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', leaseUntil: { lte: now } }] },
    data: { status: 'RUNNING', runnerId, leaseUntil: new Date(now.getTime() + LEASE_TIME) },
  });
  if (!claim.count) return;
  const controller = new AbortController();
  running.set(jobId, controller);
  const where = { id: jobId, userId, runnerId, status: 'RUNNING' as const };
  const update = async (data: Prisma.ResearchJobUpdateManyMutationInput) => {
    const previous = await prisma.researchJob.updateMany({ where, data: { leaseUntil: new Date(Date.now() + LEASE_TIME), ...data } });
    return previous.count > 0;
  };

  try {
    const job = await prisma.researchJob.findFirst({ where });
    if (!job) return;
    const { stage, topic } = job;
    const evidence = evidenceFor(job);
    const warnings = [...job.warnings];
    const evidenceJson = () => evidence as unknown as Prisma.InputJsonValue;
    async function fromSource<T>(task: Promise<T>, fallback: T, message: string) {
      try { return await task; } catch {
        controller.signal.throwIfAborted();
        warnings.push(message);
        return fallback;
      }
    }
    const save = (stage: number) => update({ stage, evidence: evidenceJson(), warnings });
    if (stage < 1) {
      if (evidence.web?.status === 'attempted') {
        // The previous request's outcome is unknown. Keep the job without risking another billable search.
        evidence.web = { status: 'interrupted' };
        if (!(await update({ evidence: evidenceJson() }))) return;
      } else if (!evidence.web) {
        const account = await getAccountSession(userId);
        const outputBudget = account ? Math.min(2200, remainingChatTokens(account) - 400 - Buffer.byteLength(topic)) : 0;
        const openai = outputBudget >= 200 ? await resolveHosted().catch(() => null) : null;
        if (openai) {
          evidence.web = { status: 'attempted' };
          if (!(await update({ evidence: evidenceJson() }))) return;
          controller.signal.throwIfAborted();
          let usage = 0;
          try {
            const result = await runHostedWebSearch(openai, topic, {
              depth: 'research', maxOutputTokens: outputBudget,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(24_000)]),
            });
            usage = result.usageTokens;
            evidence.web = { status: 'done', result };
          } catch (error) {
            controller.signal.throwIfAborted();
            if (error instanceof HostedWebSearchError) usage = error.usageTokens;
            evidence.web = { status: 'failed' };
          }
          const accepted = await prisma.$transaction(async (tx) => {
            const checkpoint = await tx.researchJob.updateMany({
              where, data: { evidence: evidenceJson(), leaseUntil: new Date(Date.now() + LEASE_TIME) },
            });
            if (checkpoint.count && usage > 0) {
              await tx.user.update({ where: { id: userId }, data: { tokensUsed: { increment: usage } } });
            }
            return checkpoint.count > 0;
          });
          if (!accepted) return;
        }
      }
      evidence.wiki = await fromSource(searchWiki(topic, controller.signal), [], 'Търсенето в Wikipedia временно не отговори.');
      if (!(await save(1))) return;
    }
    if (stage < 2) {
      const lookupNews = () => fromSource(searchNews(topic, controller.signal), [], 'Индексът на Google Новини временно не отговори.');
      const [papers, news] = await Promise.all([
        fromSource(searchCrossref(topic, controller.signal), [], 'Търсенето в Crossref временно не отговори.'),
        wantsNewsCoverage(topic) ? lookupNews() : undefined,
      ]);
      evidence.papers = papers;
      if (news) evidence.news = news;
      else if (!evidence.wiki.length && !papers.length && evidence.web?.status !== 'done') evidence.news = await lookupNews();
      if (!(await save(2))) return;
    }
    if (stage < 3) {
      evidence.wiki = await fromSource(readWikiArticles(evidence.wiki, controller.signal), evidence.wiki, 'Wikipedia върна съкратени резултати от търсенето.');
      if (!(await save(3))) return;
    }
    controller.signal.throwIfAborted();
    if (!sourcesFor(evidence).length) {
      await update({ status: 'FAILED', error: 'Няма достъпни източници за темата. Опитай отново или използвай по-точна тема.', runnerId: null, leaseUntil: null });
      return;
    }
    const synthesis = evidence.web ? { findings: [], tokens: 0 }
      : await synthesizeResearch(userId, topic, evidence.wiki, evidence.papers, controller.signal);
    controller.signal.throwIfAborted();
    const report = reportMarkdown(topic, evidence, warnings, synthesis.findings);
    await prisma.$transaction(async (tx) => {
      const finished = await tx.researchJob.updateMany({
        where, data: { status: 'COMPLETED', stage: TOTAL_STAGES, report, runnerId: null, leaseUntil: null },
      });
      if (finished.count && synthesis.tokens > 0) {
        await tx.user.update({ where: { id: userId }, data: { tokensUsed: { increment: synthesis.tokens } } });
      }
    });
  } catch {
    if (!controller.signal.aborted) {
      await update({ status: 'FAILED', error: 'Проучването бе прекъснато. Можеш да го продължиш с повторен опит.', runnerId: null, leaseUntil: null });
    }
  } finally {
    if (running.get(jobId) === controller) running.delete(jobId);
  }
}

function resume(job: ResearchJob) {
  if (job.status !== 'QUEUED' && !(job.status === 'RUNNING' && job.leaseUntil && job.leaseUntil.getTime() <= Date.now())) return;
  waitUntil(executeResearchJob(job.id, job.userId).catch((error: unknown) => {
    console.error('Research execution failed:', error instanceof Error ? error.name : 'UnknownError');
  }));
}

export async function startResearch(userId: string, raw: string, requestId: string) {
  const topic = getTopic(raw);
  const job = await prisma.researchJob.upsert({
    where: { userId_requestId: { userId, requestId } },
    create: { id: randomUUID(), userId, requestId, topic },
    update: {},
  });
  resume(job);
  return job;
}

export function getResearch(id: string, userId: string) {
  return prisma.researchJob.findFirst({ where: { id, userId } });
}

export async function getResearchStatus(id: string, userId: string) {
  const job = await getResearch(id, userId);
  if (!job) throw new ResearchInputError('Проучването не е намерено.', 404);
  resume(job);
  return describeResearch(job);
}

export async function updateResearch(id: string, userId: string, action: 'cancel' | 'retry') {
  const job = await getResearch(id, userId);
  if (!job) throw new ResearchInputError('Проучването не е намерено.', 404);
  if (action === 'cancel') {
    const changed = await prisma.researchJob.updateMany({
      where: { id, userId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', runnerId: null, leaseUntil: null },
    });
    if (changed.count) running.get(id)?.abort();
  } else {
    const evidence = evidenceFor(job);
    const reset = job.stage === 3 && !sourcesFor(evidence).length;
    const retained = evidence.web ? { wiki: [], papers: [], web: evidence.web } as unknown as Prisma.InputJsonValue : Prisma.DbNull;
    await prisma.researchJob.updateMany({
      where: { id, userId, status: { in: ['FAILED', 'CANCELLED'] } },
      data: { status: 'QUEUED', error: null, ...(reset ? { stage: 0, warnings: [], evidence: retained } : {}) },
    });
  }
  return getResearchStatus(id, userId);
}

function describeResearch(job: ResearchJob) {
  const evidence = evidenceFor(job);
  const { wiki, papers, web } = evidence;
  const sources = sourcesFor(evidence);
  const webCount = web?.status === 'done' ? web.result.sources.length : 0;
  const newsCount = evidence.news?.length ?? 0;
  const stageLabel = job.stage === 0 && web?.status === 'attempted' ? 'Публично уеб търсене чрез OpenAI'
    : job.stage === 1 && wantsNewsCoverage(job.topic) ? 'Търсене на публикации и медийни заглавия'
      : stageLabels[job.stage];
  return {
    id: job.id, topic: job.topic, status: job.status, stage: job.stage, totalStages: TOTAL_STAGES,
    stageLabel, updatedAt: job.updatedAt,
    error: job.error, warnings: [...job.warnings, ...webWarning(evidence)], sources,
    summary: job.status === 'COMPLETED' ? `Справочни статии · ${wiki.length}. Библиографски записи · ${papers.length}.${newsCount ? ` Медийни заглавия · ${newsCount}.` : ''}${webCount ? ` Цитати от уеб търсене · ${webCount}.` : ''}` : undefined,
    downloadUrl: job.status === 'COMPLETED' && job.report ? `/api/chat/research/${job.id}/report` : null,
  };
}
