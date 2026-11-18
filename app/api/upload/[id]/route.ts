import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { readOwnedUpload } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Влез, за да отвориш файла.' }, { status: 401 });
  const { id } = await params;
  const file = await readOwnedUpload(id, session.id);
  if (!file) return NextResponse.json({ error: 'Файлът не е намерен.' }, { status: 404 });

  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': `${file.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${id}.${file.ext}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
