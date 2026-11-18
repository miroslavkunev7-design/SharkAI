import { randomUUID } from 'node:crypto';
import { Prisma, type ImageJob } from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { getAccountSession, type AccountSession } from './auth';
import { remainingChatTokens } from './ai/workspace-chat';
import { prisma } from './db';
import { jobAttemptId, sameJobAttempt } from './job-attempt';
import { LocalImageError, runLocalImage } from './local-image.server';
import { readOwnedUpload } from './uploads';

const LEASE_MS = 170_000;
const BUSY_RETRY_MS = 4_000;
const CANCEL_CHECK_MS = 2_000;
const running = new Map<string, AbortController>();
const imageMimes = ['image/png', 'image/jpeg', 'image/webp'];
const phases: Record<ImageJob['status'], string> = {
  QUEUED: 'В опашката', RUNNING: 'Доставчикът обработва изображението', COMPLETED: 'Изображението е готово',
  FAILED: 'Изпълнението е неуспешно', CANCELLED: 'Изпълнението е отменено',
};

export type ImageJobTool = 'image-generate' | 'image-edit';

export class ImageJobError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: 'IMAGE_JOB_MIGRATION_REQUIRED') { super(message); }
}

function imageJobStorageError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
    throw new ImageJobError('Приложи миграцията за задачи за изображения (prisma/upgrade/image-jobs.sql).', 503, 'IMAGE_JOB_MIGRATION_REQUIRED');
  }
  throw error;
}

function checkQuota(session: AccountSession) {
  if (remainingChatTokens(session) <= 0) throw new ImageJobError('Достигнат е лимитът на текущия план.', 429);
}

async function sourceFile(userId: string, toolId: string, uploadId?: string | null) {
  if (!uploadId) {
    if (toolId === 'image-edit') throw new ImageJobError('Прикачи изображението за редактиране.');
    return undefined;
  }
  const file = await readOwnedUpload(uploadId, userId);
  if (!file) throw new ImageJobError('Изображението за редактиране не е намерено.', 404);
  if (!imageMimes.includes(file.mimeType)) throw new ImageJobError('Използвай изображение PNG, JPEG или WebP.', 415);
  if (file.data.length > 10 * 1024 * 1024) throw new ImageJobError('Изображението надвишава размера за редактиране.', 413);
  return { data: Buffer.from(file.data), mimeType: file.mimeType };
}

export async function stageImageJob(session: AccountSession, requestId: string, input: { toolId: ImageJobTool; prompt: string; uploadId?: string }) {
  checkQuota(session);
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 3000 || prompt.includes('\0')) throw new ImageJobError('Въведи описание от 1 до 3000 знака.');
  const { toolId, uploadId } = input;
  const key = { userId_requestId: { userId: session.id, requestId } };
  const selected = { id: true, toolId: true, prompt: true, uploadId: true } as const;
  const checkReplay = (prior: Pick<ImageJob, 'id' | 'toolId' | 'prompt' | 'uploadId'>) => {
    if (prior.toolId !== toolId || prior.prompt !== prompt || prior.uploadId !== (uploadId ?? null)) {
      throw new ImageJobError('Този идентификатор вече е използван за различна заявка за изображение.', 409);
    }
    return { id: prior.id };
  };
  try {
    if (!prisma.imageJob) throw new ImageJobError('Генерирай Prisma клиента за задачите за изображения.', 503, 'IMAGE_JOB_MIGRATION_REQUIRED');
    const prior = await prisma.imageJob.findUnique({ where: key, select: selected });
    if (prior) return checkReplay(prior);
    await sourceFile(session.id, toolId, uploadId);
    return await prisma.imageJob.create({
      data: { id: randomUUID(), userId: session.id, requestId, toolId, prompt, uploadId }, select: { id: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return checkReplay(await prisma.imageJob.findUniqueOrThrow({ where: key, select: selected }));
    }
    return imageJobStorageError(error);
  }
}

function assistantReceipt(job: ImageJob): Prisma.ChatMessageWhereInput {
  return {
    userId: job.userId, requestId: job.requestId, role: 'assistant',
    toolResult: { path: ['imageJobId'], equals: job.id },
  };
}

function artifactFor(job: ImageJob, outputId: string) {
  return { url: `/api/upload/${outputId}`, mimeType: 'image/png', filename: job.toolId === 'image-edit' ? 'revision.png' : 'image.png' };
}

function isRunnable(job: ImageJob, now = new Date()) {
  return (job.status === 'QUEUED' && job.runAfter <= now)
    || (job.status === 'RUNNING' && !!job.leaseUntil && job.leaseUntil <= now);
}

export async function executeImageJob(id: string, userId: string) {
  const job = await prisma.imageJob.findFirst({ where: { id, userId } });
  if (!job || !isRunnable(job)) return;
  const receipt = await prisma.chatMessage.findFirst({ where: assistantReceipt(job), select: { id: true, toolResult: true } });
  if (!receipt) return;

  const now = new Date();
  const attemptId = jobAttemptId(job);
  const runnerId = `${attemptId}:${randomUUID()}`;
  const claimed = await prisma.imageJob.updateMany({
    where: { id, userId, runnerId: job.runnerId, OR: [{ status: 'QUEUED', runAfter: { lte: now } }, { status: 'RUNNING', leaseUntil: { lte: now } }] },
    data: { status: 'RUNNING', runnerId, leaseUntil: new Date(now.getTime() + LEASE_MS), error: null, retryable: false },
  });
  if (!claimed.count) return;

  const controller = new AbortController();
  running.set(attemptId, controller);
  const where = { id, userId, runnerId, status: 'RUNNING' as const };
  let checkingLease = false;
  const watchCancellation = setInterval(() => {
    if (checkingLease || controller.signal.aborted) return;
    checkingLease = true;
    void prisma.imageJob.count({ where }).then((active) => {
      if (!active) controller.abort();
    }).catch(() => {}).finally(() => { checkingLease = false; });
  }, CANCEL_CHECK_MS);
  watchCancellation.unref();
  try {
    const account = await getAccountSession(userId);
    if (!account) throw new ImageJobError('Акаунтът не е достъпен.', 401);
    checkQuota(account);
    const file = await sourceFile(userId, job.toolId, job.uploadId);
    if (!(await prisma.imageJob.count({ where }))) return;
    controller.signal.throwIfAborted();
    const image = await runLocalImage({ prompt: job.prompt, file, signal: controller.signal });
    controller.signal.throwIfAborted();
    const outputId = randomUUID();
    const artifact = artifactFor(job, outputId);
    const content = job.toolId === 'image-edit' ? 'Редактираното изображение е готово.' : 'Изображението е готово.';
    const toolResult = { ...receipt.toolResult as Prisma.JsonObject, status: 'completed', text: content, url: artifact.url, artifact };
    await prisma.$transaction(async (tx) => {
      const checkpoint = await tx.imageJob.updateMany({
        where, data: { status: 'COMPLETED', outputId, runnerId: attemptId, leaseUntil: null },
      });
      if (!checkpoint.count) return;
      // The result is stored in PostgreSQL so the private upload and receipt commit together even across app instances.
      await tx.fileUpload.create({ data: { id: outputId, userId, data: new Uint8Array(image.data), mimeType: image.mimeType, ext: 'png' } });
      const message = await tx.chatMessage.updateMany({ where: { ...assistantReceipt(job), id: receipt.id }, data: { content, toolResult } });
      if (!message.count) throw new ImageJobError('Записът за задачата в разговора липсва.', 404);
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof LocalImageError && error.status === 429) {
      await prisma.imageJob.updateMany({ where, data: {
        status: 'QUEUED', runAfter: new Date(Date.now() + BUSY_RETRY_MS), runnerId: attemptId, leaseUntil: null,
        error: 'Доставчикът обработва друго изображение. Задачата изчаква.',
      } });
      return;
    }
    const known = error instanceof LocalImageError || error instanceof ImageJobError;
    await prisma.imageJob.updateMany({ where, data: {
      status: 'FAILED', runnerId: attemptId, leaseUntil: null,
      retryable: !known || error.status === 429 || error.status >= 500,
      error: known ? error.message : 'Задачата за изображение бе прекъсната. Опитай отново.',
    } });
  } finally {
    clearInterval(watchCancellation);
    if (running.get(attemptId) === controller) running.delete(attemptId);
  }
}

export function kickImageJob(id: string, userId: string) {
  waitUntil(executeImageJob(id, userId).catch((error: unknown) => {
    console.error('Image job execution failed:', error instanceof Error ? error.name : 'UnknownError');
  }));
}

async function ownedJob(id: string, userId: string) {
  if (!prisma.imageJob) throw new ImageJobError('Генерирай Prisma клиента за задачите за изображения.', 503, 'IMAGE_JOB_MIGRATION_REQUIRED');
  try {
    const job = await prisma.imageJob.findFirst({ where: { id, userId } });
    if (!job) throw new ImageJobError('Задачата за изображение не е намерена.', 404);
    return job;
  } catch (error) { return imageJobStorageError(error); }
}

function describe(job: ImageJob) {
  return {
    id: job.id, toolId: job.toolId, status: job.status,
    phaseLabel: job.status === 'QUEUED' && job.error ? 'Изчаква свободен доставчик' : phases[job.status],
    error: job.error, retryable: job.retryable,
    artifact: job.status === 'COMPLETED' && job.outputId ? artifactFor(job, job.outputId) : null,
    nextAttemptAt: job.status === 'QUEUED' && job.runAfter > new Date() ? job.runAfter : null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

export async function getImageJobStatus(id: string, userId: string) {
  const job = await ownedJob(id, userId);
  if (isRunnable(job)) kickImageJob(job.id, job.userId);
  return describe(job);
}

export async function updateImageJob(id: string, userId: string, action: 'cancel' | 'retry') {
  const job = await ownedJob(id, userId);
  const attemptId = jobAttemptId(job);
  const attempt = sameJobAttempt(job, attemptId);
  if (action === 'cancel' && (job.status === 'QUEUED' || job.status === 'RUNNING')) {
    const changed = await prisma.imageJob.updateMany({
      where: { ...attempt, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', retryable: true, error: null, leaseUntil: null, runnerId: attemptId },
    });
    if (changed.count) running.get(attemptId)?.abort();
  } else if (action === 'retry' && job.retryable && (job.status === 'FAILED' || job.status === 'CANCELLED')) {
    await prisma.imageJob.updateMany({
      where: { ...attempt, status: job.status, retryable: true },
      data: { status: 'QUEUED', runAfter: new Date(), runnerId: randomUUID(), retryable: false, error: null },
    });
  }
  return getImageJobStatus(id, userId);
}
