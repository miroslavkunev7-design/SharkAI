import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { readOwnedUpload } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Влез, за да отвориш файла.' }, { status: 401 });
  const { id } = await params;
  const file = await readOwnedUpload(id, session.id);
  if (!file) return NextResponse.json({ error: 'Файлът не е намерен.' }, { status: 404 });

  const requestedName = req.nextUrl.searchParams.get('download');
  const safeName = requestedName?.normalize('NFC').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/^\.+/u, '').trim().slice(0, 128);
  const downloadName = safeName?.toLowerCase().endsWith('.' + file.ext) ? safeName : null;
  const disposition = requestedName !== null || !file.mimeType.startsWith('image/') ? 'attachment' : 'inline';
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': disposition + '; filename="' + id + '.' + file.ext + '"' + (downloadName ? "; filename*=UTF-8''" + encodeURIComponent(downloadName) : ''),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
