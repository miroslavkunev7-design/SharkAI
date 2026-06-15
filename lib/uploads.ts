import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { prisma } from './db';
import { getUploadDir, useDbUploads } from './storage-paths';

export const UPLOAD_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'mp4', 'webm', 'json'] as const;

export function extFromMime(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('video')) return 'mp4';
  if (mimeType.includes('json')) return 'json';
  return 'bin';
}

export function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', json: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

async function writeDiskUpload(id: string, ext: string, buffer: Buffer) {
  const dir = getUploadDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function saveUpload(
  buffer: Buffer,
  mimeType: string
): Promise<{ id: string; filePath: string; mimeType: string; ext: string }> {
  const ext = extFromMime(mimeType);
  const id = randomUUID();

  if (useDbUploads()) {
    await prisma.fileUpload.create({
      data: { id, data: new Uint8Array(buffer), mimeType, ext },
    });
    const filePath = await materializeUpload(id);
    return { id, filePath: filePath || '', mimeType, ext };
  }

  const filePath = await writeDiskUpload(id, ext, buffer);
  return { id, filePath, mimeType, ext };
}

export async function materializeUpload(uploadId: string): Promise<string | null> {
  const ext = await resolveUploadExt(uploadId);
  if (!ext) return null;

  const dir = getUploadDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${uploadId}.${ext}`);

  if (useDbUploads()) {
    const row = await prisma.fileUpload.findUnique({ where: { id: uploadId } });
    if (!row) return null;
    await fs.writeFile(filePath, row.data);
    return filePath;
  }

  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

async function resolveUploadExt(uploadId: string): Promise<string | null> {
  if (useDbUploads()) {
    const row = await prisma.fileUpload.findUnique({ where: { id: uploadId } });
    return row?.ext || null;
  }
  for (const ext of UPLOAD_EXTENSIONS) {
    const fp = path.join(getUploadDir(), `${uploadId}.${ext}`);
    try {
      await fs.access(fp);
      return ext;
    } catch { continue; }
  }
  return null;
}

export async function findUploadPath(uploadId: string): Promise<string | null> {
  if (useDbUploads()) return materializeUpload(uploadId);
  for (const ext of UPLOAD_EXTENSIONS) {
    const fp = path.join(getUploadDir(), `${uploadId}.${ext}`);
    try {
      await fs.access(fp);
      return fp;
    } catch { continue; }
  }
  return null;
}

export async function readUploadAsBase64(filePath: string): Promise<{ base64: string; mime: string }> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).slice(1);
  return { base64: buffer.toString('base64'), mime: mimeFromExt(ext) };
}

export function getUploadPath(id: string) {
  return path.join(getUploadDir(), id);
}
