import type { WalletInvestmentSettings } from '@prisma/client';
import { readPeriod } from '../wallet-investments-server';
import { estimateInvestmentForecast } from './forecast';
import { readBrokerForecastInput } from './forecast-source.server';
import { readBrokerOwnerState } from './broker-owner-state.server';
import { prisma } from '../db';

export const investmentReads = ['analysis','order-gateway','reconciliation','weekly-report','kill-switch'] as const;
export type InvestmentRead = typeof investmentReads[number];

export function isInvestmentRead(value: string): value is InvestmentRead {
  return investmentReads.some(operation => value === operation);
}

async function readWorkerState(userId:string):Promise<'inactive'|'awaiting_verified_signal'|'unavailable'> {
  if (process.env.SHARKAI_BROKER_WORKER_ENABLED!=='true' || process.env.SHARKAI_BROKER_EVIDENCE_ENABLED!=='true' || !process.env.SHARKAI_ORDER_WORKER_DATABASE_URL
      || !process.env.SHARKAI_ORDER_WORKER_KEYS || !process.env.SHARKAI_ORDER_WORKER_CREDENTIALS) return 'inactive';
  try {
    const rows=await prisma.$queryRaw<Array<{enabled:boolean}>>`SELECT sharkai_broker.owner_worker_status(${userId}) AS enabled`;
    return rows[0]?.enabled===true ? 'awaiting_verified_signal' : 'inactive';
  } catch { return 'unavailable'; }
}

// Sources return only projections for the already-authenticated owner. This dispatch has no broker writes.
export async function readInvestmentWorkflow(
  operation: InvestmentRead,
  profile: WalletInvestmentSettings,
  userId: string,
  sources = {forecast:readBrokerForecastInput,broker:readBrokerOwnerState},
  workerStatus = readWorkerState,
) {
  const packet = (status: 'ok'|'blocked'|'unavailable', code: string, data: object | null) => ({
    status, code, operation, mode:'READ_ONLY', live_orders_enabled:false,
    source:'shark-ai-investments', timestamp:new Date().toISOString(), data,
  });
  if (profile.userId !== userId || profile.aiAccess !== 'ANALYSIS_ONLY') {
    return packet('blocked','OWNER_SCOPE_REQUIRED',null);
  }
  if (operation === 'order-gateway') {
    const automated=await workerStatus(userId);
    return packet(automated==='inactive' ? 'blocked' : automated==='unavailable' ? 'unavailable' : 'ok',
      automated==='inactive' ? 'ORDER_EXECUTION_NOT_ENABLED' : 'AUTOMATED_WORKER_STATUS',
      {automated_worker:automated,chat_submission_enabled:false,submission:null});
  }
  if (operation === 'analysis' || operation === 'weekly-report') {
    const selection = {currency:profile.currency,instrumentCode:profile.instrumentCode,strategyLabel:profile.strategyLabel};
    const input = await sources.forecast(userId,selection);
    if (operation === 'weekly-report') {
      return input.weeklyReport.status === 'available'
        ? packet('ok','VERIFIED_WEEKLY_REPORT',input.weeklyReport)
        : packet('unavailable','VERIFIED_WEEKLY_REPORT_REQUIRED',null);
    }
    const forecast = estimateInvestmentForecast({...selection,ownerId:userId,
      instrumentCode:selection.instrumentCode ?? input.history?.instrumentCode ?? null,
      strategyLabel:selection.strategyLabel ?? input.history?.strategyLabel ?? null,
      authorizedAmountMinor:profile.authorizedAmountMinor?.toString() ?? null,
      horizonDays:readPeriod(profile)?.horizon_days ?? null,funding:input.funding,history:input.history},
    );
    const budget=input.snapshot.profit_budget;
    if (forecast.status === 'available') return packet('ok','VERIFIED_STRATEGY_FORECAST',{...forecast,profit_budget:budget});
    if (forecast.authorized_funded_minor==='0') return packet('blocked','NO_ELIGIBLE_PROFIT_CAPITAL',{
      currency:profile.currency,authorized_funded_minor:'0',profit_budget:budget,reason:forecast.reason,
    });
    if (budget.status === 'verified') return packet('unavailable','VERIFIED_CAPITAL_WITHOUT_FORECAST',{
      broker:input.snapshot.provider,currency:budget.currency,observed_at:budget.observed_at,
      source:forecast.funding_source,authorized_funded_minor:forecast.authorized_funded_minor,profit_budget:budget,reason:forecast.reason,
    });
    return packet('unavailable',input.snapshot.status === 'stale' ? 'STALE_BROKER_FUNDING' : 'VERIFIED_BROKER_FUNDING_REQUIRED',null);
  }

  const broker = await sources.broker(userId);
  if (broker.status !== 'available' || broker.accounts.length === 0) {
    return operation === 'kill-switch'
      ? packet('blocked','ORDER_EXECUTION_NOT_ENABLED',{new_orders:'blocked',account_stop:null})
      : packet('unavailable','VERIFIED_RECONCILIATION_REQUIRED',null);
  }
  if (operation === 'kill-switch') {
    const accounts = broker.accounts.map(account => ({
      provider:account.provider,currency:account.currency,halted_at:account.halted_at,
      pending_reconciliation:account.reconciliation !== 'verified',
    }));
    return packet('ok','VERIFIED_ORDER_SAFETY_STATUS',{
      automated_worker:await workerStatus(userId),chat_submission_enabled:false,
      user_access_revoked_at:profile.tradingConsentRevokedAt?.toISOString() ?? null,accounts,
    });
  }
  const accounts = broker.accounts.map(account => ({
    provider:account.provider,currency:account.currency,status:account.reconciliation,observed_at:account.snapshot_at,
    verified_positions_in_snapshot_sample:account.reconciliation === 'verified' ? account.positions?.length ?? null : null,
    pending_items_in_recent_order_sample:account.recent_orders.filter(order=>order.reconciliation_required).length,
  }));
  return accounts.some(account=>account.status==='verified')
    ? packet('ok','VERIFIED_OWNER_RECONCILIATION',accounts)
    : packet('unavailable','RECONCILIATION_INCOMPLETE',accounts);
}
