import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { UPLOAD_EXTENSIONS, mimeFromExt } from '@/lib/uploads';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const safeId = id.replace(/[^a-f0-9-]/gi, '');
  const uploadDir = path.join(process.cwd(), 'uploads');

  for (const ext of UPLOAD_EXTENSIONS) {
    const filePath = path.join(uploadDir, `${safeId}.${ext}`);
    try {
      const data = await fs.readFile(filePath);
      const mime = mimeFromExt(ext);
      if (!mime.startsWith('image/')) {
        return NextResponse.json({ error: 'Preview only for images' }, { status: 404 });
      }
      return new NextResponse(data, { headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' } });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
