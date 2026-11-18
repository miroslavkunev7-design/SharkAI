import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { getAISettings } from '@/lib/settings';

export async function GET() {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за администратор.' }, { status: 403 });
  }

  const [users, totalUsers, proUsers, ultraUsers, totalProjects, ai] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, email: true, plan: true, role: true, tokensUsed: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.user.count(),
    prisma.user.count({ where: { plan: 'PRO' } }),
    prisma.user.count({ where: { plan: 'ULTRA' } }),
    prisma.project.count(),
    getAISettings(),
  ]);

  return NextResponse.json({
    stats: { totalUsers, proUsers, ultraUsers, totalProjects },
    users,
    ai,
    isAdmin: true,
    account: { plan: session.plan, ...(session.lifetime && { lifetime: true }) },
  });
}
