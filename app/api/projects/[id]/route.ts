import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { readProjectManifest } from '@/lib/project-files';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      agents: { orderBy: { createdAt: 'asc' }, take: 20 },
    },
  });

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const manifest = await readProjectManifest(id);

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
    previewUrl: manifest ? `/api/projects/${id}/preview` : null,
    downloadUrl: manifest ? `/api/projects/${id}/download` : null,
    zipUrl: manifest ? `/api/projects/${id}/download` : null,
  });
}
