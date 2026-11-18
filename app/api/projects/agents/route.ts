import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { describeAgentRunActivity, TRACKED_STUDIO_RUNS } from '@/lib/studio-activity';

const trackedMarker = `"runSemantics":"${TRACKED_STUDIO_RUNS}"`;

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Влез, за да видиш изпълненията.' }, { status: 401 });

  const runs = await prisma.agentRun.findMany({
    where: {
      status: { in: ['running', 'completed', 'failed'] },
      project: {
        userId: user.id,
        OR: [{ analysis: { contains: trackedMarker } }, { analysis: { contains: '"buildMethod":' } }],
      },
    },
    distinct: ['agentId'],
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      agentId: true,
      status: true,
      output: true,
      createdAt: true,
      duration: true,
      project: { select: { id: true, name: true, status: true, analysis: true } },
    },
  });
  return NextResponse.json({
    runs: runs.map(({ project, ...run }) => ({
      ...run,
      startedAt: project.analysis?.includes(trackedMarker) ? run.createdAt : null,
      project: { id: project.id, name: project.name, status: project.status },
      activity: describeAgentRunActivity(run.status, run.createdAt, project.status),
    })),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
