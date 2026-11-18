import type { Plan, Role } from '@prisma/client';
import { prisma } from '@/lib/db';

type BillingUser = { id: string; role: Role; plan: Plan; email: string };

export const planRank: Record<Plan, number> = { FREE: 0, PRO: 1, ULTRA: 2 };

export function hasLifetimeUltraAccess({ role, email, plan }: Pick<BillingUser, 'role' | 'email' | 'plan'>) {
  const ownerEmail = process.env.ADMIN_EMAIL?.trim();
  return role === 'ADMIN' && (plan === 'ULTRA' || Boolean(ownerEmail && email === ownerEmail));
}

export function getActiveBillingPeriod(userId: string, now = new Date()) {
  return prisma.subscription.findFirst({
    where: {
      userId,
      status: 'active',
      AND: [
        { OR: [{ currentPeriodStart: null }, { currentPeriodStart: { lte: now } }] },
        { OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }] },
      ],
    },
    orderBy: [{ plan: 'desc' }, { currentPeriodEnd: { sort: 'desc', nulls: 'last' } }, { currentPeriodStart: { sort: 'desc', nulls: 'last' } }],
    select: { plan: true, currentPeriodStart: true, currentPeriodEnd: true },
  });
}

export async function getEffectivePlan(user: BillingUser, now = new Date()): Promise<Plan> {
  if (hasLifetimeUltraAccess(user)) return 'ULTRA';
  if (user.role === 'ADMIN' || user.plan === 'ULTRA') return user.plan;
  const period = await getActiveBillingPeriod(user.id, now);
  return period && planRank[period.plan] > planRank[user.plan] ? period.plan : user.plan;
}
