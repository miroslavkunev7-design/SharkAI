import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { adminPage, loadAdminBilling } from '../lib/admin-billing.server';
import { hashPassword } from '../lib/auth';
import { prisma } from '../lib/db';

const local = ['localhost', '127.0.0.1', '[::1]'];
assert(local.includes(new URL(process.env.POSTGRES_PRISMA_URL ?? '').hostname), 'Use a disposable local PostgreSQL database.');
const origin = process.env.SHARKAI_ADMIN_TEST_URL ? new URL(process.env.SHARKAI_ADMIN_TEST_URL) : null;
assert(!origin || local.includes(origin.hostname), 'Use a local web server for the admin HTTP checks.');

async function run() {
  const tag = randomUUID();
  const emails = ['owner', 'legacy-admin', 'active', 'pro', 'expired'].map((name) => `admin-billing-${name}-${tag}@example.test`);
  const stripeKeys: string[] = [];
  const storedAdminEmail = process.env.ADMIN_EMAIL;
  const password = randomUUID();
  const passwordHash = await hashPassword(password);
  const now = new Date();
  const offset = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const pages = { subscriptions: 1, pro: 1, ultra: 1 };
  const until = offset(1800);
  const start = offset(-1800);
  try {
    const initial = (await loadAdminBilling(pages, now)).billing.metrics;
    const [owner, legacyAdmin, active, pro, expired] = await Promise.all(emails.map((email, index) => prisma.user.create({ data: {
      email, passwordHash, role: index < 2 ? 'ADMIN' : 'USER', plan: index === 1 ? 'ULTRA' : 'FREE',
    } })));
    process.env.ADMIN_EMAIL = owner.email;
    const stripePeriod = (userId: string, name: string, plan: 'PRO' | 'ULTRA', dates: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) => {
      const id = `stripe-invoice:in_${name}_${tag}`;
      const stripeSubId = `sub_${name}_${tag}`;
      stripeKeys.push(id, stripeSubId);
      return { id, userId, plan, stripeSubId, currentPeriodStart: start, currentPeriodEnd: until, ...dates };
    };
    await prisma.subscription.createMany({ data: [
      stripePeriod(active.id, 'current-pro', 'PRO'),
      stripePeriod(active.id, 'current-ultra', 'ULTRA'),
      stripePeriod(expired.id, 'ended', 'PRO', { currentPeriodStart: offset(-3600), currentPeriodEnd: now }),
      stripePeriod(expired.id, 'refunded', 'ULTRA', { status: 'revoked' }),
      stripePeriod(owner.id, 'admin', 'ULTRA'),
      { userId: pro.id, plan: 'PRO', paypalSubId: `paypal_${tag}`, currentPeriodEnd: until },
    ] });
    stripeKeys.push(`paypal_${tag}`);

    const { billing, subscriptionsPagination } = await loadAdminBilling(pages, now);
    assert.equal(billing.metrics.activeSubscriptions, initial.activeSubscriptions + 3);
    assert.equal(billing.metrics.activePaidAccounts, initial.activePaidAccounts + 1);
    assert.equal(billing.metrics.verifiedPaidPeriods, initial.verifiedPaidPeriods + 3);
    assert.equal(billing.metrics.collected, null);
    assert.equal(billing.metrics.mrr, null);
    assert.deepEqual(billing.pendingPayments.items, []);
    assert(billing.pendingPayments.reason);
    assert.equal(billing.pendingPayments.availability, 'unavailable');
    assert(subscriptionsPagination.total >= 5);
    assert.equal(subscriptionsPagination.pageSize, 50);
    const savedUltra = billing.byPlan.ULTRA.items.find(({ id }) => id === active.id);
    assert.equal(savedUltra?.plan, 'FREE');
    assert.equal(savedUltra?.effectivePlan, 'ULTRA');
    assert.equal(savedUltra?.paymentVerified, true);
    assert.equal(savedUltra?.currentPeriodEnd?.getTime(), until.getTime());
    assert(!billing.byPlan.PRO.items.some(({ id }) => id === active.id));
    const savedOwner = billing.byPlan.ULTRA.items.find(({ id }) => id === owner.id);
    assert.equal(savedOwner?.plan, 'FREE');
    assert.equal(savedOwner?.source, 'lifetime');
    assert.equal(savedOwner?.currentPeriodEnd, null);
    assert.equal(savedOwner?.paymentVerified, false);
    const savedPro = billing.byPlan.PRO.items.find(({ id }) => id === pro.id);
    assert.equal(savedPro?.source, 'paypal');
    assert.equal(savedPro?.paymentVerified, false);
    assert.equal(savedPro?.currentPeriodStart, null);
    const oldPeriods = billing.subscriptions.filter(({ userId }) => userId === expired.id);
    assert(oldPeriods.some(({ status, paymentVerified }) => status === 'expired' && paymentVerified));
    assert(oldPeriods.some(({ status, paymentVerified }) => status === 'revoked' && !paymentVerified));
    assert(!billing.subscriptions.some(({ userId }) => userId === owner.id));
    assert(!stripeKeys.some((key) => JSON.stringify(billing).includes(key)), 'Provider identifiers must not be returned');
    assert.equal(adminPage('2'), 2);
    assert.equal(adminPage('-1'), 1);
    assert.equal(adminPage('999999999999999999'), 1);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } }), owner);

    if (origin) {
      async function signIn(email: string) {
        const response = await fetch(new URL('/api/auth/login', origin!), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
        });
        assert.equal(response.status, 200);
        const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
        assert(cookie);
        return cookie;
      }
      const endpoint = new URL('/api/admin?ultraPage=2', origin);
      const fetchData = (Cookie?: string) => fetch(endpoint, { headers: Cookie ? { Cookie } : undefined });
      assert.equal((await fetchData()).status, 403);
      assert.equal((await fetchData(await signIn(active.email))).status, 403);
      const allowed = await fetchData(await signIn(legacyAdmin.email));
      assert.equal(allowed.status, 200);
      assert.match(allowed.headers.get('cache-control') ?? '', /private, no-store/);
      const payload = await allowed.json();
      assert.deepEqual(payload.account, { plan: 'ULTRA', lifetime: true });
      assert.equal(payload.billing.byPlan.ULTRA.pagination.page, 2);
      assert.equal(payload.pagination.users.pageSize, 50);
      assert.equal(payload.pagination.subscriptions.page, 1);
      assert.equal(payload.users.find(({ id }: { id: string }) => id === active.id)?.effectivePlan, 'ULTRA');
      assert(!stripeKeys.some((key) => JSON.stringify(payload).includes(key)), 'Provider identifiers must not be serialized by admin API');
    }
    console.log(`Admin billing passed local PostgreSQL: dated subscriptions, segmented members, owner lifetime, Stripe receipts and redaction${origin ? ', and private HTTP role authorization' : ''}.`);
  } finally {
    if (storedAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = storedAdminEmail;
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  }
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
