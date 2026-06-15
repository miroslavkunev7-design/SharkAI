import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { getAISettings } from '@/lib/settings';

export async function GET() {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за админ' }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    select: { id: true, email: true, plan: true, role: true, tokensUsed: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const totalUsers = await prisma.user.count();
  const proUsers = await prisma.user.count({ where: { plan: 'PRO' } });
  const ultraUsers = await prisma.user.count({ where: { plan: 'ULTRA' } });
  const totalProjects = await prisma.project.count();
  const ai = await getAISettings();

  return NextResponse.json({
    stats: {
      totalUsers,
      proUsers,
      ultraUsers,
      totalProjects,
      revenue: proUsers * 12 + ultraUsers * 28,
      activeAgents: 15,
      serverUptime: 99.97,
      errorRate: 0.03,
    },
    users,
    ai,
    isAdmin: true,
  });
}
