import { createHash } from 'node:crypto';
import type { Plan, Prisma } from '@prisma/client';
import { hasLifetimeUltraAccess, planRank } from './billing';
import { prisma } from './db';

export const ADMIN_PAGE_SIZE = 50;
const paidPlans = ['PRO', 'ULTRA'] as const;
const verifiedInvoicePrefix = 'stripe-invoice:in_';

export function adminPage(value: string | null) {
  return value && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1;
}

export function adminPagination(page: number, total: number) {
  return { page, pageSize: ADMIN_PAGE_SIZE, total };
}

const subscriptionSelection = {
  id: true, plan: true, status: true, stripeSubId: true, paypalSubId: true,
  currentPeriodStart: true, currentPeriodEnd: true, createdAt: true,
} satisfies Prisma.SubscriptionSelect;

type Period = Prisma.SubscriptionGetPayload<{ select: typeof subscriptionSelection }>;
type Member = {
  id: string; email: string; plan: Plan; role: 'ADMIN' | 'USER'; createdAt: Date; subscriptions: Period[];
};

function periodSource(period: Period) {
  return period.stripeSubId ? 'stripe' : period.paypalSubId ? 'paypal' : 'recorded';
}

function verifiedPayment(period: Period) {
  return period.status === 'active' && period.id.startsWith(verifiedInvoicePrefix) && !!period.stripeSubId && !!period.currentPeriodStart && !!period.currentPeriodEnd;
}

function dateWindow(period?: Period) {
  return { currentPeriodStart: period?.currentPeriodStart ?? null, currentPeriodEnd: period?.currentPeriodEnd ?? null };
}

function periodStatus(period: Period, now: Date) {
  if (period.status !== 'active') return period.status;
  if (period.currentPeriodStart && period.currentPeriodStart > now) return 'scheduled';
  if (period.currentPeriodEnd && period.currentPeriodEnd <= now) return 'expired';
  return 'active';
}

export function describeAdminMember<Account extends Member>({ subscriptions, ...member }: Account) {
  const lifetime = hasLifetimeUltraAccess(member);
  const record = member.role === 'USER' ? subscriptions[0] : undefined;
  const effectivePlan = lifetime ? 'ULTRA' : record && planRank[record.plan] > planRank[member.plan] ? record.plan : member.plan;
  const effectivePeriod = record?.plan === effectivePlan ? record : undefined;
  return {
    ...member, effectivePlan, lifetime, ...dateWindow(effectivePeriod),
    source: lifetime ? 'lifetime' : effectivePeriod ? periodSource(effectivePeriod) : 'profile',
    paymentVerified: !!effectivePeriod && verifiedPayment(effectivePeriod),
  };
}

function activePeriodWindow(now: Date) {
  return {
    status: 'active',
    AND: [
      { OR: [{ currentPeriodStart: null }, { currentPeriodStart: { lte: now } }] },
      { OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }] },
    ],
  } satisfies Prisma.SubscriptionWhereInput;
}

export function adminLatestPeriod(now: Date) {
  return {
    where: { ...activePeriodWindow(now), plan: { in: [...paidPlans] } }, select: subscriptionSelection,
    orderBy: [{ plan: 'desc' }, { currentPeriodEnd: { sort: 'desc', nulls: 'last' } }, { currentPeriodStart: { sort: 'desc', nulls: 'last' } }],
    take: 1,
  } satisfies NonNullable<Exclude<Prisma.UserSelect['subscriptions'], boolean>>;
}

export function unavailablePendingPayments() {
  return {
    availability: 'unavailable' as const,
    reason: 'Няма потвърден източник на заявки за банково или мобилно плащане за тази версия.',
    items: [],
  };
}

export async function loadAdminBilling(pages: { subscriptions: number; pro: number; ultra: number }, now = new Date()) {
  const paidPlan = { in: [...paidPlans] };
  const activePeriod = activePeriodWindow(now);
  const verifiedPeriod = {
    id: { startsWith: verifiedInvoicePrefix }, stripeSubId: { not: null },
    plan: paidPlan, status: 'active', currentPeriodStart: { not: null }, currentPeriodEnd: { not: null },
  } satisfies Prisma.SubscriptionWhereInput;
  const storedPeriod = { plan: paidPlan, user: { role: 'USER' } } satisfies Prisma.SubscriptionWhereInput;
  const activePaidPeriod = { ...activePeriod, ...verifiedPeriod };
  const ownerEmail = process.env.ADMIN_EMAIL?.trim();
  const ultraMember = {
    OR: [
      { plan: 'ULTRA' }, ...(ownerEmail ? [{ role: 'ADMIN' as const, email: ownerEmail }] : []),
      { role: 'USER', subscriptions: { some: { ...activePeriod, plan: 'ULTRA' } } },
    ],
  } satisfies Prisma.UserWhereInput;
  const proMember = {
    NOT: ultraMember,
    OR: [{ plan: 'PRO' }, { role: 'USER', subscriptions: { some: { ...activePeriod, plan: 'PRO' } } }],
  } satisfies Prisma.UserWhereInput;
  async function members(where: Prisma.UserWhereInput, page: number) {
    const [total, records] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true, email: true, role: true, plan: true, createdAt: true,
          subscriptions: adminLatestPeriod(now),
        },
        take: ADMIN_PAGE_SIZE, skip: (page - 1) * ADMIN_PAGE_SIZE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    return { items: records.map((record) => describeAdminMember(record)), pagination: adminPagination(page, total) };
  }
  const [subscriptionTotal, periods, activeSubscriptions, activePaidAccounts, verifiedPaidPeriods, pro, ultra] = await Promise.all([
    prisma.subscription.count({ where: storedPeriod }),
    prisma.subscription.findMany({
      where: storedPeriod, select: { ...subscriptionSelection, user: { select: { id: true, email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: ADMIN_PAGE_SIZE, skip: (pages.subscriptions - 1) * ADMIN_PAGE_SIZE,
    }),
    prisma.subscription.count({ where: { ...activePeriod, ...storedPeriod } }),
    prisma.user.count({ where: { role: 'USER', subscriptions: { some: activePaidPeriod } } }),
    prisma.subscription.count({ where: { ...storedPeriod, ...verifiedPeriod } }),
    members(proMember, pages.pro), members(ultraMember, pages.ultra),
  ]);
  return {
    subscriptionsPagination: adminPagination(pages.subscriptions, subscriptionTotal),
    billing: {
      metrics: { activeSubscriptions, activePaidAccounts, verifiedPaidPeriods, collected: null, mrr: null },
      amountsUnavailableReason: 'Абонаментните записи не съдържат получени суми и валута.',
      subscriptions: periods.map((period) => ({
        key: createHash('sha256').update(period.id).digest('base64url').slice(0, 22),
        userId: period.user.id, email: period.user.email, plan: period.plan, status: periodStatus(period, now),
        createdAt: period.createdAt, ...dateWindow(period), source: periodSource(period), paymentVerified: verifiedPayment(period),
      })),
      byPlan: { PRO: pro, ULTRA: ultra },
      pendingPayments: unavailablePendingPayments(),
    },
  };
}
