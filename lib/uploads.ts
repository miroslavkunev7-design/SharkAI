import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { TextDecoder } from 'node:util';
import { prisma } from './db';
import { getUploadDir, storesUploadsInDatabase } from './storage-paths';

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/json': 'json',
  'text/json': 'json',
};

export const UPLOAD_MIME_TYPES = Object.keys(EXTENSIONS);
const UPLOAD_EXTENSIONS = [...new Set([...Object.values(EXTENSIONS), 'jpeg'])];
const UPLOAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function mimeFromExt(ext: string): string {
  if (ext === 'jpeg') return 'image/jpeg';
  return Object.keys(EXTENSIONS).find((type) => EXTENSIONS[type] === ext) || 'application/octet-stream';
}

export function resolveUploadMime(mime: string, name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  if (ext === 'json' && ['', 'application/octet-stream', 'text/plain', 'text/json'].includes(type)) return 'application/json';
  if (ext === 'csv' && ['', 'application/octet-stream', 'application/vnd.ms-excel', 'text/plain'].includes(type)) return 'text/csv';
  if (['txt', 'md', 'markdown'].includes(ext) && ['', 'application/octet-stream', 'text/plain', 'text/markdown'].includes(type)) {
    return ext === 'txt' ? 'text/plain' : 'text/markdown';
  }
  if (['docx', 'xlsx'].includes(ext) && ['', 'application/octet-stream', 'application/zip'].includes(type)) return mimeFromExt(ext);
  return type;
}

export function validateUpload(buffer: Buffer, mime: string): boolean {
  switch (EXTENSIONS[mime]) {
    case 'png': return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'jpg': return buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case 'webp': return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    case 'pdf': return buffer.toString('ascii', 0, 5) === '%PDF-';
    case 'docx':
    case 'xlsx': {
      const member = EXTENSIONS[mime] === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
      return buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) &&
        buffer.includes('[Content_Types].xml') && buffer.includes(member);
    }
    case 'md':
    case 'txt':
    case 'csv':
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return !!text.trim() && !text.includes('\0');
      } catch { return false; }
    case 'mp4':
    case 'mov': return ['ftyp', 'moov', 'mdat', 'wide'].includes(buffer.toString('ascii', 4, 8));
    case 'webm': return buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    case 'json':
      try { JSON.parse(buffer.toString('utf8')); return true; } catch { return false; }
    default: return false;
  }
}

async function writeDiskUpload(id: string, ext: string, buffer: Uint8Array) {
  const dir = getUploadDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function saveUpload(buffer: Buffer, mimeType: string, userId: string) {
  const ext = EXTENSIONS[mimeType];
  if (!ext) throw new Error('Unsupported upload MIME type');
  const id = randomUUID();
  const inDatabase = storesUploadsInDatabase();
  const filePath = inDatabase ? null : await writeDiskUpload(id, ext, buffer);
  try {
    await prisma.fileUpload.create({
      data: { id, userId, data: inDatabase ? new Uint8Array(buffer) : new Uint8Array(), mimeType, ext },
    });
  } catch (error) {
    if (filePath) await fs.rm(filePath, { force: true });
    throw error;
  }
  return { id, filePath, mimeType, ext };
}

export async function readOwnedUpload(id: string, userId: string) {
  if (!UPLOAD_ID.test(id)) return null;
  const upload = await prisma.fileUpload.findUnique({
    where: { id },
    select: { userId: true, mimeType: true, ext: true },
  });
  if (upload?.userId && upload.userId !== userId) return null;
  if (!upload?.userId) {
    // Older files were unowned. A single historical conversation owner is the only known attribution.
    const references = await prisma.chatMessage.findMany({
      where: { imagePath: id },
      distinct: ['userId'],
      select: { userId: true },
      take: 2,
    });
    if (references.length !== 1 || references[0].userId !== userId) return null;
  }
  if (upload && UPLOAD_EXTENSIONS.includes(upload.ext)) {
    const row = await prisma.fileUpload.findUnique({ where: { id }, select: { data: true } });
    if (row?.data.length) return { data: row.data, ext: upload.ext, mimeType: mimeFromExt(upload.ext) };
  }
  for (const ext of upload ? [upload.ext].filter((value) => UPLOAD_EXTENSIONS.includes(value)) : UPLOAD_EXTENSIONS) {
    try {
      const data = await fs.readFile(path.join(getUploadDir(), `${id}.${ext}`));
      return { data: new Uint8Array(data), ext, mimeType: mimeFromExt(ext) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export async function findOwnedUploadPath(id: string, userId: string) {
  const upload = await readOwnedUpload(id, userId);
  if (!upload) return null;
  const filePath = path.join(getUploadDir(), `${id}.${upload.ext}`);
  try {
    await fs.access(filePath);
    return filePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return writeDiskUpload(id, upload.ext, upload.data);
}

export async function readUploadAsBase64(filePath: string): Promise<{ base64: string; mime: string }> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).slice(1);
  return { base64: buffer.toString('base64'), mime: mimeFromExt(ext) };
}
