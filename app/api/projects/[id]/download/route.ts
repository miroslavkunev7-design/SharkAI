import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { readProjectManifest } from '@/lib/project-files';
import { createProjectZip } from '@/lib/zip';
import { getSession } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id, userId: session.id, status: 'COMPLETED' } });
  const manifest = project ? await readProjectManifest(id) : null;

  if (!project || !manifest?.fileCount) {
    return NextResponse.json({ error: 'Project not ready' }, { status: 404 });
  }

  try {
    const zipBuffer = await createProjectZip(id, project.name);
    const filename = `${project.name.replace(/[^a-z0-9-_]/gi, '-').slice(0, 40)}-sharkai.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(zipBuffer.length),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('ZIP error:', err);
    return NextResponse.json({ error: 'ZIP creation failed' }, { status: 500 });
  }
}
