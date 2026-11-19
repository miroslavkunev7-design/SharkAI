import type {Prisma} from '@prisma/client';
import {z} from 'zod';
import {prisma} from '../db';

const day=86400000;
const iso=(time:number)=>new Date(time).toISOString().slice(0,10);
const minimum=(...v:number[])=>Math.min(...v.filter(Number.isFinite));
const dateTime=(s:string)=>Date.parse(s+'T00:00:00Z');
const positive=z.string().regex(/^[1-9]\d{0,18}$/);
const terms=z.object({currency:z.string().regex(/^[A-Z]{3}$/),period:z.enum(['DAY','WEEK','CUSTOM_DAYS','MONTH']),days:z.number().int().positive().nullable(),
  start_date:z.string().date(),goal_minor:positive.nullable(),goal_bps:z.number().int().positive().nullable(),capital_minor:positive,
  capital_source:z.literal('verified_settled_realized_profit_only'),performance_fee_bps:z.literal(1000),protection_policy_id:z.string().uuid()});
type Terms=z.infer<typeof terms>;
type Db=Pick<Prisma.TransactionClient,'$queryRaw'>;
type Mandate={version:string; terms:unknown; provider:string; accepted:Date;expires:Date;revoked:Date|null;halted:Date|null;loss_stop:Date|null;live:boolean};
type Row={observed:Date;net:string;realized:string;reports:number};
export type ProgressPoint={observed_at:string;net_minor:string;percent:string|null};
export type InvestmentProgressReport={status:'verified'|'no_mandate'|'no_observations'|'unavailable';stage:'active'|'stopped'|'revoked'|'expired'|'scheduled'|null;
  currency:string|null;provider:string|null;start:string|null;end:string|null;windows:string[];goal_minor:string|null;
  points:ProgressPoint[];reports:number;as_of:string|null;fresh:boolean;target_reached:boolean|null;realized_account_minor:string|null;
  basis:'verified_period_closeout_after_reported_costs'};
export function progressWindow(t:Pick<Terms,'start_date'|'period'|'days'>,at:number){
  const start=dateTime(t.start_date),today=Math.floor(at/day)*day;
  if(!Number.isFinite(start)||!Number.isFinite(today))return null;
  if(t.period!=='MONTH'){
    const length=t.period==='DAY'?1:t.period==='WEEK'?7:t.days;
    if(!length||length>3660)return null;
    const s=start+Math.max(0,Math.floor((today-start)/(day*length)))*day*length;
    return {start:iso(s),end:iso(s+day*length)};
  }
  const first=new Date(start),date=new Date(today);
  const anniversary=(offset:number)=>{
    const max=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+offset+1,0)).getUTCDate();
    return Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+offset,Math.min(first.getUTCDate(),max));
  };
  let months=Math.max(0,(date.getUTCFullYear()-first.getUTCFullYear())*12+date.getUTCMonth()-first.getUTCMonth());
  if(months&&anniversary(months)>today)months--;
  return {start:iso(anniversary(months)),end:iso(anniversary(months+1))};
}
function reachedPercent(value:bigint,target:bigint){
  const hundredths=value*BigInt(10000)/target;
  const digits=(hundredths<0?-hundredths:hundredths).toString().padStart(3,'0');
  return (hundredths<0?'-':'')+digits.slice(0,-2)+'.'+digits.slice(-2);
}
const empty=(status:InvestmentProgressReport['status']):InvestmentProgressReport=>({status,stage:null,currency:null,provider:null,start:null,end:null,
  windows:[],goal_minor:null,points:[],reports:0,as_of:null,fresh:false,target_reached:null,realized_account_minor:null,
  basis:'verified_period_closeout_after_reported_costs'});
export async function readInvestmentProgress(user:string,requested:string|null=null,db:Db=prisma,now=new Date()):Promise<InvestmentProgressReport>{
  try{
    const [m]=await db.$queryRaw<Mandate[]>`
      SELECT m.version::text,m.approved_terms terms,a.provider,m.accepted_at accepted,m.expires_at expires,m.revoked_at revoked,
         coalesce(a.operator_halted_at,a.halted_at) halted,m.loss_stopped_at loss_stop,
         (a.live_enabled AND a.consent_version=m.version::text AND a.revoked_at IS NULL AND a.consent_revoked_at IS NULL) live
      FROM sharkai_broker.owner_mandate m JOIN sharkai_broker.account a ON a.id=m.account_id AND a.user_id=m.user_id
      WHERE m.user_id=${user} AND m.accepted_at<=${now} ORDER BY m.accepted_at DESC LIMIT 1`;
    if(!m)return empty('no_mandate');
    const t=terms.parse(m.terms);
    const stoppedAt=minimum(now.valueOf(),m.expires.valueOf()-1,m.revoked?.valueOf()??NaN,m.loss_stop?.valueOf()??NaN,
      m.halted&&m.halted>=m.accepted?m.halted.valueOf():NaN);
    const current=progressWindow(t,stoppedAt);
    if(!current)return empty('unavailable');
    const windows=await db.$queryRaw<{start:string}[]>`
      SELECT DISTINCT w.start_date::text AS start FROM sharkai_broker.owner_mandate m
      JOIN sharkai_broker.profit_risk_window w ON w.version=m.version
      WHERE m.user_id=${user} AND m.version=${m.version}::uuid AND w.start_date<=${current.start}::date
      ORDER BY start DESC LIMIT 60`;
    const options=[...new Set([current.start,...windows.map(w=>w.start)])];
    if(requested&&!options.includes(requested))return empty('unavailable');
    const window=requested?progressWindow(t,dateTime(requested)):current;
    if(!window)return empty('unavailable');
    const rawTarget=t.goal_minor?BigInt(t.goal_minor):t.goal_bps?(BigInt(t.capital_minor)*BigInt(t.goal_bps)+BigInt(9999))/BigInt(10000):null;
    const state:InvestmentProgressReport={...empty('no_observations'),start:window.start,end:window.end,windows:options,goal_minor:rawTarget?.toString()??null,
      currency:t.currency,provider:m.provider,stage:m.revoked?'revoked':now>=m.expires?'expired':m.loss_stop||m.halted||!m.live?'stopped':
        dateTime(t.start_date)>now.valueOf()?'scheduled':'active'};
    const rows=await db.$queryRaw<(Row&{hit:boolean})[]>`
      WITH verified AS (SELECT r.observed_at observed,w.window_net_minor net,
          pe.gross_settled_gains_minor::numeric-pe.gross_settled_losses_minor-pe.total_costs_minor realized,
          floor(extract(epoch FROM r.observed_at-(w.start_date::timestamp AT TIME ZONE 'UTC'))*48/((w.end_date-w.start_date)*86400.0)) slot
        FROM sharkai_broker.owner_mandate m JOIN sharkai_broker.account a ON a.id=m.account_id AND a.user_id=m.user_id
        JOIN sharkai_broker.mandate_risk_snapshot r ON r.version=m.version
        JOIN sharkai_broker.profit_risk_window w ON w.version=m.version AND w.snapshot_id=r.snapshot_id
        JOIN sharkai_broker.verified_account_snapshot s ON s.account_id=a.id AND s.snapshot_id=r.snapshot_id AND s.observed_at=r.observed_at
        JOIN sharkai_broker.profit_evidence pe ON pe.policy_id::text=m.approved_terms->>'protection_policy_id'
          AND pe.policy_digest=m.approved_terms->>'protection_digest' AND pe.snapshot_id=r.snapshot_id AND pe.observed_at=r.observed_at
          AND pe.period_closeout_minor=w.window_net_minor AND pe.mandate_closeout_minor=r.net_pnl_minor
        JOIN sharkai_broker.profit_protection_policy p ON p.id=pe.policy_id AND p.user_id=m.user_id AND p.account_id=m.account_id
        WHERE m.user_id=${user} AND m.version=${m.version}::uuid AND w.start_date=${window.start}::date AND w.end_date=${window.end}::date
          AND r.observed_at>=m.accepted_at AND r.observed_at<least(m.expires_at,coalesce(m.revoked_at,'infinity'::timestamptz))
          AND r.observed_at BETWEEN (w.start_date::timestamp AT TIME ZONE 'UTC') AND ${now}
          AND r.observed_at<(w.end_date::timestamp AT TIME ZONE 'UTC')),
        sampled AS (SELECT *,count(*) OVER()::int reports,max(net) OVER()>=${rawTarget?.toString()??null}::numeric hit,
          row_number() OVER(PARTITION BY slot ORDER BY observed) first,
          row_number() OVER(PARTITION BY slot ORDER BY observed DESC) last,
          row_number() OVER(PARTITION BY slot ORDER BY net,observed) low,
          row_number() OVER(PARTITION BY slot ORDER BY net DESC,observed) high FROM verified)
      SELECT observed,net::text,realized::text,reports,hit FROM sampled WHERE 1 IN(first,last,low,high) ORDER BY observed`;
    if(!rows.length)return state;
    const latest=rows[rows.length-1];
    const points=rows.map(r=>({observed_at:r.observed.toISOString(),net_minor:r.net,percent:rawTarget?reachedPercent(BigInt(r.net),rawTarget):null}));
    return {...state,status:'verified',points,reports:latest.reports,as_of:latest.observed.toISOString(),
      fresh:state.stage==='active'&&window.start===current.start&&now.valueOf()-latest.observed.valueOf()<=120000,
      target_reached:rawTarget?latest.hit:null,realized_account_minor:latest.realized};
  }catch{return empty('unavailable');}
}
