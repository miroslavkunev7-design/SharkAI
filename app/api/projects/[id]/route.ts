import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getProjectPreviewPath, readProjectManifest } from '@/lib/project-files';
import { getSession } from '@/lib/auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const project = await prisma.project.findFirst({
    where: { id, userId: session.id },
    include: {
      agents: { orderBy: { createdAt: 'asc' }, take: 20 },
    },
  });

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const manifest = await readProjectManifest(id);
  const downloadable = project.status === 'COMPLETED' && Boolean(manifest?.fileCount);

  let analysis = null;
  if (project.analysis) {
    try { analysis = JSON.parse(project.analysis); } catch { /* */ }
  }

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      type: project.type,
      status: project.status,
      qualityScore: project.qualityScore,
      outputPath: project.outputPath,
      analysis,
      createdAt: project.createdAt,
    },
    files: manifest?.files ?? [],
    fileCount: manifest?.fileCount ?? 0,
    agents: project.agents,
    previewUrl: downloadable && getProjectPreviewPath(manifest) ? `/api/projects/${id}/preview` : null,
    downloadUrl: downloadable ? `/api/projects/${id}/download` : null,
    zipUrl: downloadable ? `/api/projects/${id}/download` : null,
  });
}
