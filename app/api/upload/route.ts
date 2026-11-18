import { NextRequest, NextResponse } from 'next/server';
import { detectedUploadMime, resolveUploadMime, saveUpload, UPLOAD_MIME_TYPES, validateUpload } from '@/lib/uploads';
import { getSession } from '@/lib/auth';
import { maxVoiceInput } from '@/lib/chat-voice.server';

export const runtime = 'nodejs';

const fileKinds: Record<string, string> = { pdf: 'pdf', docx: 'document', xlsx: 'dataset', csv: 'dataset', json: 'figma' };
const audioLimit = () => NextResponse.json({ error: `Максималният размер на аудио е ${maxVoiceInput / 1024 / 1024} MB.` }, { status: 413 });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Влез, за да прикачиш файл.' }, { status: 401 });

  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string' || file.size === 0) {
      return NextResponse.json({ error: 'Избери файл.' }, { status: 400 });
    }
    const declaredMime = resolveUploadMime(file.type, file.name);
    if (!UPLOAD_MIME_TYPES.includes(declaredMime)) {
      return NextResponse.json({ error: 'Неподдържан тип файл.' }, { status: 415 });
    }
    if (declaredMime.startsWith('audio/') && file.size > maxVoiceInput) return audioLimit();
    if (file.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'Максималният размер е 25 MB.' }, { status: 413 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = detectedUploadMime(buffer, declaredMime);
    if (mime.startsWith('audio/') && file.size > maxVoiceInput) return audioLimit();
    if (!validateUpload(buffer, mime)) {
      return NextResponse.json({ error: 'Съдържанието не отговаря на типа на файла.' }, { status: 415 });
    }
    const saved = await saveUpload(buffer, mime, session.id);
    const uploadKind = mime.startsWith('image/') ? 'image'
      : mime.startsWith('audio/') ? 'audio'
        : mime.startsWith('video/') ? 'video'
          : fileKinds[saved.ext] ?? 'file';
    return NextResponse.json({
      ok: true,
      uploadId: saved.id,
      previewUrl: ['image', 'audio'].includes(uploadKind) ? `/api/upload/${saved.id}` : null,
      mimeType: saved.mimeType,
      uploadKind,
      ext: saved.ext,
      userId: session.id,
    });
  } catch (error) {
    console.error('Upload failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Качването не успя.' }, { status: 500 });
  }
}
