import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { ProjectInputError, startProject } from '@/lib/projects';
import { studioStatusCutoff, studioStatusUnknown } from '@/lib/studio-activity';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ projects: [], user: null, summary: { total: 0, completed: 0, active: 0 } });

  const where = { userId: session.id };
  const now = Date.now();
  const [projects, grouped, active] = await Promise.all([
    prisma.project.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.project.groupBy({ by: ['status'], where, _count: true }),
    prisma.project.count({ where: { ...where, status: { notIn: ['COMPLETED', 'FAILED'] }, updatedAt: { gte: studioStatusCutoff(now) } } }),
  ]);
  const summary = { total: 0, completed: 0, active };
  for (const group of grouped) {
    summary.total += group._count;
    if (group.status === 'COMPLETED') summary.completed += group._count;
  }
  const { name, email, plan, role } = session;
  return NextResponse.json({
    projects: projects.map((project) => ({ ...project, statusUnknown: studioStatusUnknown(project.status, project.updatedAt, now) })),
    summary,
    user: { name, email, plan, role },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Влез, за да създадеш проект.' }, { status: 401 });
  const body = await req.json().catch(() => null);
  try {
    const project = await startProject(session.id, body);
    return NextResponse.json({ project });
  } catch (error) {
    if (error instanceof ProjectInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Project creation failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Проектът не бе създаден.' }, { status: 500 });
  }
}
