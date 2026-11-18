import { randomBytes } from 'node:crypto';
import type { Plan, Prisma, Role } from '@prisma/client';
import { PLANS } from './agents';
import { planRank } from './billing';
import { prisma } from './db';

type PaidPlan = 'PRO' | 'ULTRA';
type Account = { role: Role; plan: Plan };

export class BankPaymentError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function bankTransferDetails() {
  const iban = process.env.PAYOUT_IBAN?.trim().replace(/\s+/gu, '').toUpperCase();
  const bank = process.env.PAYOUT_BANK?.trim();
  if (!iban || !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || !bank) return null;
  const accountName = process.env.PAYOUT_ACCOUNT_NAME?.trim() || null;
  return { iban, bank, accountName };
}

function validAmount(amount: number | null): amount is number {
  if (amount === null || !Number.isFinite(amount) || amount <= 0 || amount > 100_000) return false;
  return Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001;
}

async function lockAccount(tx: Prisma.TransactionClient, id: string) {
  const [account] = await tx.$queryRaw<Account[]>`SELECT "role", "plan" FROM "User" WHERE "id" = ${id} FOR UPDATE`;
  return account;
}

function nextMonth(start: Date) {
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

export async function startBankTransfer(userId: string, plan: PaidPlan) {
  const details = bankTransferDetails();
  if (!details) throw new BankPaymentError('Банковото плащане временно не е конфигурирано.', 503);

  const pending = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const account = await lockAccount(tx, userId);
    if (!account || account.role !== 'USER' || planRank[account.plan] >= planRank[plan]) {
      throw new BankPaymentError('Този акаунт вече има необходимия достъп.', 409);
    }
    const active = await tx.subscription.findFirst({
      where: {
        userId, status: 'active', plan: { in: plan === 'ULTRA' ? ['ULTRA'] : ['PRO', 'ULTRA'] },
        AND: [
          { OR: [{ currentPeriodStart: null }, { currentPeriodStart: { lte: now } }] },
          { OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }] },
        ],
      },
      select: { id: true },
    });
    if (active) throw new BankPaymentError('Този акаунт вече има необходимия достъп.', 409);

    const previous = await tx.subscription.findFirst({
      where: { userId, plan, status: 'pending', paymentMethod: 'bank' },
      orderBy: { createdAt: 'desc' }, select: { id: true, bankReference: true, amountEur: true },
    });
    if (previous) return previous;

    return tx.subscription.create({
      data: {
        userId, plan, status: 'pending', paymentMethod: 'bank',
        bankReference: `SHA-${randomBytes(8).toString('hex').toUpperCase()}`, amountEur: PLANS[plan].price,
      },
      select: { id: true, bankReference: true, amountEur: true },
    });
  });

  if (!pending.bankReference || !validAmount(pending.amountEur)) {
    throw new BankPaymentError('Чакащият банков превод е с непълни данни. Свържете се с поддръжката.', 409);
  }
  return { method: 'bank' as const, ...details, subscriptionId: pending.id, reference: pending.bankReference, amount: pending.amountEur, currency: 'EUR' as const };
}

export async function confirmManualPayment(adminId: string, id: string, reference: string, amount: number) {
  return prisma.$transaction(async (tx) => {
    const [admin, target] = await Promise.all([
      tx.user.findUnique({ where: { id: adminId }, select: { role: true } }),
      tx.subscription.findUnique({ where: { id }, select: { userId: true } }),
    ]);
    if (admin?.role !== 'ADMIN') throw new BankPaymentError('Само за администратор.', 403);
    if (!target) throw new BankPaymentError('Плащането не е намерено.', 404);
    const account = await lockAccount(tx, target.userId);
    if (account?.role !== 'USER' || target.userId === adminId) {
      throw new BankPaymentError('Плащането не може да промени този акаунт.', 409);
    }

    const subscription = await tx.subscription.findUnique({ where: { id }, select: {
      id: true, userId: true, plan: true, status: true, paymentMethod: true, bankReference: true, amountEur: true,
      currentPeriodStart: true, currentPeriodEnd: true,
    } });
    if (!subscription || subscription.userId !== target.userId || subscription.plan === 'FREE'
      || (subscription.paymentMethod !== 'bank' && subscription.paymentMethod !== 'mobile')) {
      throw new BankPaymentError('Плащането не е чакащ банков или мобилен превод.', 409);
    }
    const amountEur = subscription.amountEur;
    if (!subscription.bankReference || subscription.bankReference !== reference || !validAmount(amountEur)
      || !validAmount(amount) || Math.round(amountEur * 100) !== Math.round(amount * 100)) {
      throw new BankPaymentError('Референцията или сумата не съвпада с чакащото плащане.', 400);
    }

    const receiptId = `manual-payment:${id}`;
    const receipt = await tx.payment.findFirst({
      where: { OR: [{ id: receiptId }, { status: 'completed', method: subscription.paymentMethod, reference }] },
      select: { id: true },
    });
    if (subscription.status === 'active' && receipt?.id === receiptId) {
      return { id, plan: subscription.plan, status: subscription.status, currentPeriodStart: subscription.currentPeriodStart, currentPeriodEnd: subscription.currentPeriodEnd };
    }
    if (subscription.status !== 'pending' || receipt) {
      throw new BankPaymentError('Плащането вече е обработено или не е чакащо.', 409);
    }

    const now = new Date();
    const matchingPeriod = await tx.subscription.findFirst({
      where: { userId: target.userId, plan: subscription.plan, status: 'active', currentPeriodEnd: { gt: now } },
      select: { currentPeriodEnd: true }, orderBy: { currentPeriodEnd: 'desc' },
    });
    const currentPeriodStart = matchingPeriod?.currentPeriodEnd ?? now;
    const currentPeriodEnd = nextMonth(currentPeriodStart);
    const status = 'active';
    const updated = await tx.subscription.updateMany({ where: { id, userId: target.userId, status: 'pending' }, data: {
      status, currentPeriodStart, currentPeriodEnd,
    } });
    if (updated.count !== 1) throw new BankPaymentError('Плащането вече е обработено.', 409);
    await tx.payment.create({ data: {
      id: receiptId, userId: target.userId, subscriptionId: id, amountEur, currency: 'EUR',
      status: 'completed', method: subscription.paymentMethod, reference,
    } });
    return { id, plan: subscription.plan, status, currentPeriodStart, currentPeriodEnd };
  });
}
