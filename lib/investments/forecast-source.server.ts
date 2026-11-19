import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db';
import type { ForecastFunding, ForecastHistory } from './forecast';
import { previousBrokerReportWeek, verifiedBrokerWeeklyReport } from './weekly-report.server';

const acceptedHistorySources = ['ibkr_portfolio_analyst_net_strategy','saxo_account_history_net_strategy'] as const;
const acceptedFundingSources = ['ibkr_broker_settled_cash','saxo_broker_settled_cash'] as const;
const acceptedWeeklySources = ['ibkr_verified_weekly_report','saxo_verified_weekly_report'] as const;
const matchingProvider = (provider: string, source: string) => source.startsWith(provider + '_');
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const label = z.string().min(1).max(128).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const accountKey = z.string().regex(/^[A-Za-z0-9_+=/-]{1,128}$/);
const minor = z.string().regex(/^(0|[1-9]\d{0,24})$/);
const signedMinor = z.string().regex(/^(0|-?[1-9]\d{0,20})$/);
const units = z.string().regex(/^[1-9]\d{0,24}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const instant = z.string().datetime({offset:false});
const dayMs = 86_400_000;
const funding = z.object({
  source:z.enum(acceptedFundingSources), cash_basis:z.literal('settled_cash_no_margin'),
  available_minor:minor, equity_minor:minor.nullable(),
}).strict();
const fee = z.enum(['included','not_applicable']);
const history = z.object({
  source:z.enum(acceptedHistorySources), basis:z.literal('cash_flow_adjusted_after_fees'),
  strategy_version_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  coverage:z.literal('complete_daily_calendar'), valuation_basis:z.literal('unitized_strategy_nav'),
  fee_coverage:z.object({execution:fee,ongoing:fee,financing:fee,currencyConversion:fee}).strict(),
  applicable_capital_minor:z.object({min:units,max:units}).strict(),
  closes:z.array(z.object({
    date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),units:minor,kind:z.enum(['valued','confirmed_market_closed']),
  }).strict()).min(2).max(36_600),
}).strict();
const weeklyReport = z.object({
  source:z.enum(acceptedWeeklySources), complete:z.literal(true),
  window_start:instant,window_end:instant,
  realized_before_fees_minor:signedMinor,unrealized_open_minor:signedMinor,unrealized_close_minor:signedMinor,
  fees_minor:minor,deposits_minor:minor,withdrawals_minor:minor,
}).strict();
const choices = z.object({currency,instrument_code:label,strategy_label:label});
const requestedChoices = choices.extend({instrument_code:label.nullable(),strategy_label:label.nullable()});
const common = choices.extend({
  binding_id:identifier, provider:z.enum(['ibkr','saxo']), provider_account_key:accountKey, snapshot_id:identifier, observed_at:instant,
  provider_report_id:identifier,provider_evidence_sha256:z.string().regex(/^[a-f0-9]{64}$/),
});
const envelope = z.discriminatedUnion('kind',[
  common.extend({kind:z.literal('funding'),data:funding}).strict(),
  common.extend({kind:z.literal('history'),data:history}).strict(),
  common.extend({kind:z.literal('weekly_report'),data:weeklyReport}).strict(),
]);
const sourceRow = z.object({
  binding_ref:identifier, provider:z.enum(['ibkr','saxo']),currency,instrument_code:label,strategy_label:label,
  funding:funding.nullable(),funding_observed_at:instant.nullable(),
  history:history.nullable(),history_observed_at:instant.nullable(),
  weekly_report:weeklyReport.nullable(),weekly_observed_at:instant.nullable(),
}).strict();

function recent(value: string, now: number, limit: number) {
  const captured = Date.parse(value);
  return Number.isFinite(captured) && captured <= now && now - captured <= limit;
}
function utcDay(value: string) {
  const time = Date.parse(value+'T00:00:00.000Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value ? time : NaN;
}
function validCloses(data: z.infer<typeof history>, observed: string) {
  const first = utcDay(data.closes[0].date);
  const lastClose = first + data.closes.length * dayMs;
  const capture = Date.parse(observed);
  return Number.isFinite(first) && lastClose === Math.floor(capture / dayMs) * dayMs
    && BigInt(data.applicable_capital_minor.min) <= BigInt(data.applicable_capital_minor.max)
    && data.closes.every((close,index) => utcDay(close.date) === first + index * dayMs
      && (close.units !== '0' || (index === data.closes.length-1 && close.kind === 'valued'))
      && (close.kind === 'valued' || (index > 0 && close.units === data.closes[index-1].units)));
}

const MAX_PACKET = 3_000_000;
async function boundedBody(request: Request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  let timedOut = false;
  const abort = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 5_000);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_PACKET) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(next.value));
    }
    return timedOut ? null : Buffer.concat(chunks,length);
  } finally {
    clearTimeout(abort);
    reader.releaseLock();
  }
}

function connectorKey(connectorId: string, config: string | undefined) {
  if (!config || config.length > 16_384) return null;
  try {
    const keys: unknown = JSON.parse(config);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)
        || !Object.prototype.hasOwnProperty.call(keys,connectorId)) return null;
    const key = (keys as Record<string,unknown>)[connectorId];
    return typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) ? Buffer.from(key,'hex') : null;
  } catch {
    return null;
  }
}

export type AcceptResult = 'recorded' | 'replayed' | 'conflict' | 'stale' | 'invalid' | 'forbidden';
type AcceptSource = (collector: string, packet: string, fingerprint: string) => Promise<AcceptResult | null>;
async function writeSource(collector: string, packet: string, fingerprint: string) {
  const rows = await prisma.$transaction(async client => {
    await client.$executeRaw`SET LOCAL statement_timeout = '2s'`;
    return client.$queryRaw<Array<{result:AcceptResult}>>`
      SELECT sharkai_forecast.accept_snapshot(${collector},${packet}::jsonb,${fingerprint}) AS result
    `;
  },{maxWait:1_000,timeout:3_000});
  return rows.length === 1 ? rows[0].result : null;
}
const unavailable = () => Response.json({status:'unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});
const forbidden = () => Response.json({status:'forbidden'},{status:403,headers:{'Cache-Control':'no-store'}});

/** Signature covers the endpoint context, connector identity, timestamp and exact raw JSON bytes. */
export async function ingestBrokerForecastSource(
  request: Request,
  config: Partial<NodeJS.ProcessEnv> = process.env,
  accept: AcceptSource = writeSource,
  clock: () => Date = () => new Date(),
) {
  if (config.SHARKAI_BROKER_FORECAST_ENABLED !== 'true') return unavailable();
  const connector = identifier.safeParse(request.headers.get('x-shark-forecast-connector'));
  const signedAt = request.headers.get('x-shark-forecast-signed-at') ?? '';
  const signature = request.headers.get('x-shark-forecast-signature') ?? '';
  const start = clock().valueOf();
  if (!connector.success || !/^\d{10}$/.test(signedAt) || !/^[a-f0-9]{64}$/.test(signature)
      || Math.abs(start-Number(signedAt)*1_000)>60_000) return forbidden();
  const key = connectorKey(connector.data,config.SHARKAI_BROKER_FORECAST_CONNECTOR_KEYS);
  if (!key) return forbidden();

  try {
    const body = await boundedBody(request);
    if (!body) return Response.json({status:'invalid'},{status:413});
    const verified = createHmac('sha256',key).update('sharkai-broker-forecast/v1\n'+connector.data+'\n'+signedAt+'\n')
      .update(body).digest();
    const now = clock().valueOf();
    if (!timingSafeEqual(verified,Buffer.from(signature,'hex')) || Math.abs(now-Number(signedAt)*1_000)>60_000) return forbidden();
    const parsed = envelope.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
    if (!parsed.success) return Response.json({status:'invalid'},{status:400});
    const observation = parsed.data;
    const expiry = observation.kind === 'funding' ? 5 * 60_000 : observation.kind === 'weekly_report' ? 8 * dayMs : 3 * dayMs;
    const week = observation.kind === 'weekly_report' ? previousBrokerReportWeek(new Date(now)) : null;
    if (!matchingProvider(observation.provider,observation.data.source) || !recent(observation.observed_at,now,expiry)
      || (observation.kind==='history' && !validCloses(observation.data,observation.observed_at))
      || (observation.kind==='weekly_report' && (
        observation.data.window_start !== week?.window_start || observation.data.window_end !== week.window_end
        || Date.parse(observation.observed_at) < Date.parse(week.window_end)))) {
      return Response.json({status:'invalid'},{status:400});
    }
    const normalized = JSON.stringify(observation);
    const fingerprint = createHash('sha256').update(normalized).digest('hex');
    const status = await accept(connector.data,normalized,fingerprint);
    if (status === 'forbidden') return forbidden();
    if (status !== 'recorded' && status !== 'replayed' && status !== 'conflict' && status !== 'stale' && status !== 'invalid') return unavailable();
    return Response.json({status},{status:{recorded:201,replayed:200,conflict:409,stale:409,invalid:400}[status],
      headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return Response.json({status:'invalid'},{status:400});
    return unavailable();
  }
}

type FundingStatus = 'provider_unconfigured'|'provider_unlinked'|'verified'|'stale'|'unavailable';
const verifiedBudget = z.object({
  status:z.literal('verified'),currency,protected_principal_minor:minor,settled_realized_profit_minor:signedMinor,
  available_profit_minor:minor,unrealized_loss_minor:minor.nullable().optional(),performance_fee_hold_minor:minor.nullable().optional(),
  observed_at:z.string().datetime({offset:true}),
});
type ProfitBudget = {
  status:'verified'|'unverified'; currency:string|null; protected_principal_minor:string|null; settled_realized_profit_minor:string|null;
  available_profit_minor:string; unrealized_loss_minor:string|null; performance_fee_hold_minor:string|null; observed_at:string|null;
};
const unavailableBudget = (code:string|null):ProfitBudget => ({
  status:'unverified',currency:code,protected_principal_minor:null,settled_realized_profit_minor:null,
  available_profit_minor:'0',unrealized_loss_minor:null,performance_fee_hold_minor:null,observed_at:null,
});
type BudgetLookup = (user:string,binding:string)=>Promise<unknown>;
async function readProfitBudget(user:string,binding:string) {
  const rows=await prisma.$transaction(async client=>{
    await client.$executeRaw`SET LOCAL statement_timeout = '2s'`;
    return client.$queryRaw<Array<{result:unknown}>>`
      SELECT sharkai_broker.owner_profit_budget(${user}::text,${binding}::text) AS result
    `;
  },{maxWait:1_000,timeout:3_000});
  return rows[0]?.result;
}
async function profitBudget(user:string,binding:string,code:string,now:Date,lookup:BudgetLookup):Promise<ProfitBudget> {
  try {
    const checked=verifiedBudget.safeParse(await lookup(user,binding));
    if (checked.success) {
      const budget=checked.data;
      const available=BigInt(budget.available_profit_minor);
      const net=BigInt(budget.settled_realized_profit_minor);
      if (budget.currency===code && (available===BigInt(0) || available<=net) && recent(budget.observed_at,now.valueOf(),5*60_000)) {
        return {...budget,unrealized_loss_minor:budget.unrealized_loss_minor ?? null,
          performance_fee_hold_minor:budget.performance_fee_hold_minor ?? null,observed_at:new Date(budget.observed_at).toISOString()};
      }
    }
  } catch { /* An unverified broker allocation permits zero trading capital. */ }
  return unavailableBudget(code);
}
type BrokerSnapshot = {
  status: FundingStatus; provider: 'ibkr'|'saxo'|null; cash_available_minor: string|null; equity_minor: string|null;
  profit_budget:ProfitBudget;
  currency: string|null; observed_at: string|null; source: string|null; trading_status:'provider_unconfigured';
  live_orders_enabled:false; kill_switch_active:true;
};
export type BrokerForecastInputs = {funding: ForecastFunding|null; history: ForecastHistory|null; snapshot: BrokerSnapshot;
  weeklyReport:ReturnType<typeof verifiedBrokerWeeklyReport>};
type SourceLookup = (user: string,currency: string,instrument: string|null,strategy: string|null) => Promise<unknown>;
async function readSource(user: string, requestedCurrency: string, instrument: string|null, strategy: string|null) {
  const rows = await prisma.$transaction(async client => {
    await client.$executeRaw`SET LOCAL statement_timeout = '2s'`;
    return client.$queryRaw<Array<{result:unknown}>>`
      SELECT sharkai_forecast.read_source(${user},${requestedCurrency},${instrument},${strategy}) AS result
    `;
  },{maxWait:1_000,timeout:3_000});
  return rows.length === 1 ? rows[0].result : null;
}

/** Call only with the authenticated owner's ID and saved settings. Never accept those fields from an n8n message. */
export async function readBrokerForecastInput(
  userId: string,
  request: {currency:string|null;instrumentCode:string|null;strategyLabel:string|null},
  now = new Date(),
  config: Partial<NodeJS.ProcessEnv> = process.env,
  lookup: SourceLookup = readSource,
  lookupBudget: BudgetLookup = readProfitBudget,
): Promise<BrokerForecastInputs> {
  const empty = (status: FundingStatus,provider: BrokerSnapshot['provider']=null): BrokerForecastInputs =>
    ({funding:null,history:null,weeklyReport:verifiedBrokerWeeklyReport(null,null,now),
      snapshot:{status,provider,cash_available_minor:null,equity_minor:null,currency:null,profit_budget:unavailableBudget(request.currency),
      observed_at:null,source:null,live_orders_enabled:false,kill_switch_active:true,trading_status:'provider_unconfigured'}});
  if (config.SHARKAI_BROKER_FORECAST_ENABLED !== 'true') return empty('provider_unconfigured');
  const selected = requestedChoices.safeParse({currency:request.currency,instrument_code:request.instrumentCode,strategy_label:request.strategyLabel});
  if (!selected.success || !identifier.safeParse(userId).success) return empty('provider_unlinked');
  try {
    const { currency:accountCurrency,instrument_code,strategy_label } = selected.data;
    const data = await lookup(userId,accountCurrency,instrument_code,strategy_label);
    if (data === null) return empty('provider_unlinked');
    const checked = sourceRow.safeParse(data);
    if (!checked.success || checked.data.currency !== accountCurrency
        || (instrument_code !== null && checked.data.instrument_code !== instrument_code)
        || (strategy_label !== null && checked.data.strategy_label !== strategy_label)) return empty('unavailable');
    const row = checked.data;
    const currentFunding = row.funding && row.funding_observed_at && matchingProvider(row.provider,row.funding.source)
      && recent(row.funding_observed_at,now.valueOf(),5*60_000);
    const result = empty(currentFunding ? 'verified' : 'stale',row.provider);
    const report = row.weekly_report;
    if (report && row.weekly_observed_at && matchingProvider(row.provider,report.source)) {
      const broker = row.provider === 'ibkr' ? 'IBKR' : 'SAXO';
      result.weeklyReport = verifiedBrokerWeeklyReport({userId,providerAccountKey:row.binding_ref,broker,currency:accountCurrency},{
        ownerUserId:userId,providerAccountKey:row.binding_ref,broker,currency:accountCurrency,
        ownershipVerified:true,complete:true,sourceId:report.source,observedAt:row.weekly_observed_at,
        windowStart:report.window_start,windowEnd:report.window_end,realizedBeforeFeesMinor:report.realized_before_fees_minor,
        unrealizedOpenMinor:report.unrealized_open_minor,unrealizedCloseMinor:report.unrealized_close_minor,feesMinor:report.fees_minor,
        depositsMinor:report.deposits_minor,withdrawalsMinor:report.withdrawals_minor,
      },now);
    }
    if (currentFunding && row.funding && row.funding_observed_at) {
      result.snapshot = {...result.snapshot,cash_available_minor:row.funding.available_minor,equity_minor:row.funding.equity_minor,
        currency:accountCurrency,observed_at:row.funding_observed_at,source:row.funding.source};
    }
    const budget=await profitBudget(userId,row.binding_ref,accountCurrency,now,lookupBudget);
    result.snapshot.profit_budget=budget;
    if (budget.status==='verified' && budget.observed_at) {
      result.funding={currency:accountCurrency,availableMinor:budget.available_profit_minor,
        source:row.provider+'_segregated_realized_net_profit',observedAt:budget.observed_at,ownerId:userId,
        accountRef:row.binding_ref,basis:'segregated_settled_realized_net_profit'};
    }
    if (row.history && row.history_observed_at && matchingProvider(row.provider,row.history.source)
        && recent(row.history_observed_at,now.valueOf(),3*dayMs) && validCloses(row.history,row.history_observed_at)) {
      result.history = {currency:accountCurrency,instrumentCode:row.instrument_code,strategyLabel:row.strategy_label,
        source:row.history.source,observedAt:row.history_observed_at,basis:row.history.basis,closes:row.history.closes,
        ownerId:userId,accountRef:row.binding_ref,valuationBasis:row.history.valuation_basis,
        feeCoverage:row.history.fee_coverage,applicableCapitalMinor:row.history.applicable_capital_minor};
    }
    return result;
  } catch {
    return empty('unavailable');
  }
}
