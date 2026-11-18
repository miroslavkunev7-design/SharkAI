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
  id: true, plan: true, status: true, stripeSubId: true, stripePeriodSubId: true, paypalSubId: true,
  paymentMethod: true, currentPeriodStart: true, currentPeriodEnd: true, createdAt: true,
  payments: { where: { status: 'completed' }, select: { id: true }, take: 1 },
} satisfies Prisma.SubscriptionSelect;

type Period = Prisma.SubscriptionGetPayload<{ select: typeof subscriptionSelection }>;
type Member = {
  id: string; email: string; plan: Plan; role: 'ADMIN' | 'USER'; createdAt: Date; subscriptions: Period[];
};

function periodSource(period: Period) {
  if (period.paymentMethod === 'bank' || period.paymentMethod === 'mobile' || period.paymentMethod === 'stripe') return period.paymentMethod;
  return period.stripeSubId || period.stripePeriodSubId ? 'stripe' : period.paypalSubId ? 'paypal' : 'recorded';
}

function verifiedPayment(period: Period) {
  return period.status === 'active' && (period.payments.length > 0 || (period.id.startsWith(verifiedInvoicePrefix)
    && !!(period.stripeSubId || period.stripePeriodSubId) && !!period.currentPeriodStart && !!period.currentPeriodEnd));
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

export async function loadAdminPendingPayments() {
  const where = { status: 'pending', paymentMethod: { in: ['bank', 'mobile'] } } satisfies Prisma.SubscriptionWhereInput;
  const [total, pending] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: ADMIN_PAGE_SIZE,
      select: { id: true, plan: true, amountEur: true, paymentMethod: true, bankReference: true, createdAt: true,
        user: { select: { email: true, name: true, role: true } } },
    }),
  ]);
  return {
    availability: 'available' as const, reason: null, total,
    items: pending.map(({ user, ...item }) => ({
      ...item, user: { email: user.email, name: user.name },
      approvable: user.role === 'USER' && item.plan !== 'FREE' && Boolean(item.bankReference?.trim())
        && item.amountEur !== null && item.amountEur > 0 && item.amountEur <= 100_000
        && Math.abs(item.amountEur * 100 - Math.round(item.amountEur * 100)) < 0.000001,
    })),
  };
}

function euroAmount(euros: number) {
  const minor = Math.round(euros * 100);
  return Number.isSafeInteger(minor) ? { minor, currency: 'EUR' } : null;
}

async function financialMetrics(where: Prisma.SubscriptionWhereInput) {
  const [completed, recurring] = await Promise.all([
    prisma.payment.aggregate({ where: { status: 'completed', currency: { equals: 'EUR', mode: 'insensitive' } }, _sum: { amountEur: true } }),
    prisma.subscription.findMany({
      where,
      select: { id: true, stripeSubId: true, stripePeriodSubId: true, paypalSubId: true, amountEur: true },
      orderBy: [{ currentPeriodStart: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    }),
  ]);
  const windowAmounts = new Map<string, number | null>();
  for (const row of recurring) {
    const key = row.stripePeriodSubId ?? row.stripeSubId ?? row.paypalSubId ?? row.id;
    if (!windowAmounts.has(key) || windowAmounts.get(key) === null) windowAmounts.set(key, row.amountEur);
  }
  const monthly = [...windowAmounts.values()];
  const hasMissingAmount = monthly.some((amount) => amount === null);
  return {
    collected: euroAmount(completed._sum.amountEur ?? 0),
    mrr: hasMissingAmount ? null : euroAmount(monthly.reduce<number>((sum, amount) => sum + (amount ?? 0), 0)),
    amountsUnavailableReason: hasMissingAmount ? 'Поне един активен абонамент няма записана месечна сума.' : null,
  };
}

export async function loadAdminBilling(pages: { subscriptions: number; pro: number; ultra: number }, now = new Date()) {
  const paidPlan = { in: [...paidPlans] };
  const activePeriod = activePeriodWindow(now);
  const verifiedPeriod = {
    plan: paidPlan, status: 'active',
    OR: [
      { payments: { some: { status: 'completed' } } },
      { id: { startsWith: verifiedInvoicePrefix }, currentPeriodStart: { not: null }, currentPeriodEnd: { not: null },
        OR: [{ stripeSubId: { not: null } }, { stripePeriodSubId: { not: null } }] },
    ],
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
  const [subscriptionTotal, periods, activeSubscriptions, activePaidAccounts, verifiedPaidPeriods, pro, ultra, money, pendingPayments] = await Promise.all([
    prisma.subscription.count({ where: storedPeriod }),
    prisma.subscription.findMany({
      where: storedPeriod, select: { ...subscriptionSelection, user: { select: { id: true, email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: ADMIN_PAGE_SIZE, skip: (pages.subscriptions - 1) * ADMIN_PAGE_SIZE,
    }),
    prisma.subscription.count({ where: { ...activePeriod, ...storedPeriod } }),
    prisma.user.count({ where: { role: 'USER', subscriptions: { some: activePaidPeriod } } }),
    prisma.subscription.count({ where: { ...storedPeriod, ...verifiedPeriod } }),
    members(proMember, pages.pro), members(ultraMember, pages.ultra),
    financialMetrics({ ...activePeriod, ...storedPeriod }), loadAdminPendingPayments(),
  ]);
  return {
    subscriptionsPagination: adminPagination(pages.subscriptions, subscriptionTotal),
    billing: {
      metrics: { activeSubscriptions, activePaidAccounts, verifiedPaidPeriods, collected: money.collected, mrr: money.mrr },
      amountsUnavailableReason: money.amountsUnavailableReason,
      subscriptions: periods.map((period) => ({
        key: createHash('sha256').update(period.id).digest('base64url').slice(0, 22),
        userId: period.user.id, email: period.user.email, plan: period.plan, status: periodStatus(period, now),
        createdAt: period.createdAt, ...dateWindow(period), source: periodSource(period), paymentVerified: verifiedPayment(period),
      })),
      byPlan: { PRO: pro, ULTRA: ultra },
      pendingPayments,
    },
  };
}
