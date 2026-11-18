import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { getActiveBillingPeriod, getEffectivePlan } from '../lib/billing';
import { reconcileStripePeriod, StripeReconcileError } from '../lib/stripe-reconcile';

assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.POSTGRES_PRISMA_URL ?? '').hostname), 'Use a disposable local PostgreSQL database.');
const prisma = new PrismaClient();
const fixtureId = randomUUID().replaceAll('-', '');
const priceId = `price_${fixtureId}`;
const start = Math.floor(Date.now() / 1000) - 86_400;
const end = start + 30 * 86_400;
const startAt = new Date(start * 1000);
const endAt = new Date(end * 1000);
process.env.STRIPE_ULTRA_PRICE_ID = priceId;

function stripeFixture(userId: string, email: string, name: string) {
  const invoiceId = `in_${fixtureId}_${name}`;
  const customerId = `cus_${fixtureId}_${name}`;
  const subscriptionId = `sub_${fixtureId}_${name}`;
  const chargeId = `ch_${fixtureId}_${name}`;
  const invoice = {
    id: invoiceId, charge: chargeId, customer: customerId, subscription: subscriptionId, livemode: false,
    customer_email: email, status: 'paid', paid: true, paid_out_of_band: false, amount_paid: 2800, currency: 'eur',
    lines: { has_more: false, data: [{
      type: 'subscription', amount: 2800, proration: false, period: { start, end },
      price: { id: priceId, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } },
    }] },
  };
  const subscription = { id: subscriptionId, customer: customerId, livemode: false, metadata: {} as Record<string, string> };
  const session = {
    status: 'complete', mode: 'subscription', subscription: subscriptionId, customer: customerId, livemode: false,
    metadata: { userId } as Record<string, string>, customer_details: { email },
  };
  const charge = {
    id: chargeId, invoice: invoiceId, customer: customerId, livemode: false, currency: 'eur', status: 'succeeded',
    paid: true, captured: true, amount_captured: 2800, amount_refunded: 0, disputed: false, refunded: false,
  };
  const warnings = { data: [] as unknown[], has_more: false };
  let calls = 0;
  const stripe = {
    invoices: { retrieve: async (id: string) => { assert.equal(id, invoiceId); calls += 1; return invoice; } },
    subscriptions: { retrieve: async (id: string) => { assert.equal(id, subscriptionId); return subscription; } },
    checkout: { sessions: { list: async (query: object) => {
      assert.deepEqual(query, { subscription: subscriptionId, customer: customerId, status: 'complete', limit: 100 });
      return { data: [session], has_more: false };
    } } },
    charges: { retrieve: async (id: string) => { assert.equal(id, chargeId); return charge; } },
    radar: { earlyFraudWarnings: { list: async (query: object) => { assert.deepEqual(query, { charge: chargeId, limit: 1 }); return warnings; } } },
  } as unknown as Stripe;
  return { stripe, invoice, invoiceId, subscription, session, customerId, subscriptionId, charge, warnings, calls: () => calls };
}

async function run() {
  const emails = ['legacy', 'admin', 'conflict', 'dated'].map((name) => `billing-reconcile-${name}-${fixtureId}@example.test`);
  const [legacy, admin, other, dated] = await Promise.all(emails.map((email, index) => prisma.user.create({ data: {
    email, passwordHash: 'fixture hash', role: index === 1 ? 'ADMIN' : 'USER', name: 'Existing test account', tokensLimit: 2890,
  } })));
  const accessSnapshot = (account: typeof legacy) => ({
    id: account.id, email: account.email, name: account.name, role: account.role, plan: account.plan,
    passwordHash: account.passwordHash, tokensLimit: account.tokensLimit, tokensUsed: account.tokensUsed,
  });
  const invoiceRow = (invoiceId: string) => prisma.subscription.findUnique({ where: { id: `stripe-invoice:${invoiceId}` } });
  try {
    const verified = stripeFixture(legacy.id, legacy.email, 'verified');
    assert.equal(await getEffectivePlan(legacy), 'FREE');
    await assert.rejects(reconcileStripePeriod(prisma, verified.stripe, legacy.id, verified.invoiceId), StripeReconcileError);
    const dryRun = await reconcileStripePeriod(prisma, verified.stripe, legacy.id, verified.invoiceId, { live: false });
    assert.deepEqual(dryRun, { outcome: 'eligible', plan: 'ULTRA', currentPeriodStart: startAt, currentPeriodEnd: endAt, customerLinkPending: true });
    assert.equal(await invoiceRow(verified.invoiceId), null);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } }), legacy);
    assert.doesNotMatch(JSON.stringify(dryRun), /(?:cus_|sub_|in_|@example\.test)/);

    const tryApply = () => reconcileStripePeriod(prisma, verified.stripe, legacy.id, verified.invoiceId, { apply: true, live: false });
    assert.deepEqual((await Promise.all([tryApply(), tryApply()])).map(({ outcome }) => outcome).sort(), ['already-recorded', 'applied']);
    assert.equal(await prisma.subscription.count({ where: { userId: legacy.id } }), 1);
    const saved = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(saved.stripeId, verified.customerId);
    assert.deepEqual(accessSnapshot(saved), accessSnapshot(legacy));
    assert.equal(await getEffectivePlan(legacy, new Date(startAt.getTime() - 1)), 'FREE');
    assert.equal(await getEffectivePlan(legacy, startAt), 'ULTRA');
    assert.equal(await getEffectivePlan(legacy, new Date(endAt.getTime() - 1)), 'ULTRA');
    assert.equal(await getEffectivePlan(legacy, endAt), 'FREE');
    assert.equal((await tryApply()).outcome, 'already-recorded');

    const legacyDates = stripeFixture(dated.id, dated.email, 'dates');
    const older = await prisma.subscription.create({ data: {
      userId: dated.id, stripeSubId: legacyDates.subscriptionId, plan: 'ULTRA', currentPeriodEnd: endAt,
    } });
    assert.equal((await getActiveBillingPeriod(dated.id))?.currentPeriodStart, null);
    assert.equal((await reconcileStripePeriod(prisma, legacyDates.stripe, dated.id, legacyDates.invoiceId, { apply: true, live: false })).outcome, 'applied');
    assert.deepEqual(await getActiveBillingPeriod(dated.id), { plan: 'ULTRA', currentPeriodStart: startAt, currentPeriodEnd: endAt });
    assert.deepEqual(await prisma.subscription.findUniqueOrThrow({ where: { id: older.id } }), older);

    const rejected = stripeFixture(other.id, other.email, 'rejected');
    const deny = () => assert.rejects(reconcileStripePeriod(prisma, rejected.stripe, other.id, rejected.invoiceId, { apply: true, live: false }), StripeReconcileError);
    await assert.rejects(reconcileStripePeriod(prisma, rejected.stripe, admin.id, rejected.invoiceId, { apply: true, live: false }), StripeReconcileError);
    assert.equal(rejected.calls(), 0, 'Administrator is rejected before querying the billing provider');
    delete rejected.session.metadata.userId;
    await deny(); // Identical email is no proof of account ownership.
    rejected.subscription.metadata.sharkaiUserId = other.id;
    assert.equal((await reconcileStripePeriod(prisma, rejected.stripe, other.id, rejected.invoiceId, { live: false })).outcome, 'eligible');
    rejected.session.metadata.userId = legacy.id;
    await deny(); // Subscription and Checkout proof disagree.
    rejected.session.metadata.userId = other.id;
    rejected.charge.refunded = true;
    await deny();
    rejected.charge.refunded = false;
    rejected.charge.amount_refunded = 1;
    await deny(); // A partially refunded charge still has refunded=false in Stripe.
    rejected.charge.amount_refunded = 0;
    rejected.charge.disputed = true;
    await deny();
    rejected.charge.disputed = false;
    rejected.warnings.data.push({ id: 'fraud-fixture' });
    await deny();
    rejected.warnings.data.pop();
    rejected.invoice.lines.data[0].period.end = start + 10;
    await deny();
    rejected.invoice.lines.data[0].period.end = end;
    await prisma.user.update({ where: { id: dated.id }, data: { stripeId: rejected.customerId } });
    await deny();
    await prisma.user.update({ where: { id: dated.id }, data: { stripeId: legacyDates.customerId } });
    const conflictingOwner = await prisma.subscription.create({ data: { userId: dated.id, stripeSubId: rejected.subscriptionId, plan: 'ULTRA' } });
    await deny();
    await prisma.subscription.delete({ where: { id: conflictingOwner.id } });
    const revoked = await prisma.subscription.create({ data: {
      id: `stripe-invoice:${rejected.invoiceId}`, userId: other.id, stripeSubId: rejected.subscriptionId, plan: 'ULTRA',
      status: 'revoked', currentPeriodStart: startAt, currentPeriodEnd: endAt,
    } });
    await deny();
    assert.deepEqual(await invoiceRow(rejected.invoiceId), revoked);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: other.id } }), other);
    console.log('Stripe reconciliation passed on local PostgreSQL and mocked Stripe: dry-run, exact date window, preserved legacy rows and admin, replay/concurrency, strict proof, and revoked payment protection.');
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  }
}

void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
