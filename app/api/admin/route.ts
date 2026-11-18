import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_PAGE_SIZE, adminLatestPeriod, adminPage, adminPagination, describeAdminMember, loadAdminBilling } from '@/lib/admin-billing.server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth';
import { getAISettings } from '@/lib/settings';

const headers = { 'Cache-Control': 'private, no-store' };

async function loadUsers(page: number, now: Date) {
  const select = { id: true, email: true, plan: true, role: true, tokensUsed: true, createdAt: true } as const;
  const pagination = {
    take: ADMIN_PAGE_SIZE, skip: (page - 1) * ADMIN_PAGE_SIZE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  } satisfies Prisma.UserFindManyArgs;
  try {
    const rows = await prisma.user.findMany({ ...pagination, select: { ...select, subscriptions: adminLatestPeriod(now) } });
    return rows.map((row) => describeAdminMember(row));
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !['P2021', 'P2022'].includes(error.code)) throw error;
    const rows = await prisma.user.findMany({ ...pagination, select });
    return rows.map((row) => describeAdminMember({ ...row, subscriptions: [] }));
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (session?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Само за администратор.' }, { status: 403, headers });
  }

  const query = request.nextUrl.searchParams;
  const now = new Date();
  const usersPage = adminPage(query.get('usersPage'));
  const [users, totalUsers, proUsers, ultraUsers, totalProjects, ai, summary] = await Promise.all([
    loadUsers(usersPage, now),
    prisma.user.count(),
    prisma.user.count({ where: { plan: 'PRO' } }),
    prisma.user.count({ where: { plan: 'ULTRA' } }),
    prisma.project.count(),
    getAISettings(),
    loadAdminBilling({ subscriptions: adminPage(query.get('subscriptionsPage')), pro: adminPage(query.get('proPage')), ultra: adminPage(query.get('ultraPage')) }, now)
      .catch((error: unknown) => {
        console.error('Admin billing unavailable:', error instanceof Error ? error.name : 'unknown failure');
        return null;
      }),
  ]);

  return NextResponse.json({
    stats: { totalUsers, proUsers, ultraUsers, totalProjects },
    users,
    ai,
    isAdmin: true,
    account: { plan: session.plan, ...(session.lifetime && { lifetime: true }) },
    billing: summary?.billing ?? null,
    ...(summary ? {} : { billingError: 'Абонаментните данни временно не могат да се заредят.' }),
    pagination: { users: adminPagination(usersPage, totalUsers), subscriptions: summary?.subscriptionsPagination ?? null },
  }, { headers });
}
