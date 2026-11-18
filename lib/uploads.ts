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
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
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
  if (type === 'audio/x-wav' || (ext === 'wav' && ['audio/wave', 'audio/vnd.wave'].includes(type))) return 'audio/wav';
  if (ext === 'm4a' && ['audio/x-m4a', 'audio/m4a', 'video/mp4'].includes(type)) return 'audio/mp4';
  if (ext === 'ogg' && type === 'application/ogg') return 'audio/ogg';
  if (['wav', 'ogg', 'm4a'].includes(ext) && ['', 'application/octet-stream'].includes(type)) return mimeFromExt(ext);
  return type;
}

function ebmlInteger(buffer: Buffer, offset: number, end: number, id: boolean) {
  if (offset >= end) return null;
  const first = buffer[offset];
  let marker = 128;
  let width = 1;
  while (marker && !(first & marker)) {
    marker >>= 1;
    width++;
  }
  if (!marker || width > (id ? 4 : 8) || offset + width > end) return null;
  let value = id ? first : first & (marker - 1);
  let unknown = !id && value === marker - 1;
  for (let pos = offset + 1; pos < offset + width; pos++) {
    value = value * 256 + buffer[pos];
    unknown &&= buffer[pos] === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) return null;
  return { value, next: offset + width, unknown };
}

function ebmlElement(buffer: Buffer, offset: number, limit: number) {
  const id = ebmlInteger(buffer, offset, limit, true);
  const length = id && ebmlInteger(buffer, id.next, limit, false);
  if (!id || !length) return null;
  const start = length.next;
  const end = length.unknown ? limit : start + length.value;
  return end > limit ? null : { id: id.value, start, end, unknown: length.unknown };
}

function findEbml(buffer: Buffer, start: number, end: number, id: number) {
  for (let count = 0; start < end && count < 512; count++) {
    const element = ebmlElement(buffer, start, end);
    if (!element) return null;
    if (element.id === id) return element;
    start = element.end;
  }
  return null;
}

function isAudioWebm(buffer: Buffer) {
  const header = ebmlElement(buffer, 0, buffer.length);
  if (!header || header.id !== 0x1a45dfa3 || header.unknown) return false;
  const type = findEbml(buffer, header.start, header.end, 0x4282);
  if (!type || type.end - type.start !== 4 || buffer.toString('latin1', type.start, type.end) !== 'webm') return false;
  const segment = findEbml(buffer, header.end, buffer.length, 0x18538067);
  const tracks = segment && findEbml(buffer, segment.start, segment.end, 0x1654ae6b);
  if (!tracks || tracks.unknown) return false;
  let audio = false;
  let cursor = tracks.start;
  for (let count = 0; cursor < tracks.end && count < 128; count++) {
    const entry = ebmlElement(buffer, cursor, tracks.end);
    if (!entry || entry.unknown) return false;
    cursor = entry.end;
    if (entry.id !== 0xae) continue;
    const kind = findEbml(buffer, entry.start, entry.end, 0x83);
    if (!kind || kind.end - kind.start !== 1) return false;
    if (buffer[kind.start] === 1) return false;
    if (buffer[kind.start] === 2) audio = true;
  }
  return cursor === tracks.end && audio;
}

function mp4Box(buffer: Buffer, offset: number, limit: number) {
  if (limit - offset < 8) return null;
  let size = buffer.readUInt32BE(offset);
  let header = 8;
  if (size === 0) size = limit - offset;
  if (size === 1) {
    if (limit - offset < 16) return null;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(limit - offset)) return null;
    size = Number(large);
    header = 16;
  }
  if (size < header || size > limit - offset) return null;
  return { type: buffer.toString('latin1', offset + 4, offset + 8), start: offset + header, end: offset + size };
}

function findMp4(buffer: Buffer, start: number, end: number, name: string) {
  for (let count = 0; start < end && count < 512; count++) {
    const box = mp4Box(buffer, start, end);
    if (!box) return null;
    if (box.type === name) return box;
    start = box.end;
  }
  return null;
}

function isAudioMp4(buffer: Buffer) {
  const movie = findMp4(buffer, 0, buffer.length, 'moov');
  if (!movie) return false;
  let audio = false;
  let cursor = movie.start;
  for (let count = 0; cursor < movie.end && count < 128; count++) {
    const track = mp4Box(buffer, cursor, movie.end);
    if (!track) return false;
    cursor = track.end;
    if (track.type !== 'trak') continue;
    const media = findMp4(buffer, track.start, track.end, 'mdia');
    const kind = media && findMp4(buffer, media.start, media.end, 'hdlr');
    if (!kind || kind.end - kind.start < 12) return false;
    const handler = buffer.toString('latin1', kind.start + 8, kind.start + 12);
    if (handler === 'vide') return false;
    if (handler === 'soun') audio = true;
  }
  return cursor === movie.end && audio;
}

function isAudioOgg(buffer: Buffer) {
  let audio = false;
  let start = 0;
  // Inspect the mapping packets for every logical stream, including chained Ogg audio.
  for (let pages = 0; start < buffer.length && pages < 4096; pages++) {
    if (start + 27 > buffer.length || buffer.toString('ascii', start, start + 4) !== 'OggS' || buffer[start + 4] !== 0) return false;
    const segments = buffer[start + 26];
    const content = start + 27 + segments;
    if (content > buffer.length) return false;
    let size = 0;
    for (let index = start + 27; index < content; index++) size += buffer[index];
    if (content + size > buffer.length) return false;
    if (buffer[start + 5] & 2) {
      const codec = buffer.subarray(content, content + (segments ? Math.min(buffer[start + 27], 8) : 0));
      const name = codec.toString('ascii');
      if (name !== 'fishead\0') {
        if (!(name === 'OpusHead' || name.slice(0, 7) === '\x01vorbis' || name === 'Speex   '
          || codec.subarray(0, 5).equals(Buffer.from('\x7fFLAC')))) return false;
        audio = true;
      }
    }
    start = content + size;
  }
  return audio && start === buffer.length;
}

function isAudioWav(buffer: Buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return false;
  const end = buffer.readUInt32LE(4) + 8;
  if (end > buffer.length) return false;
  let format = false;
  for (let pos = 12, chunks = 0; pos + 8 <= end && chunks < 128; chunks++) {
    const size = buffer.readUInt32LE(pos + 4);
    if (pos + 8 + size > end) return false;
    const chunk = buffer.toString('ascii', pos, pos + 4);
    if (chunk === 'fmt ' && size >= 16) format = true;
    if (chunk === 'data') return format && size > 0;
    pos += 8 + size + (size % 2);
  }
  return false;
}

export function detectedUploadMime(buffer: Buffer, mime: string) {
  return mime === 'video/webm' && isAudioWebm(buffer) ? 'audio/webm' : mime;
}

export function validateUpload(buffer: Buffer, mime: string): boolean {
  if (mime === 'audio/webm') return isAudioWebm(buffer);
  if (mime === 'audio/mp4') return isAudioMp4(buffer);
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
    case 'ogg': return isAudioOgg(buffer);
    case 'wav': return isAudioWav(buffer);
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
  const storedMime = upload && EXTENSIONS[upload.mimeType] === upload.ext && upload.mimeType === 'audio/webm' ? upload.mimeType : null;
  if (upload && UPLOAD_EXTENSIONS.includes(upload.ext)) {
    const row = await prisma.fileUpload.findUnique({ where: { id }, select: { data: true } });
    if (row?.data.length) return { data: row.data, ext: upload.ext, mimeType: storedMime ?? mimeFromExt(upload.ext) };
  }
  for (const ext of upload ? [upload.ext].filter((value) => UPLOAD_EXTENSIONS.includes(value)) : UPLOAD_EXTENSIONS) {
    try {
      const data = await fs.readFile(path.join(getUploadDir(), `${id}.${ext}`));
      return { data: new Uint8Array(data), ext, mimeType: storedMime ?? mimeFromExt(ext) };
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
