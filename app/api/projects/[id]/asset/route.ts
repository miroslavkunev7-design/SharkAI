import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { readProjectFileBytes } from '@/lib/project-files';

const MIME: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const file = req.nextUrl.searchParams.get('file');
  if (!file) return NextResponse.json({ error: 'Missing file param' }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id, userId: session.id, status: 'COMPLETED' }, select: { id: true } });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  try {
    const data = await readProjectFileBytes(id, file);
    const ext = file.split('.').pop()?.toLowerCase() || '';
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': MIME[ext] || 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
