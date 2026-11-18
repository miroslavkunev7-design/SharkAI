import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { getSession } from '@/lib/auth';
import { getProjectPreviewPath, readProjectFile, readProjectFileBytes, readProjectManifest } from '@/lib/project-files';
import { prisma } from '@/lib/db';

const PREVIEW_POLICY = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "style-src data: 'unsafe-inline'",
  "script-src data: 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const ASSET_MIME: Record<string, string> = {
  '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.woff2': 'font/woff2',
};
const localAttributes = /\b(src|href)=(['"])([^'"?#]+)\2/gi;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const project = await prisma.project.findFirst({ where: { id, userId: session.id, status: 'COMPLETED' }, select: { id: true } });
  const manifest = project ? await readProjectManifest(id) : null;
  const entry = getProjectPreviewPath(manifest);
  if (!manifest || !entry) return NextResponse.json({ error: 'Preview not ready' }, { status: 404 });

  try {
    const relativeTo = path.posix.dirname(entry);
    const files = new Set(manifest.files);
    const sourceHtml = await readProjectFile(id, entry);
    // A sandboxed preview has an opaque origin and cannot fetch signed-in assets.
    // Embed only files listed in this authorized project's manifest.
    const assets = new Map<string, string>();
    for (const match of sourceHtml.matchAll(localAttributes)) {
      const source = match[3];
      if (assets.has(source) || source.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(source)) continue;
      const relative = path.posix.normalize(path.posix.join(relativeTo, source));
      const file = files.has(relative) ? relative : files.has(source) ? source : null;
      const mime = file && ASSET_MIME[path.posix.extname(file).toLowerCase()];
      if (file && mime) {
        const bytes = await readProjectFileBytes(id, file);
        assets.set(source, `data:${mime};base64,${bytes.toString('base64')}`);
      }
    }
    const html = sourceHtml.replace(localAttributes, (attribute, name, quote, source) => {
      const embedded = assets.get(source);
      return embedded ? `${name}=${quote}${embedded}${quote}` : attribute;
    });
    return new NextResponse(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PREVIEW_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch {
    return NextResponse.json({ error: 'No preview available' }, { status: 404 });
  }
}
