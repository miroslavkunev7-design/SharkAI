import Stripe from 'stripe';
import { PLANS } from '@/lib/agents';
import { prisma } from '@/lib/db';

export type PaidPlan = 'PRO' | 'ULTRA';
type PaidInvoicePeriod = {
  period: { plan: PaidPlan; start: number; end: number; usage: NonNullable<Stripe.Price['recurring']>['usage_type'] | undefined };
  subscriptionId: string;
  customerId: string;
  inlineOwner?: string;
};

export function stripeBilling() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (process.env.STRIPE_REQUIRE_LIVE === 'true' && !/^[rs]k_live_/.test(key ?? '')) return null;
  return key && webhookSecret ? { stripe: new Stripe(key), webhookSecret } : null;
}

export function stripePriceId(plan: PaidPlan) {
  return plan === 'ULTRA' ? process.env.STRIPE_ULTRA_PRICE_ID : process.env.STRIPE_PRO_PRICE_ID;
}

export function isMonthlyPrice(price: Stripe.Price) {
  return price.recurring?.interval === 'month' && price.recurring.interval_count === 1;
}

export function stripeId(value: string | { id: string } | null | undefined) {
  return typeof value === 'string' ? value : value?.id;
}

export function stripeSubscriptionMatch(subscriptionId: string) {
  return { OR: [{ stripeSubId: subscriptionId }, { stripePeriodSubId: subscriptionId }] };
}

async function findSubscriber(stripe: Stripe, subscriptionId: string, customerId: string) {
  const known = await prisma.subscription.findMany({
    where: stripeSubscriptionMatch(subscriptionId), distinct: ['userId'], take: 2, select: { userId: true },
  });
  if (known.length) return known.length === 1 ? known[0].userId : null;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (stripeId(subscription.customer) !== customerId) return null;
  if (subscription.metadata.sharkaiUserId) return subscription.metadata.sharkaiUserId;

  // Older checkouts wrote the account ID only to the Checkout Session.
  const { data } = await stripe.checkout.sessions.list({ subscription: subscriptionId, limit: 1 });
  const session = data[0];
  return stripeId(session?.customer) === customerId ? session.metadata?.userId : null;
}

export async function paidStripeInvoicePeriod(stripe: Stripe, invoice: Stripe.Invoice): Promise<PaidInvoicePeriod | null> {
  const subscriptionId = stripeId(invoice.subscription);
  const customerId = stripeId(invoice.customer);
  if (!invoice.id || !subscriptionId || !customerId || !invoice.paid || invoice.paid_out_of_band || invoice.amount_paid <= 0) return null;

  const lines = invoice.lines.has_more
    ? await stripe.invoices.listLineItems(invoice.id).autoPagingToArray({ limit: 100 })
    : invoice.lines.data;
  const monthly = lines.flatMap((line) => {
    if (!line.price || line.proration || line.type !== 'subscription' || line.amount <= 0
      || line.period.end <= line.period.start || !isMonthlyPrice(line.price)) return [];
    return [{ price: line.price, quantity: line.quantity, start: line.period.start, end: line.period.end, usage: line.price.recurring?.usage_type }];
  });
  const periods = monthly.flatMap((line) => {
    const plans = (['ULTRA', 'PRO'] as const).filter((item) => stripePriceId(item) === line.price.id);
    return plans.length === 1 ? [{ ...line, plan: plans[0] }] : [];
  });
  if (periods.length === 1) return { period: periods[0], subscriptionId, customerId };
  if (periods.length || invoice.currency !== 'eur' || monthly.length !== 1) return null;

  const line = monthly[0];
  if (line.price.currency !== 'eur' || line.usage !== 'licensed' || line.price.unit_amount === null) return null;

  // Legacy checkout supplied inline prices. Keep renewals on the already linked paid account.
  const legacy = await prisma.subscription.findFirst({
    where: { stripeSubId: subscriptionId, paymentMethod: 'stripe', user: { role: 'USER' } },
    select: { plan: true, amountEur: true },
  });
  if (legacy && legacy.plan !== 'FREE') {
    const amounts = [PLANS[legacy.plan].price * 100, legacy.amountEur === null ? null : Math.round(legacy.amountEur * 100)];
    if (amounts.includes(line.price.unit_amount)) return { period: { ...line, plan: legacy.plan }, subscriptionId, customerId };
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const { sharkaiUserId, sharkaiPlan, sharkaiPriceContract } = subscription.metadata;
  if (subscription.id !== subscriptionId || stripeId(subscription.customer) !== customerId || sharkaiPriceContract !== 'monthly-v1' || !sharkaiUserId
    || (sharkaiPlan !== 'PRO' && sharkaiPlan !== 'ULTRA') || line.quantity !== 1
    || line.price.unit_amount !== PLANS[sharkaiPlan].price * 100) return null;
  return { period: { ...line, plan: sharkaiPlan }, subscriptionId, customerId, inlineOwner: sharkaiUserId };
}

export async function recordStripeInvoice(stripe: Stripe, invoice: Stripe.Invoice, revoked = false) {
  const paid = await paidStripeInvoicePeriod(stripe, invoice);
  if (!paid) return;
  const { period, subscriptionId, customerId } = paid;
  const userId = await findSubscriber(stripe, subscriptionId, customerId);
  if (!userId || (paid.inlineOwner && paid.inlineOwner !== userId)) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, stripeId: true } });
  if (!user || user.role === 'ADMIN' || (user.stripeId && user.stripeId !== customerId)) return;

  const periodId = `stripe-invoice:${invoice.id}`;
  const amountEur = invoice.currency === 'eur' && Number.isSafeInteger(invoice.amount_paid) ? invoice.amount_paid / 100 : null;
  const currentPeriodStart = new Date(period.start * 1_000);
  const currentPeriodEnd = new Date(period.end * 1_000);
  await prisma.$transaction(async (tx) => {
    const recorded = await tx.subscription.upsert({
      where: { id: periodId },
      create: {
        id: periodId, userId, plan: period.plan, stripePeriodSubId: subscriptionId,
        paymentMethod: 'stripe', amountEur, status: revoked ? 'revoked' : 'active',
        currentPeriodStart, currentPeriodEnd,
      },
      update: revoked ? { status: 'revoked' } : { id: periodId },
    });
    const legacy = invoice.billing_reason === 'subscription_create' && amountEur !== null
      ? await tx.subscription.findFirst({ where: { userId, stripeSubId: subscriptionId, stripeSessionId: { not: null } }, select: { id: true, stripeSessionId: true } })
      : null;
    const ledger = {
      userId, method: 'stripe', OR: [{ id: periodId }, { externalId: invoice.id }, { reference: invoice.id },
        ...(legacy?.stripeSessionId && amountEur !== null ? [{ subscriptionId: legacy.id, externalId: subscriptionId, reference: legacy.stripeSessionId, amountEur }] : [])],
    };
    if (recorded.status === 'revoked') {
      await tx.payment.updateMany({ where: ledger, data: { status: 'revoked' } });
      await tx.subscription.updateMany({
        where: { userId, stripeSubId: subscriptionId, status: 'active', currentPeriodStart, currentPeriodEnd },
        data: { status: 'revoked' },
      });
    } else if (amountEur !== null && !(await tx.payment.findFirst({ where: ledger, select: { id: true } }))) {
      await tx.payment.upsert({
        where: { id: periodId }, create: { id: periodId, userId, subscriptionId: periodId, amountEur, method: 'stripe', externalId: invoice.id },
        update: { id: periodId },
      });
    }
  });
}

export async function applyStripeEvent(stripe: Stripe, event: Stripe.Event) {
  let invoiceId: string | undefined;
  let revoke = false;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const checkout = event.data.object;
      if (checkout.mode === 'subscription' && checkout.payment_status === 'paid') invoiceId = stripeId(checkout.invoice);
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      invoiceId = event.data.object.id;
      break;
    case 'charge.refunded': {
      const charge = await stripe.charges.retrieve(event.data.object.id);
      if (charge.refunded) {
        invoiceId = stripeId(charge.invoice);
        revoke = true;
      }
      break;
    }
    case 'charge.dispute.created':
    case 'radar.early_fraud_warning.created': {
      const chargeId = stripeId(event.data.object.charge);
      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId);
        invoiceId = stripeId(charge.invoice);
        revoke = true;
      }
      break;
    }
    // Failed renewals and cancellation do not add or truncate a paid period.
  }

  if (invoiceId) await recordStripeInvoice(stripe, await stripe.invoices.retrieve(invoiceId), revoke);
}
