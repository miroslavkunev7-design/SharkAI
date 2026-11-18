import Stripe from 'stripe';
import { prisma } from '@/lib/db';

export type PaidPlan = 'PRO' | 'ULTRA';

export function stripeBilling() {
  const key = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
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

async function findSubscriber(stripe: Stripe, subscriptionId: string, customerId: string) {
  const known = await prisma.subscription.findFirst({
    where: { stripeSubId: subscriptionId },
    select: { userId: true },
  });
  if (known) return known.userId;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (stripeId(subscription.customer) !== customerId) return null;
  if (subscription.metadata.sharkaiUserId) return subscription.metadata.sharkaiUserId;

  // Older checkouts wrote the account ID only to the Checkout Session.
  const { data } = await stripe.checkout.sessions.list({ subscription: subscriptionId, limit: 1 });
  const session = data[0];
  return stripeId(session?.customer) === customerId ? session.metadata?.userId : null;
}

export async function recordStripeInvoice(stripe: Stripe, invoice: Stripe.Invoice, revoked = false) {
  const subscriptionId = stripeId(invoice.subscription);
  const customerId = stripeId(invoice.customer);
  if (!invoice.id || !subscriptionId || !customerId || !invoice.paid || invoice.paid_out_of_band || invoice.amount_paid <= 0) return;

  const lines = invoice.lines.has_more
    ? await stripe.invoices.listLineItems(invoice.id).autoPagingToArray({ limit: 100 })
    : invoice.lines.data;
  const periods = lines.flatMap((line) => {
    if (!line.price || line.proration || line.type !== 'subscription' || line.amount <= 0
      || line.period.end <= line.period.start || !isMonthlyPrice(line.price)) return [];
    const plans = (['ULTRA', 'PRO'] as const).filter((item) => stripePriceId(item) === line.price?.id);
    return plans.length === 1 ? [{ plan: plans[0], start: line.period.start, end: line.period.end }] : [];
  });
  if (periods.length !== 1) return;

  const userId = await findSubscriber(stripe, subscriptionId, customerId);
  if (!userId) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, stripeId: true } });
  if (!user || user.role === 'ADMIN' || (user.stripeId && user.stripeId !== customerId)) return;

  const period = periods[0];
  const periodId = `stripe-invoice:${invoice.id}`;
  await prisma.subscription.upsert({
    where: { id: periodId },
    create: {
      id: periodId,
      userId,
      plan: period.plan,
      stripeSubId: subscriptionId,
      status: revoked ? 'revoked' : 'active',
      currentPeriodStart: new Date(period.start * 1_000),
      currentPeriodEnd: new Date(period.end * 1_000),
    },
    update: revoked ? { status: 'revoked' } : { id: periodId },
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
