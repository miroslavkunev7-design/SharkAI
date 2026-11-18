import { Prisma } from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { FEATURES, getStudioFeatureAvailability } from './agents';
import { prisma } from './db';
import { runAutonomousLoop } from './orchestrator';
import { findOwnedUploadPath, mimeFromExt, readUploadAsBase64 } from './uploads';
import path from 'path';

export const projectInput = z.object({
  name: z.string().trim().max(150).nullish(),
  description: z.string().trim().max(20_000).nullish(),
  type: z.string().nullish(),
  inputType: z.string().nullish(),
  featureId: z.string().nullish(),
  uploadId: z.string().uuid().nullish(),
  uploadKind: z.string().nullish(),
  requestId: z.string().uuid().nullish(),
});

export class ProjectInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function startProject(userId: string, input: z.input<typeof projectInput>) {
  const validated = projectInput.safeParse(input);
  if (!validated.success) throw new ProjectInputError('Невалидни данни за проекта.');
  const { name, description, type, inputType, featureId, uploadId, requestId } = validated.data;
  const feature = featureId
    ? FEATURES.find((item) => item.id === featureId)
    : FEATURES.find((item) => item.projectType === (type || 'website') && item.inputType === (inputType || 'prompt'));
  if (!feature) throw new ProjectInputError('Непознат тип проект.');
  const unavailable = getStudioFeatureAvailability(feature.id);
  if (unavailable) throw new ProjectInputError(unavailable, 503);

  const key = requestId && { userId_requestId: { userId, requestId } };
  if (key) {
    const prior = await prisma.project.findUnique({ where: key });
    if (prior) return prior;
  }

  const screenshotPath = uploadId ? await findOwnedUploadPath(uploadId, userId) : null;
  if (uploadId && !screenshotPath) throw new ProjectInputError('Файлът не е намерен.', 404);
  const screenshotMime = screenshotPath ? mimeFromExt(path.extname(screenshotPath).slice(1)) : undefined;
  const uploadKind = screenshotMime?.startsWith('image/') ? 'image'
    : screenshotMime?.startsWith('video/') ? 'video'
    : screenshotMime === 'application/pdf' ? 'pdf'
    : screenshotMime === 'application/json' ? 'figma' : 'none';

  if (!feature.uploadKinds.includes(uploadKind)) {
    throw new ProjectInputError(uploadId ? 'Типът на файла не е подходящ за този проект.' : 'Прикачи файл за този проект.');
  }
  if (!description && !uploadId) throw new ProjectInputError('Опиши проекта.');
  const screenshot = screenshotPath && uploadKind === 'image' ? await readUploadAsBase64(screenshotPath) : null;

  try {
    const project = await prisma.project.create({
      data: {
        userId,
        requestId,
        name: name || feature.title,
        description,
        type: feature.projectType,
        inputType: feature.inputType,
        inputData: description,
        status: 'ANALYZING',
      },
    });
    waitUntil(runAutonomousLoop(project.id, {
      featureId: feature.id,
      screenshotBase64: screenshot?.base64,
      screenshotMime,
      screenshotPath: screenshotPath || undefined,
      uploadKind,
    }).catch((error) => console.error('Project execution failed:', error instanceof Error ? error.name : 'UnknownError')));
    return project;
  } catch (error) {
    if (key && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.project.findUniqueOrThrow({ where: key });
    }
    throw error;
  }
}
