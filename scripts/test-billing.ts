import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { POST as handleWebhook } from '@/app/api/payments/webhook/route';
import { remainingChatTokens } from '@/lib/ai/workspace-chat';
import { getAccountSession } from '@/lib/auth';
import { getEffectivePlan } from '@/lib/billing';
import { prisma } from '@/lib/db';
import { applyStripeEvent } from '@/lib/stripe-billing';

const testKey = 'sk_test_local_billing_fixture';
const signingSecret = 'whsec_local_billing_fixture';
const signer = new Stripe(testKey);

function signedEvent(type: Stripe.Event.Type, object: object) {
  const body = JSON.stringify({ id: 'evt_local_fixture', type, data: { object } });
  const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret: signingSecret });
  return { body, signature, event: signer.webhooks.constructEvent(body, signature, signingSecret) };
}

async function main() {
  // Use a disposable PostgreSQL database with the SharkAI schema applied.
  assert.equal(process.env.SHARKAI_TEST_BILLING, '1', 'Use a disposable test database');
  await verifyWebhookSignature();

  const ids: string[] = [];
  const suffix = randomUUID();
  const userSelect = { id: true, email: true, plan: true, role: true } as const;
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  try {
    const free = await prisma.user.create({
      data: { email: `free-billing-${suffix}@example.invalid`, passwordHash: 'test-user' }, select: userSelect,
    });
    ids.push(free.id);
    const admin = await prisma.user.create({
      data: { email: `admin-billing-${suffix}@example.invalid`, passwordHash: 'test-user', role: 'ADMIN', plan: 'FREE', tokensLimit: 10, tokensUsed: 10 },
    });
    ids.push(admin.id);
    const secondAdmin = await prisma.user.create({
      data: { email: admin.email.toUpperCase(), passwordHash: 'test-user', role: 'ADMIN', plan: 'FREE' },
      select: userSelect,
    });
    ids.push(secondAdmin.id);
    const legacyAdmin = await prisma.user.create({
      data: { email: `legacy-admin-${suffix}@example.invalid`, passwordHash: 'test-user', role: 'ADMIN', plan: 'ULTRA', tokensLimit: 10, tokensUsed: 10 },
    });
    ids.push(legacyAdmin.id);
    process.env.ADMIN_EMAIL = ` ${admin.email} `;
    const manual = await prisma.user.create({
      data: { email: `manual-billing-${suffix}@example.invalid`, passwordHash: 'test-user', plan: 'ULTRA' },
      select: userSelect,
    });
    ids.push(manual.id);

    const start = Date.parse('2026-01-31T17:15:10Z');
    const end = Date.parse('2026-02-28T17:15:10Z');
    const invoiceId = `in_${suffix}`;
    const subscriptionId = `sub_${suffix}`;
    const customerId = `cus_${suffix}`;
    const priceId = `price_${suffix}`;
    process.env.STRIPE_ULTRA_PRICE_ID = priceId;
    const invoice = {
      id: invoiceId,
      subscription: subscriptionId,
      customer: customerId,
      paid: true,
      amount_paid: 2_800,
      lines: {
        has_more: false,
        data: [{
          type: 'subscription', amount: 2_800,
          price: { id: priceId, recurring: { interval: 'month', interval_count: 1 } },
          period: { start: start / 1_000, end: end / 1_000 },
        }],
      },
    } as Stripe.Invoice;
    const invoices = new Map([[invoiceId, invoice]]);

    function stripeSubscription(userId: string) {
      return {
        invoices: { retrieve: async (id: string) => {
          const invoice = invoices.get(id);
          assert.ok(invoice);
          return invoice;
        } },
        charges: { retrieve: async () => ({ refunded: true, invoice: invoiceId }) },
        subscriptions: { retrieve: async () => ({ customer: customerId, metadata: { sharkaiUserId: userId } }) },
      } as unknown as Stripe;
    }

    const paid = signedEvent('invoice.paid', { id: invoiceId }).event;
    await applyStripeEvent(stripeSubscription(admin.id), paid);
    assert.equal(await prisma.subscription.count({ where: { userId: admin.id } }), 0);
    assert.equal(await getEffectivePlan(admin, new Date(start - 1)), 'ULTRA');
    assert.equal(await getEffectivePlan(admin, new Date(end + 1)), 'ULTRA');
    const adminSession = await getAccountSession(admin.id);
    assert(adminSession);
    assert.equal(adminSession.plan, 'ULTRA');
    assert.equal(adminSession.lifetime, true);
    assert.equal(remainingChatTokens(adminSession), Infinity);
    assert.equal(await getEffectivePlan({ ...admin, role: 'USER' }, new Date(start)), 'FREE');
    assert.equal(await getEffectivePlan(secondAdmin, new Date(start)), 'FREE');
    const secondAdminSession = await getAccountSession(secondAdmin.id);
    assert.equal(secondAdminSession?.plan, 'FREE');
    assert.equal(secondAdminSession?.lifetime, undefined);
    delete process.env.ADMIN_EMAIL;
    const legacyAdminSession = await getAccountSession(legacyAdmin.id);
    assert(legacyAdminSession);
    assert.equal(legacyAdminSession.plan, 'ULTRA');
    assert.equal(legacyAdminSession.lifetime, true);
    assert.equal(remainingChatTokens(legacyAdminSession), Infinity);
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: legacyAdmin.id } }), legacyAdmin);
    process.env.ADMIN_EMAIL = free.email;
    const freeSession = await getAccountSession(free.id);
    assert.equal(freeSession?.plan, 'FREE');
    assert.equal(freeSession?.lifetime, undefined);
    assert.equal((await getAccountSession(admin.id))?.plan, 'FREE');
    process.env.ADMIN_EMAIL = admin.email;
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }), admin);
    assert.equal(await getEffectivePlan(manual, new Date(end + 1)), 'ULTRA');
    assert.equal((await getAccountSession(manual.id))?.lifetime, undefined);

    const stripe = stripeSubscription(free.id);
    const completed = signedEvent('checkout.session.completed', {
      mode: 'subscription', payment_status: 'unpaid', invoice: invoiceId,
    }).event;
    await applyStripeEvent(stripe, completed);
    invoices.set(invoiceId, { ...invoice, paid: false });
    await applyStripeEvent(stripe, paid);
    invoices.set(invoiceId, { ...invoice, paid_out_of_band: true });
    await applyStripeEvent(stripe, paid);
    assert.equal(await getEffectivePlan(free, new Date(start)), 'FREE');

    invoices.set(invoiceId, invoice);
    const asyncPayment = signedEvent('checkout.session.async_payment_succeeded', {
      mode: 'subscription', payment_status: 'paid', invoice: invoiceId,
    }).event;
    await Promise.all([applyStripeEvent(stripe, asyncPayment), applyStripeEvent(stripe, paid)]);
    assert.equal(await prisma.subscription.count({ where: { userId: free.id } }), 1);
    assert.equal(await getEffectivePlan(free, new Date(start - 1)), 'FREE');
    assert.equal(await getEffectivePlan(free, new Date(start)), 'ULTRA');
    assert.equal(await getEffectivePlan(free, new Date(end - 1)), 'ULTRA');
    assert.equal(await getEffectivePlan(free, new Date(end)), 'FREE');

    const renewalEnd = Date.parse('2026-03-31T17:15:10Z');
    const renewal = {
      ...invoice,
      id: `${invoiceId}_renewal`,
      lines: { ...invoice.lines, data: [{ ...invoice.lines.data[0], period: { start: end / 1_000, end: renewalEnd / 1_000 } }] },
    };
    invoices.set(renewal.id, renewal);
    await applyStripeEvent(stripe, signedEvent('invoice.payment_failed', { id: renewal.id }).event);
    assert.equal(await getEffectivePlan(free, new Date(end)), 'FREE');
    await applyStripeEvent(stripe, signedEvent('invoice.paid', { id: renewal.id }).event);
    assert.equal(await getEffectivePlan(free, new Date(end)), 'ULTRA');
    assert.equal(await getEffectivePlan(free, new Date(renewalEnd)), 'FREE');

    await applyStripeEvent(stripe, signedEvent('charge.refunded', { id: 'ch_fixture' }).event);
    await applyStripeEvent(stripe, paid);
    assert.equal(await getEffectivePlan(free, new Date(start)), 'FREE');
    assert.equal(await getEffectivePlan(free, new Date(end)), 'ULTRA');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: free.id } })).plan, 'FREE');
    console.log('Billing checks passed: signature, unpaid and out-of-band handling, retry, coverage, renewal, refund, exact lifetime owner matching and unchanged admin account.');
  } finally {
    if (previousAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousAdminEmail;
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function verifyWebhookSignature() {
  process.env.STRIPE_SECRET_KEY = testKey;
  process.env.STRIPE_WEBHOOK_SECRET = signingSecret;
  const { body, signature } = signedEvent('invoice.payment_failed', {});
  const request = (signature: string) => new NextRequest('http://localhost/api/payments/webhook', {
    method: 'POST', headers: { 'stripe-signature': signature }, body,
  });
  assert.equal((await handleWebhook(request('bad-signature'))).status, 400);
  assert.equal((await handleWebhook(request(signature))).status, 200);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
