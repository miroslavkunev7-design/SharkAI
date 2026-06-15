import { NextRequest, NextResponse } from 'next/server';
import { readProjectFile } from '@/lib/project-files';
import { prisma } from '@/lib/db';

const PREVIEW_FILES: Record<string, string[]> = {
  website: ['public/index.html', 'index.html'],
  saas: ['public/index.html', 'index.html'],
  game: ['index.html'],
  desktop: ['index.html'],
  default: ['public/index.html', 'index.html'],
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });

  if (!project || project.status !== 'COMPLETED') {
    return NextResponse.json({ error: 'Preview not ready' }, { status: 404 });
  }

  const candidates = PREVIEW_FILES[project.type] || PREVIEW_FILES.default;

  for (const file of candidates) {
    try {
      let html = await readProjectFile(id, file);
      html = html.replace(
        /href="styles\.css"/g,
        `href="/api/projects/${id}/asset?file=public/styles.css"`
      );
      html = html.replace(
        /src="app\.js"/g,
        `src="/api/projects/${id}/asset?file=public/app.js"`
      );
      html = html.replace(
        /src="game\.js"/g,
        `src="/api/projects/${id}/asset?file=game.js"`
      );
      html = html.replace(
        /href="([^"]+\.css)"/g,
        `href="/api/projects/${id}/asset?file=$1"`
      );
      return new NextResponse(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ error: 'No preview available' }, { status: 404 });
}
