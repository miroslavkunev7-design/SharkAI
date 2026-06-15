import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { readProjectManifest } from '@/lib/project-files';
import { createProjectZip } from '@/lib/zip';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  const manifest = await readProjectManifest(id);

  if (!project || !manifest || project.status !== 'COMPLETED') {
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
      },
    });
  } catch (err) {
    console.error('ZIP error:', err);
    return NextResponse.json({ error: 'ZIP creation failed' }, { status: 500 });
  }
}
