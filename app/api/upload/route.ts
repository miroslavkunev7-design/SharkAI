import { NextRequest, NextResponse } from 'next/server';
import { saveUpload } from '@/lib/uploads';
import { getSession } from '@/lib/auth';

export const runtime = 'nodejs';

const ALLOWED = [
  'image/png', 'image/jpeg', 'image/webp', 'image/jpg',
  'application/pdf',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/json', 'text/json',
];

export async function POST(req: NextRequest) {
  const session = await getSession();

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file' }, { status: 400 });
    }

    const mime = file.type || 'application/octet-stream';
    const ok = ALLOWED.some((a) => mime.startsWith(a.split('/')[0]) || mime === a) ||
      mime.startsWith('image/') || mime.startsWith('video/') || mime.includes('pdf') || mime.includes('json');

    if (!ok) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });
    }

    if (file.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'Max 25MB' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const saved = await saveUpload(buffer, mime);

    let uploadKind = 'file';
    if (mime.startsWith('image/')) uploadKind = 'image';
    else if (mime.startsWith('video/')) uploadKind = 'video';
    else if (mime.includes('pdf')) uploadKind = 'pdf';
    else if (mime.includes('json')) uploadKind = 'figma';

    return NextResponse.json({
      ok: true,
      uploadId: saved.id,
      previewUrl: uploadKind === 'image' ? `/api/upload/${saved.id}` : null,
      mimeType: saved.mimeType,
      uploadKind,
      ext: saved.ext,
      userId: session?.id ?? null,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
