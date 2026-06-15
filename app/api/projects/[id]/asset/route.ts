import { NextRequest, NextResponse } from 'next/server';
import { readProjectFile } from '@/lib/project-files';

const MIME: Record<string, string> = {
  css: 'text/css',
  js: 'application/javascript',
  html: 'text/html',
  json: 'application/json',
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const file = req.nextUrl.searchParams.get('file');

  if (!file) {
    return NextResponse.json({ error: 'Missing file param' }, { status: 400 });
  }

  try {
    const content = await readProjectFile(id, file);
    const ext = file.split('.').pop() || 'txt';
    return new NextResponse(content, {
      headers: { 'Content-Type': MIME[ext] || 'text/plain' },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
