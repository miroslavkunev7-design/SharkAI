import { Prisma, type ResearchJob } from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import { prisma } from './db';
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

type Evidence = { wiki: WikiHit[]; papers: ScholarlyHit[] };

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

function reportMarkdown(topic: string, evidence: Evidence, warnings: string[], findings: ResearchFinding[]) {
  const escape = (value: string) => value.replace(/[\\`*_\[\]<>|]/g, '\\$&');
  const lines = [
    '# Проучване на SharkAI', '', `**Тема** · ${escape(topic)}`, '',
    `**Дата на проучването** · ${new Date().toISOString().slice(0, 10)} (UTC)`, '',
    'Отчетът включва статии от Wikipedia и библиографски записи от Crossref. Текстът под източниците идва от предоставените извлечения и резюмета.', '',
  ];
  const sources = [...evidence.wiki, ...evidence.papers];
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
  if (warnings.length) lines.push('## Достъп до източниците', '', ...warnings.map((warning) => `- ${warning}`), '');
  lines.push('## Връзки към източниците', '', ...sources.map((source, index) => `${index + 1}. [${escape(source.title)}](${source.url})`), '');
  return lines.join('\n');
}

async function execute(jobId: string, userId: string) {
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
    async function fromSource<T>(task: Promise<T>, fallback: T, message: string) {
      try { return await task; } catch {
        controller.signal.throwIfAborted();
        warnings.push(message);
        return fallback;
      }
    }
    const save = (stage: number) => update({ stage, evidence: evidence as unknown as Prisma.InputJsonValue, warnings });
    if (stage < 1) {
      evidence.wiki = await fromSource(searchWiki(topic, controller.signal), [], 'Търсенето в Wikipedia временно не отговори.');
      if (!(await save(1))) return;
    }
    if (stage < 2) {
      evidence.papers = await fromSource(searchCrossref(topic, controller.signal), [], 'Търсенето в Crossref временно не отговори.');
      if (!(await save(2))) return;
    }
    if (stage < 3) {
      evidence.wiki = await fromSource(readWikiArticles(evidence.wiki, controller.signal), evidence.wiki, 'Wikipedia върна съкратени резултати от търсенето.');
      if (!(await save(3))) return;
    }
    controller.signal.throwIfAborted();
    if (!evidence.wiki.length && !evidence.papers.length) {
      await update({ status: 'FAILED', error: 'Няма достъпни източници за темата. Опитай отново или използвай по-точна тема.', runnerId: null, leaseUntil: null });
      return;
    }
    const synthesis = await synthesizeResearch(userId, topic, evidence.wiki, evidence.papers, controller.signal);
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
  waitUntil(execute(job.id, job.userId).catch((error: unknown) => {
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
    const { wiki, papers } = evidenceFor(job);
    const reset = job.stage === 3 && !wiki.length && !papers.length;
    await prisma.researchJob.updateMany({
      where: { id, userId, status: { in: ['FAILED', 'CANCELLED'] } },
      data: { status: 'QUEUED', error: null, ...(reset ? { stage: 0, warnings: [], evidence: Prisma.DbNull } : {}) },
    });
  }
  return getResearchStatus(id, userId);
}

function describeResearch(job: ResearchJob) {
  const { wiki, papers } = evidenceFor(job);
  const sources = [...wiki, ...papers].map(({ title, url }) => ({ title, url }));
  return {
    id: job.id, topic: job.topic, status: job.status, stage: job.stage, totalStages: TOTAL_STAGES,
    stageLabel: stageLabels[job.stage], updatedAt: job.updatedAt,
    error: job.error, warnings: job.warnings, sources,
    summary: job.status === 'COMPLETED' ? `Справочни статии · ${wiki.length}. Библиографски записи · ${papers.length}.` : undefined,
    downloadUrl: job.status === 'COMPLETED' && job.report ? `/api/chat/research/${job.id}/report` : null,
  };
}
