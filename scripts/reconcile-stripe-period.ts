import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { reconcileStripePeriod, StripeReconcileError } from '../lib/stripe-reconcile';

const prisma = new PrismaClient();

async function run() {
  let args;
  try {
    args = parseArgs({ options: { user: { type: 'string' }, invoice: { type: 'string' }, apply: { type: 'boolean' } } }).values;
  } catch {
    throw new StripeReconcileError('Употреба: npx tsx scripts/reconcile-stripe-period.ts --user <id> --invoice <id> [--apply]');
  }
  if (!args.user || !args.invoice) throw new StripeReconcileError('Посочете съществуващ акаунт с --user и фактура с --invoice.');
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeReconcileError('Липсва STRIPE_SECRET_KEY за същия Stripe акаунт и режим.');
  const result = await reconcileStripePeriod(prisma, new Stripe(key, { maxNetworkRetries: 1 }), args.user, args.invoice, { apply: args.apply });
  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', ...result }));
}

void run().catch((error: unknown) => {
  console.error(error instanceof StripeReconcileError ? error.message : 'Сверяването не завърши. Проверете достъпа до Stripe и PostgreSQL.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
