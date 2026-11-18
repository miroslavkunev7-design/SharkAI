import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { readOwnedUpload } from '@/lib/uploads';

export const runtime = 'nodejs';

function audioRange(header: string, length: number) {
  const parts = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!parts || (!parts[1] && !parts[2])) return null;
  const start = parts[1] ? Number(parts[1]) : Math.max(0, length - Number(parts[2]));
  const end = !parts[1] || !parts[2] ? length - 1 : Math.min(Number(parts[2]), length - 1);
  if (parts.slice(1).some((number) => !Number.isSafeInteger(Number(number))) || start > end) return null;
  return { start, end };
}

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
  const audio = file.mimeType.startsWith('audio/');
  const disposition = requestedName === null && (audio || file.mimeType.startsWith('image/')) ? 'inline' : 'attachment';
  const headers = new Headers({
    'Content-Type': file.mimeType,
    'Content-Disposition': disposition + '; filename="' + id + '.' + file.ext + '"' + (downloadName ? "; filename*=UTF-8''" + encodeURIComponent(downloadName) : ''),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const data = new Uint8Array(file.data);
  if (audio) {
    headers.set('Accept-Ranges', 'bytes');
    const range = req.headers.get('range');
    if (range) {
      const part = audioRange(range, data.length);
      if (!part) {
        headers.set('Content-Range', `bytes */${data.length}`);
        return new NextResponse(null, { status: 416, headers });
      }
      const { start, end } = part;
      headers.set('Content-Range', `bytes ${start}-${end}/${data.length}`);
      headers.set('Content-Length', String(end - start + 1));
      return new NextResponse(data.subarray(start, end + 1), { status: 206, headers });
    }
    headers.set('Content-Length', String(data.length));
  }
  return new NextResponse(data, { headers });
}
