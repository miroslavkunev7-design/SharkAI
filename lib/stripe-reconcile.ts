import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import type Stripe from 'stripe';
import { paidStripeInvoicePeriod, stripeId, stripeSubscriptionMatch, type PaidPlan } from './stripe-billing';

export class StripeReconcileError extends Error {}

type Account = { role: Role; stripeId: string | null };
type Store = Pick<Prisma.TransactionClient, 'subscription' | 'user'>;
type VerifiedPeriod = {
  userId: string; customerId: string; stripeSubId: string; id: string;
  plan: PaidPlan; currentPeriodStart: Date; currentPeriodEnd: Date;
};

function verifiedAccount(account?: Account | null): Account {
  if (!account || account.role !== 'USER') throw new StripeReconcileError('Изисква се съществуващ потребителски акаунт без администраторски права.');
  return account;
}

function requireCurrentPeriod(start: Date, end: Date) {
  const now = Date.now();
  if (!(start.getTime() <= now && now < end.getTime())) throw new StripeReconcileError('Периодът на платената фактура не е активен.');
}

async function readStripeEvidence(stripe: Stripe, userId: string, invoiceId: string, live: boolean): Promise<VerifiedPeriod> {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const chargeId = stripeId(invoice.charge);
  if (invoice.id !== invoiceId || invoice.status !== 'paid' || invoice.paid_out_of_band !== false
    || invoice.livemode !== live || !invoice.currency || invoice.lines.has_more || !chargeId) {
    throw new StripeReconcileError('Фактурата не предоставя пълни данни за еднозначно потвърдено плащане.');
  }
  const paid = await paidStripeInvoicePeriod(stripe, invoice);
  if (!paid || paid.period.usage !== 'licensed') throw new StripeReconcileError('Фактурата няма еднозначен платен месечен план.');
  const { period, subscriptionId, customerId } = paid;
  const currentPeriodStart = new Date(period.start * 1000);
  const currentPeriodEnd = new Date(period.end * 1000);
  requireCurrentPeriod(currentPeriodStart, currentPeriodEnd);

  const [subscription, sessions, charge] = await Promise.all([
    stripe.subscriptions.retrieve(subscriptionId),
    stripe.checkout.sessions.list({ subscription: subscriptionId, customer: customerId, status: 'complete', limit: 100 }),
    stripe.charges.retrieve(chargeId),
  ]);
  if (subscription.id !== subscriptionId || stripeId(subscription.customer) !== customerId || subscription.livemode !== invoice.livemode || sessions.has_more) {
    throw new StripeReconcileError('Stripe не потвърди еднозначна връзка на абонамента с клиента.');
  }
  const owners = new Set<string>();
  if (subscription.metadata.sharkaiUserId) owners.add(subscription.metadata.sharkaiUserId);
  for (const session of sessions.data) {
    if (session.mode !== 'subscription' || session.status !== 'complete' || stripeId(session.subscription) !== subscriptionId
      || stripeId(session.customer) !== customerId || session.livemode !== invoice.livemode) {
      throw new StripeReconcileError('Връзката на Stripe Checkout с фактурата е непълна.');
    }
    if (session.metadata?.userId) owners.add(session.metadata.userId);
  }
  if (owners.size !== 1 || !owners.has(userId)) {
    throw new StripeReconcileError('Метаданните на Stripe не доказват еднозначно, че фактурата принадлежи на този акаунт.');
  }
  if (charge.id !== chargeId || stripeId(charge.invoice) !== invoiceId || stripeId(charge.customer) !== customerId
    || charge.livemode !== invoice.livemode || charge.currency !== invoice.currency || charge.status !== 'succeeded'
    || !charge.paid || !charge.captured || charge.amount_captured <= 0 || charge.refunded !== false
    || charge.amount_refunded !== 0 || charge.disputed !== false) {
    throw new StripeReconcileError('Плащането по фактурата е неразрешено, оспорено или възстановено.');
  }
  const fraud = await stripe.radar.earlyFraudWarnings.list({ charge: chargeId, limit: 1 });
  if (fraud.data.length || fraud.has_more) throw new StripeReconcileError('Stripe има ранно предупреждение за това плащане.');

  return { userId, customerId, stripeSubId: subscriptionId, id: `stripe-invoice:${invoiceId}`, plan: period.plan, currentPeriodStart, currentPeriodEnd };
}

async function inspectLocal(store: Store, period: VerifiedPeriod, account: Account) {
  const { id, userId, customerId, stripeSubId, plan, currentPeriodStart, currentPeriodEnd } = period;
  const [otherCustomer, otherSubscription, byInvoice, matchingWindows] = await Promise.all([
    store.user.findFirst({ where: { id: { not: userId }, stripeId: customerId }, select: { id: true } }),
    store.subscription.findFirst({ where: { userId: { not: userId }, ...stripeSubscriptionMatch(stripeSubId) }, select: { id: true } }),
    store.subscription.findUnique({ where: { id } }),
    store.subscription.findMany({ where: { userId, currentPeriodEnd, AND: [stripeSubscriptionMatch(stripeSubId), { OR: [{ currentPeriodStart }, { currentPeriodStart: null }] }] },
      select: { status: true, plan: true, currentPeriodStart: true } }),
  ]);
  if ((account.stripeId && account.stripeId !== customerId) || otherCustomer || otherSubscription) {
    throw new StripeReconcileError('Съществуващите връзки към Stripe принадлежат на друг акаунт или клиент.');
  }
  if (matchingWindows.some((record) => record.status !== 'active' || record.plan !== plan)) {
    throw new StripeReconcileError('Съществува противоречив или отнет запис за този период.');
  }
  if (byInvoice && (byInvoice.status !== 'active' || byInvoice.userId !== userId || (byInvoice.stripePeriodSubId ?? byInvoice.stripeSubId) !== stripeSubId || byInvoice.plan !== plan
    || byInvoice.currentPeriodStart?.getTime() !== currentPeriodStart.getTime() || byInvoice.currentPeriodEnd?.getTime() !== currentPeriodEnd.getTime())) {
    throw new StripeReconcileError('Съществува противоречив или отнет запис за тази фактура.');
  }
  return { represented: Boolean(byInvoice || matchingWindows.some((record) => record.currentPeriodStart !== null)), needsLink: account.stripeId === null };
}

export async function reconcileStripePeriod(prisma: PrismaClient, stripe: Stripe, userId: string, invoiceId: string,
  { apply = false, live = true }: { apply?: boolean; live?: boolean } = {}) {
  if (!/^[\da-z_-]{1,128}$/i.test(userId) || !/^in_[\da-z_]{1,124}$/i.test(invoiceId)) {
    throw new StripeReconcileError('Необходими са валиден идентификатор на потребител и идентификатор на съществуваща Stripe фактура.');
  }
  const account = verifiedAccount(await prisma.user.findUnique({ where: { id: userId }, select: { role: true, stripeId: true } }));
  const period = await readStripeEvidence(stripe, userId, invoiceId, live);
  const { id, customerId, stripeSubId, plan, currentPeriodStart, currentPeriodEnd } = period;
  const coverage = { plan, currentPeriodStart, currentPeriodEnd };
  if (!apply) {
    const { represented, needsLink } = await inspectLocal(prisma, period, account);
    return { ...coverage, outcome: represented ? 'already-recorded' : 'eligible', customerLinkPending: !represented && needsLink };
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Account[]>`SELECT "role", "stripeId" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const { represented, needsLink } = await inspectLocal(tx, period, verifiedAccount(locked));
        requireCurrentPeriod(currentPeriodStart, currentPeriodEnd);
        if (represented) return { ...coverage, outcome: 'already-recorded', customerLinkPending: false };
        if (needsLink) await tx.user.update({ where: { id: userId }, data: { stripeId: customerId } });
        await tx.subscription.create({ data: { id, userId, stripePeriodSubId: stripeSubId, paymentMethod: 'stripe', status: 'active', ...coverage } });
        return { ...coverage, outcome: 'applied', customerLinkPending: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt === 1 || !(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      const concurrentWrite = ['P2002', 'P2034'].includes(error.code)
        || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code)));
      if (!concurrentWrite) throw error;
    }
  }
}
