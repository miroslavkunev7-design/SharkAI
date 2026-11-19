import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {prisma} from '../db';
import {currencyMinorDigits,targetCalendar} from '../wallet-investments-contract';
import {getWalletSettings} from '../wallet-investments-server';
import {estimateInvestmentForecast,observedRange,verifiedHistoricalReturns} from './forecast';
import {readBrokerForecastInput} from './forecast-source.server';

const periods=z.enum(['day','week_1','week_2','week_3','week_4','month']);
export const forecastQuoteRequest=z.object({
  amount_minor:z.string().refine(value=>/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=BigInt('9223372036854775807')),
  currency:z.string().regex(/^[A-Z]{3}$/).refine(value=>currencyMinorDigits(value)!==null),
  period:periods,
}).strict();
type QuoteInput=z.infer<typeof forecastQuoteRequest>;
const days={day:1,week_1:7,week_2:14,week_3:21,week_4:28} as const;
export function quoteHorizon(period:QuoteInput['period'],now:Date){
  const start_date=now.toISOString().slice(0,10);
  const target=targetCalendar({period:period==='month'?'month':'days',days:period==='month'?null:days[period],
    start_date,amount_minor:null,return_bps:null})!;
  return {start_date,end_date_exclusive:target.target_date,horizon_days:target.horizon_days};
}

// This read only reports an existing mandate for this specific forecast account and asset.
// Any execution still requires the separate order gateway, a current quote, and the broker's own checks.
export async function readForecastMandateCap(user:string,binding:string,db:Pick<Prisma.TransactionClient,'$queryRaw'>=prisma,config:NodeJS.ProcessEnv=process.env){
  if(config.SHARKAI_BROKER_WORKER_ENABLED!=='true'||config.SHARKAI_BROKER_EVIDENCE_ENABLED!=='true')return BigInt(0);
  try{
    const rows=await db.$queryRaw<{cap:string}[]>`
      SELECT greatest(0,least(
        (capacity.data->>'available_profit_minor')::numeric,
        (m.approved_terms->>'max_loss_minor')::numeric-(capacity.data->>'exposed_minor')::numeric,
        least(a.consent_cap_minor,a.entitlement_cap_minor,(m.approved_terms->>'capital_minor')::bigint)-(capacity.data->>'exposed_minor')::numeric
      ))::text cap
      FROM sharkai_forecast.binding f JOIN sharkai_broker.account a ON a.user_id=f.user_id AND lower(a.provider)=f.provider
        AND a.provider_key=f.account_key AND a.currency=f.currency
      JOIN sharkai_broker.owner_mandate m ON m.account_id=a.id AND m.user_id=a.user_id AND m.version::text=a.consent_version
      JOIN sharkai_broker.owner_application app ON app.singleton AND app.settings_table=to_regclass('"WalletInvestmentSettings"')
      JOIN sharkai_broker.asset asset ON asset.account_id=a.id AND asset.id=f.instrument_code AND asset.enabled AND asset.reconciled_snapshot_id=a.snapshot_id
      CROSS JOIN LATERAL (SELECT sharkai_broker.profit_capacity(a.user_id,a.id) AS data) capacity
      WHERE f.user_id=${user} AND f.id=${binding} AND f.revoked_at IS NULL AND f.expires_at>statement_timestamp()
        AND greatest(f.ownership_verified_at,f.strategy_isolation_verified_at,f.provider_read_approved_at)<=statement_timestamp()
        AND a.live_enabled AND a.halted_at IS NULL AND a.operator_halted_at IS NULL AND a.revoked_at IS NULL
        AND a.consent_revoked_at IS NULL AND a.consent_expires_at>statement_timestamp() AND a.consent_cap_minor>0 AND a.entitlement_cap_minor>0
        AND a.target_state IN ('NONE','PENDING') AND (a.target_state='NONE' OR
          (a.target_window_start<=statement_timestamp() AND a.target_window_end>statement_timestamp() AND a.target_checked_at=a.snapshot_at))
        AND m.revoked_at IS NULL AND m.loss_stopped_at IS NULL AND m.expires_at>statement_timestamp()
        AND m.approved_terms->>'strategy'=f.strategy_label AND (m.approved_terms->'assets') ? f.instrument_code
        AND m.approved_terms->>'protection_policy_id'=capacity.data->>'policy_id' AND m.approved_terms->>'protection_digest'=capacity.data->>'policy_digest'
        AND sharkai_broker.owner_can_trade(a.user_id) AND sharkai_broker.mandate_terms(a.user_id,m.policy_id,app.settings_table)=m.approved_terms
        AND capacity.data->>'status'='verified' AND capacity.data->>'closeout_nonnegative'='true'
        AND sharkai_broker.owner_worker_status(a.user_id)
        AND EXISTS (SELECT 1 FROM sharkai_broker.profit_protected_instrument i WHERE i.policy_id::text=capacity.data->>'policy_id'
          AND i.asset_id=asset.id AND i.provider_instrument_id=asset.broker_instrument_id AND i.currency=a.currency)
        AND (SELECT count(*) FROM (
          SELECT id FROM sharkai_broker.asset WHERE account_id=a.id AND held_units>0
          UNION SELECT asset_id FROM sharkai_broker.order_ledger WHERE account_id=a.id AND reconciliation_required AND side='BUY'
          UNION SELECT asset.id) occupied)<=(m.approved_terms->>'max_positions')::int`;
    return rows.length===1&&/^\d{1,25}$/.test(rows[0].cap)?BigInt(rows[0].cap):BigInt(0);
  }catch{return BigInt(0);}
}
type Profile={currency:string|null;authorizedAmountMinor:bigint|null;instrumentCode:string|null;strategyLabel:string|null;tradingConsentRevokedAt:Date|null};
type Sources={settings:(owner:string)=>Promise<Profile|null>;broker:typeof readBrokerForecastInput;mandate:(owner:string,binding:string)=>Promise<bigint>};
const sources:Sources={settings:getWalletSettings,broker:readBrokerForecastInput,mandate:readForecastMandateCap};
export async function quoteInvestment(owner:string,input:QuoteInput,now=new Date(),read:Sources=sources){
  const horizon=quoteHorizon(input.period,now);
  const profile=await read.settings(owner).catch(()=>null);
  const current=profile?.currency===input.currency?profile:null;
  const selection={currency:input.currency,instrumentCode:current?.instrumentCode??null,strategyLabel:current?.strategyLabel??null};
  const {history,funding}=await read.broker(owner,selection,now);
  const choice={ownerId:owner,...selection,instrumentCode:selection.instrumentCode??history?.instrumentCode??null,
    strategyLabel:selection.strategyLabel??history?.strategyLabel??null,horizonDays:horizon.horizon_days};
  const evidence=verifiedHistoricalReturns({...choice,history},now,input.period==='month');
  const requested=BigInt(input.amount_minor),range=observedRange(requested,evidence);
  const budget=BigInt(estimateInvestmentForecast({...choice,history:null,funding,
    authorizedAmountMinor:current&&!current.tradingConsentRevokedAt?current.authorizedAmountMinor?.toString()??null:null},now).authorized_funded_minor);
  const mandate=budget>BigInt(0)&&funding&&(!history||history.accountRef===funding.accountRef)
    ?await read.mandate(owner,funding.accountRef).catch(()=>BigInt(0)):BigInt(0);
  const eligible=[budget,mandate].reduce((least,value)=>value<least?value:least,requested);
  return {...input,...horizon,status:range?'available' as const:'unavailable' as const,reason:range?null:'insufficient_verified_history' as const,
    range,authorized_range:observedRange(eligible,evidence),authorized_funded_minor:eligible.toString(),sample_count:evidence?.outcomes.length??null,
    source:evidence?.source??null,instrument_code:evidence?choice.instrumentCode:null,strategy_label:evidence?choice.strategyLabel:null,
    as_of:evidence?.asOf??null,window_start:evidence?.windowStart??null,window_end:evidence?.windowEnd??null,
    basis:'historical_observed_extrema' as const,performance_fee_basis:'before_platform_performance_fee' as const};
}
