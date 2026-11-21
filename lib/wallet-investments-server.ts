import type { WalletInvestmentSettings } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { AccountSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { estimateInvestmentForecast } from '@/lib/investments/forecast';
import { resolveWalletStatus, walletOwnerCapabilities } from '@/lib/investments/wallet-status.server';
import { readBrokerForecastInput } from '@/lib/investments/forecast-source.server';
import { readPortfolioValuations } from '@/lib/investments/portfolio-valuations.server';
import { readOwnerPerformanceFee } from '@/lib/investments/performance-fee.server';
import { readBrokerOwnerState, revokeBrokerOwnerTrading } from '@/lib/investments/broker-owner-state.server';
import { targetCalendar, type WalletSettingsInput, type WalletTargetInput } from './wallet-investments-contract';

type WalletActor = Pick<AccountSession, 'id' | 'plan'>;
const storedPeriods = { day: 'DAY', days: 'CUSTOM_DAYS', week: 'WEEK', month: 'MONTH' } as const;
const publicPeriods = { DAY: 'day', CUSTOM_DAYS: 'days', WEEK: 'week', MONTH: 'month' } as const;
const headers = { 'Cache-Control': 'private, no-store' };

export function walletJson(body: object, status = 200) {
  return NextResponse.json(body, { status, headers });
}

export function getWalletSettings(userId: string) {
  return prisma.walletInvestmentSettings.findUnique({ where: { userId } });
}

export function readPeriod(profile: WalletInvestmentSettings | null) {
  if (!profile?.targetPeriod || !profile.targetStartDate) return null;
  const target: WalletTargetInput = {
    period: publicPeriods[profile.targetPeriod], days: profile.targetDays,
    amount_minor: profile.targetAmountMinor?.toString() ?? null, return_bps: profile.targetReturnBps,
    start_date: profile.targetStartDate.toISOString().slice(0, 10),
  };
  if (target.amount_minor !== null && target.return_bps !== null) return null;
  const calendar = targetCalendar(target);
  return calendar ? { ...target, ...calendar } : null;
}

export async function walletDashboard(profile: WalletInvestmentSettings | null, account: WalletActor, now?: Date, walletCurrency?: string) {
  const period = readPeriod(profile);
  const horizon = period ? {
    period: period.period, days: period.days, start_date: period.start_date,
    target_date: period.target_date, horizon_days: period.horizon_days,
  } : null;
  const target = period && (period.amount_minor !== null || period.return_bps !== null) ? period : null;
  const settings = {
    currency: profile?.currency ?? null,
    authorized_amount_minor: profile?.authorizedAmountMinor?.toString() ?? null,
    instrument_code: profile?.instrumentCode ?? null,
    strategy_label: profile?.strategyLabel ?? null,
    ai_access: profile?.aiAccess === 'ANALYSIS_ONLY' ? 'analysis_only' as const : 'off' as const,
    horizon,
    target,
    trading_consent: {
      status: profile?.tradingConsentRevokedAt ? 'revoked' as const : 'not_granted' as const,
      recorded_at: profile?.tradingConsentRevokedAt?.toISOString() ?? null,
    },
  };

  const [wallet, broker] = await Promise.all([
    resolveWalletStatus({ userId: account.id, currency: walletCurrency ?? settings.currency }),
    readBrokerForecastInput(account.id, {
      currency: settings.currency, instrumentCode: settings.instrument_code, strategyLabel: settings.strategy_label,
    }, now),
  ]);
  const investments = broker.snapshot;
  const forecastInput = {
    ownerId: account.id,
    currency: settings.currency,
    authorizedAmountMinor: settings.authorized_amount_minor,
    instrumentCode: settings.instrument_code ?? broker.history?.instrumentCode ?? null,
    strategyLabel: settings.strategy_label ?? broker.history?.strategyLabel ?? null,
    horizonDays: horizon?.horizon_days ?? null,
    funding: broker.funding,
    history: broker.history,
  };
  const forecast = estimateInvestmentForecast(forecastInput, now ?? new Date());
  return {
    settings, wallet, investments, forecast, weekly_report:broker.weeklyReport,
    entitlement: { plan: account.plan, source: 'shark-ai-backend' as const },
  };
}

export type WalletInvestmentsDashboard = Awaited<ReturnType<typeof walletDashboard>>;

export async function withBrokerOwnerActivity(dashboard: WalletInvestmentsDashboard, userId: string, walletCurrency?: string) {
  const { investments, settings } = dashboard;
  const [broker_activity, performance_fee, portfolio_valuations] = await Promise.all([
    readBrokerOwnerState(userId), readOwnerPerformanceFee(userId),
    investments.provider && (investments.status === 'verified' || investments.status === 'stale')
      ? readPortfolioValuations(userId, settings, investments.provider) : Promise.resolve([]),
  ]);
  return { ...dashboard, broker_activity, performance_fee, portfolio_valuations,
    wallet_capabilities: walletOwnerCapabilities({userId,currency:walletCurrency ?? dashboard.settings.currency}) };
}

export type WalletInvestmentsOwnerDashboard = Awaited<ReturnType<typeof withBrokerOwnerActivity>>;

export async function updateWalletSettings(account: WalletActor, input: WalletSettingsInput, walletCurrency?:string) {
  const userId = account.id;
  const { target } = input;
  const data = {
    currency: input.currency,
    authorizedAmountMinor: input.authorized_amount_minor === null ? null : BigInt(input.authorized_amount_minor),
    instrumentCode: input.instrument_code,
    strategyLabel: input.strategy_label,
    aiAccess: input.ai_access === 'analysis_only' ? 'ANALYSIS_ONLY' as const : 'OFF' as const,
    targetPeriod: target === null ? null : storedPeriods[target.period],
    targetDays: target?.days ?? null,
    targetAmountMinor: target?.amount_minor ? BigInt(target.amount_minor) : null,
    targetReturnBps: target?.return_bps ?? null,
    targetStartDate: target ? new Date(target.start_date + 'T00:00:00.000Z') : null,
  };
  const row = await prisma.walletInvestmentSettings.upsert({
    where: { userId },
    create: { userId, ...data, accessRevision: 1 },
    update: { ...data, accessRevision: { increment: 1 } },
  });
  return walletDashboard(row, account, undefined, walletCurrency);
}

export async function revokeWalletAccess(account: WalletActor, now = new Date(), walletCurrency?:string) {
  const userId = account.id;
  const data = { aiAccess: 'OFF' as const, tradingConsentRevokedAt: now };
  const row = await prisma.$transaction(async (tx) => {
    await revokeBrokerOwnerTrading(tx, userId);
    return tx.walletInvestmentSettings.upsert({
      where: { userId },
      create: { userId, ...data, accessRevision: 1 },
      update: { ...data, accessRevision: { increment: 1 } },
    });
  }, { timeout: 5000 });
  return walletDashboard(row, account, now, walletCurrency);
}
