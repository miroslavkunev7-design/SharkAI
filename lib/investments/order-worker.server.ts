import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { buildBrokerOrderRequest, buildBrokerPoll, parseBrokerAcknowledgement, parseBrokerPoll } from './broker-protocols.server';
import type { BrokerRequest } from './broker-protocols.server';
import { orderFingerprint } from './order-boundary.server';

type Operation = 'submit' | 'poll';
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const command = z.object({job_id:z.string().uuid(),nonce:z.string().regex(/^[A-Za-z0-9_-]{22,86}$/)}).strict();
const number = z.number().int().min(1).max(999_999_999_999);
const date = z.string().datetime({offset:true});
const order = z.object({
  id:z.string().uuid(),worker_id:keyId,account_id:z.string().min(1).max(128),consent_version:z.string().min(1).max(128),
  instrument_asset_id:z.string().min(1).max(128),instrument_provider_id:number,currency:z.string().regex(/^[A-Z]{3}$/),
  minor_unit_digits:z.number().int().min(0).max(3),instrument_kind:z.enum(['STOCK','ETF']),saxo_extended_assets_verified:z.boolean(),
  minimum_units:number,maximum_units:number,quantity_step:number,price_tick_minor:number,side:z.enum(['BUY','SELL']),
  order_kind:z.enum(['LIMIT','MARKET']),units:number,limit_price_minor:number.nullable(),
  max_notional_minor:number,max_fee_minor:z.number().int().min(0).max(999_999_999_999),quote_at:date,quote_expires_at:date,
});
const states = z.enum(['RESERVED','SUBMITTING','ACKNOWLEDGED','PENDING','WORKING','PARTIALLY_FILLED','CANCEL_PENDING',
  'REVIEW_REQUIRED','FILLED','CANCELED','REJECTED','UNKNOWN','VOIDED']);
const profile = z.object({
  job:order,job_digest:hash,broker:z.enum(['IBKR','SAXO']),provider_account_key:z.string().min(1).max(128),
  credential_ref:keyId,credential_sha256:hash,credential_expires_at:date,state:states.nullable(),
  provider_order:z.string().regex(/^[1-9]\d{0,17}$/).nullable(),saxo_client:z.string().min(1).max(128).nullable(),
}).strict();
const credential = z.object({
  broker:z.enum(['IBKR','SAXO']),account_key:z.string().min(1).max(128),token:z.string().regex(/^[A-Za-z0-9._~+/=-]{16,8192}$/),
}).strict();
type Profile = z.infer<typeof profile>;
type Command = z.infer<typeof command>;
type Receipt = { key:string; order:string|null; correlation:string|null; state:string; filled:number|null; observed:string };

// Each role can execute only its corresponding functions. Nothing accepts SQL from the model or caller.
type Query = (sql:Prisma.Sql) => Promise<unknown>;
type DatabaseRole = 'source'|'profit'|'worker';
const clients:Partial<Record<DatabaseRole,PrismaClient>>={};
function privateQuery(role:DatabaseRole,config:Partial<NodeJS.ProcessEnv>): Query | null {
  const urls={source:config.SHARKAI_ORDER_SOURCE_DATABASE_URL,profit:config.SHARKAI_ORDER_PROFIT_DATABASE_URL,
    worker:config.SHARKAI_ORDER_WORKER_DATABASE_URL};
  const url=urls[role];
  if (!url) return null;
  // The independent auditor must not have an order, application, or broker-feed database identity.
  if (role==='profit') {
    const user=new URL(url).username;
    if (!user || [urls.source,urls.worker,config.DATABASE_URL,config.SHARKAI_FEE_DATABASE_URL]
      .some(other=>other && new URL(other).username===user)) return null;
  }
  const client=clients[role] ??= new PrismaClient({datasourceUrl:url,log:[]});
  return async sql => client.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '3s'`;
    const rows = await tx.$queryRaw<Array<{result:unknown}>>(sql);
    return rows.length === 1 ? rows[0].result : null;
  },{maxWait:1000,timeout:4000});
}
function configuredEntry(config:string|undefined, id:string) {
  if (!config || config.length > 65_536) return null;
  try {
    const map:unknown = JSON.parse(config);
    return map && typeof map==='object' && !Array.isArray(map) && Object.hasOwn(map,id) ? (map as Record<string,unknown>)[id] : null;
  } catch { return null; }
}
function reusedKey(secret:string, otherMaps:(string|undefined)[]) {
  return otherMaps.some(map=>{
    if (!map) return false;
    if (map.length>65_536) return true;
    try {
      const keys:unknown=JSON.parse(map);
      return !keys || typeof keys!=='object' || Array.isArray(keys) || Object.values(keys).includes(secret);
    } catch { return true; }
  });
}
const result = (status:string,code:number,detail?:string) =>
  Response.json({status,...(detail ? {code:detail} : {})},{status:code,headers:{'Cache-Control':'private, no-store'}});

async function bounded(stream:ReadableStream<Uint8Array>|null,limit:number,timeoutMs:number) {
  if (!stream) return null;
  const reader=stream.getReader();
  let expired=false;
  const timer=setTimeout(()=>{ expired=true; void reader.cancel().catch(()=>{}); },timeoutMs);
  const chunks: Uint8Array[]=[];
  let size=0;
  try {
    for (;;) {
      const part=await reader.read();
      if (part.done) break;
      size+=part.value.length;
      if (size>limit) { void reader.cancel().catch(()=>{}); return null; }
      chunks.push(part.value);
    }
    return expired ? null : Buffer.concat(chunks,size);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
type InputAction = Operation | 'quote' | 'signal' | 'account-snapshot' | 'profit-evidence';
async function signedPacket(request:Request,operation:InputAction,config:Partial<NodeJS.ProcessEnv>,clock:()=>Date) {
  const worker=keyId.safeParse(request.headers.get('x-shark-order-worker'));
  const timestamp=request.headers.get('x-shark-order-time') ?? '';
  const signature=request.headers.get('x-shark-order-signature') ?? '';
  if (!worker.success || !/^\d{10}$/.test(timestamp) || !hash.safeParse(signature).success
      || request.headers.get('content-type')?.split(';')[0].trim()!=='application/json') return null;
  const signerMaps={signal:config.SHARKAI_ORDER_SIGNAL_KEYS,broker:config.SHARKAI_ORDER_QUOTE_KEYS,
    profit:config.SHARKAI_ORDER_PROFIT_KEYS,worker:config.SHARKAI_ORDER_WORKER_KEYS};
  const role=operation==='profit-evidence'?'profit':operation==='signal'?'signal':
    operation==='quote'||operation==='account-snapshot'?'broker':'worker';
  const keyMap=signerMaps[role];
  const secret=configuredEntry(keyMap,worker.data);
  if (typeof secret!=='string' || !hash.safeParse(secret).success) return null;
  const otherKeys=Object.entries(signerMaps).filter(([name])=>name!==role).map(([,map])=>map);
  if (reusedKey(secret,[...otherKeys,config.SHARKAI_FEE_COLLECTOR_KEYS,config.SHARKAI_BROKER_FORECAST_CONNECTOR_KEYS])) return null;
  if (role==='profit' ? otherKeys.some(map=>configuredEntry(map,worker.data)!==null)
    : configuredEntry(signerMaps.profit,worker.data)!==null) return null;
  const body=await bounded(request.body,operation==='account-snapshot' ? 32768 : role==='worker' ? 512 : 4096,2000);
  const age=clock().valueOf()-Number(timestamp)*1000;
  if (!body || age<0 || age>15_000) return null;
  const expected=createHmac('sha256',Buffer.from(secret,'hex'))
    .update(['shark-order-v1',operation,worker.data,timestamp,''].join('\n')).update(body).digest();
  if (!timingSafeEqual(expected,Buffer.from(signature,'hex'))) return null;
  return {worker:worker.data,body};
}

const evidenceTerms=z.object({consent_version:z.string().uuid(),snapshot_id:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  asset_id:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),currency:z.string().regex(/^[A-Z]{3}$/),provider_instrument_id:number,
  side:z.enum(['BUY','SELL']),kind:z.literal('LIMIT'),units:number,limit_price_minor:number}).strict();
const signalPacket=z.object({binding_id:z.string().uuid(),signal_id:z.string().uuid(),observed_at:date,evidence_sha256:hash,
  provider:z.enum(['IBKR','SAXO']),provider_account_key:z.string().regex(/^[A-Za-z0-9_+=/-]{1,128}$/),terms:evidenceTerms}).strict();
const quotePacket=signalPacket.extend({expires_at:date,max_notional_minor:number,max_fee_minor:z.number().int().min(0).max(999_999_999_999),
  provider_enforced_no_short:z.boolean()}).strict();
const amount=z.string().regex(/^(0|[1-9]\d{0,17})$/);
const pnl=z.string().regex(/^(0|-?[1-9]\d{0,17})$/);
const reportId=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
// The independent report reconciles cumulative settled gains and losses against a separately
// reviewed, contractually isolated account. A balance, deposit, or projected gain cannot qualify.
const profitPacket=z.object({
  policy_id:z.string().uuid(),policy_digest:hash,snapshot_id:reportId,evidence_sha256:hash,
  report_ref:reportId,observed_at:date,provider:z.enum(['IBKR','SAXO']),
  provider_account_key:z.string().regex(/^[A-Za-z0-9_+=/-]{1,128}$/),currency:z.string().regex(/^[A-Z]{3}$/),
  protected_principal_minor:amount,gross_settled_gains_minor:amount,gross_settled_losses_minor:amount,
  total_costs_minor:amount,distributed_minor:amount,open_cost_basis_minor:amount,unrealized_loss_minor:amount,
  segregated_profit_cash_minor:amount,mandate_closeout_minor:pnl,period_closeout_minor:pnl,
}).strict();
const snapshotPacket=z.object({
  binding_id:z.string().uuid(),provider:z.enum(['IBKR','SAXO']),provider_account_key:z.string().regex(/^[A-Za-z0-9_+=/-]{1,128}$/),
  currency:z.string().regex(/^[A-Z]{3}$/),snapshot_id:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),observed_at:date,
  report_ref:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),evidence_sha256:hash,
  basis:z.literal('verified_complete_settled_no_margin_after_fees'),settled_cash_minor:amount,exposure_minor:amount,
  held_units:z.record(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),amount).refine(values=>Object.keys(values).length<=128),
  closed_jobs:z.array(z.string().uuid()).max(128),
  performance:z.object({consent_version:z.string().uuid(),lifetime_net_minor:pnl,window_net_minor:pnl,
    window_start:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),window_end:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict().nullable(),
}).strict();

// Fixed production origins, no redirects or automatic retry. Authentication/session establishment is performed by
// the separately approved broker OAuth connector. The token digest and account are pinned in the private binding.
async function brokerCall(request:BrokerRequest,token:string,send:typeof fetch) {
  const base = request.broker==='IBKR' ? 'https://api.ibkr.com/v1/api' : 'https://gateway.saxobank.com/openapi';
  const url=new URL(base+request.path);
  for (const [key,value] of Object.entries(request.query ?? {})) url.searchParams.set(key,value);
  const response=await send(url,{method:request.method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(4500),
    headers:{Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/json'},
    ...(request.body ? {body:JSON.stringify(request.body)} : {})});
  const raw=await bounded(response.body,65_536,3500);
  return {status:response.status,body:raw ? JSON.parse(raw.toString('utf8')) as unknown : null};
}
function payload(data:Profile) {
  const j=data.job;
  const intent={accountKey:j.account_id,requestKey:'worker:'+j.id,assetId:j.instrument_asset_id,
    side:j.side,kind:j.order_kind,units:j.units,...(j.limit_price_minor===null ? {} : {limitPriceMinor:j.limit_price_minor})};
  return buildBrokerOrderRequest(intent,{
    status:'eligible_for_reservation',broker:data.broker,providerAccountKey:data.provider_account_key,
    consentVersion:j.consent_version,fingerprint:orderFingerprint(intent),quoteObservedAt:j.quote_at,quoteExpiresAt:j.quote_expires_at,
    maxBuyDebitMinor:j.side==='BUY' ? j.max_notional_minor+j.max_fee_minor : 0,sellUnits:j.side==='SELL' ? j.units : 0,
  },{
    assetId:j.instrument_asset_id,providerInstrumentId:j.instrument_provider_id,currency:j.currency,minorUnitDigits:j.minor_unit_digits,
    minimumUnits:j.minimum_units,maximumUnits:j.maximum_units,quantityStep:j.quantity_step,priceTickMinor:j.price_tick_minor,
    supportedOrderKinds:[j.order_kind],assetKind:j.instrument_kind,saxoExtendedAssetsVerified:j.saxo_extended_assets_verified,
  });
}
async function persist(sql:Query,worker:string,c:Command,r:Receipt) {
  const recorded=await sql(Prisma.sql`SELECT sharkai_broker.record_worker_receipt(${worker},${c.job_id}::uuid,${c.nonce},
    ${r.key},${r.order},${r.correlation},${r.state},${r.filled}::bigint,${r.observed}::timestamptz) AS result`);
  return recorded==='recorded' || recorded==='replayed';
}
async function submit(sql:Query,worker:string,c:Command,p:Profile,token:string,send:typeof fetch,clock:()=>Date) {
  const outbound=payload(p);
  if (!outbound) return result('blocked',409,'UNSUPPORTED_ORDER');
  const claim=await sql(Prisma.sql`SELECT sharkai_broker.claim_profit_only_job(${worker},${c.job_id}::uuid,${c.nonce},
      ${p.job_digest},${p.credential_sha256},${outbound.clientReference}) AS result`);
  const replay=z.object({status:z.literal('replayed'),state:states}).safeParse(claim);
  if (replay.success) return result('replayed',200,replay.data.state);
  const confirmed=z.object({status:z.literal('claimed'),client_reference:z.literal(outbound.clientReference)}).safeParse(claim);
  if (!confirmed.success) return result('blocked',409,'APPROVAL_OR_LIMIT');
  let ack;
  try {
    if (clock().valueOf()>=Date.parse(p.job.quote_expires_at)) throw new Error('Quote expired');
    ack=parseBrokerAcknowledgement(p.broker,await brokerCall(outbound.request,token,send),outbound.clientReference);
  } catch { ack={status:'UNKNOWN'} as const; }
  const state=ack.status==='REJECTED_BY_PROVIDER' ? 'REJECTED' : ack.status;
  const recorded=await persist(sql,worker,c,{key:'submit:'+outbound.clientReference,order:'orderId' in ack ? ack.orderId ?? null : null,
    correlation:ack.status==='REVIEW_REQUIRED' ? ack.acknowledgementId : null,state,filled:state==='ACKNOWLEDGED' ? 0 : null,
    observed:clock().toISOString()}).catch(()=>false);
  return recorded && state!=='UNKNOWN' ? result(state,200) : result('UNKNOWN',202,'RECONCILIATION_REQUIRED');
}
async function poll(sql:Query,worker:string,c:Command,p:Profile,token:string,send:typeof fetch,clock:()=>Date) {
  if (!p.provider_order) return result('unavailable',409,'PROVIDER_ID_UNCONFIRMED');
  const binding={broker:p.broker,providerAccountKey:p.provider_account_key,providerOrderId:p.provider_order,
    instrumentId:p.job.instrument_provider_id,units:p.job.units,side:p.job.side,verifiedClientKey:p.saxo_client ?? undefined};
  const outgoing=buildBrokerPoll(binding);
  if (!outgoing) return result('unavailable',409,'PROVIDER_BINDING_REQUIRED');
  const claimed=await sql(Prisma.sql`SELECT sharkai_broker.begin_worker_poll(${worker},${c.job_id}::uuid,${c.nonce},
      ${p.job_digest},${p.credential_sha256}) AS result`);
  if (claimed!==true) return result('blocked',409,'POLL_UNAVAILABLE');
  const observation=parseBrokerPoll(binding,await brokerCall(outgoing,token,send));
  if (observation.state==='UNKNOWN' || !observation.providerReceiptId) return result('unavailable',409,'NO_CONFIRMED_STATE');
  const recorded=await persist(sql,worker,c,{key:'poll:'+createHash('sha256').update(observation.providerReceiptId).digest('hex'),
    order:p.provider_order,correlation:null,state:observation.state,filled:observation.filledUnits,
    observed:observation.providerObservedAt ?? clock().toISOString()});
  return recorded ? result(observation.state,200) : result('unavailable',409,'RECONCILIATION_REQUIRED');
}

export async function handleBrokerWorker(request:Request,operation:string,config:Partial<NodeJS.ProcessEnv>=process.env,
  sqlOverride?:Query,send:typeof fetch=fetch,clock:()=>Date=()=>new Date()) {
  if (operation!=='submit' && operation!=='poll' && operation!=='signal' && operation!=='quote' && operation!=='account-snapshot' && operation!=='profit-evidence') return result('unavailable',404);
  if (config.SHARKAI_BROKER_EVIDENCE_ENABLED!=='true' || ((operation==='submit' || operation==='signal')
      && config.SHARKAI_BROKER_WORKER_ENABLED!=='true')) return result('unavailable',503,'WORKER_DISABLED');
  let envelope;
  try { envelope=await signedPacket(request,operation,config,clock); } catch { envelope=null; }
  if (!envelope) return result('forbidden',403);
  let rawBody:unknown;
  try { rawBody=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(envelope.body)); } catch { return result('invalid',400); }
  try {
    if (operation==='profit-evidence') {
      const verified=profitPacket.safeParse(rawBody);
      if (!verified.success) return result('invalid',400);
      const store=sqlOverride ?? privateQuery('profit',config);
      if (!store) return result('unavailable',503);
      const normalized=JSON.stringify(verified.data);
      const digest=createHash('sha256').update(normalized).digest('hex');
      const accepted=await store(Prisma.sql`SELECT sharkai_broker.accept_profit_evidence(
        ${envelope.worker},${normalized}::jsonb,${digest}) AS result`);
      if (accepted==='recorded' || accepted==='replayed') return result(accepted,200);
      if (accepted==='forbidden') return result(accepted,403);
      if (accepted==='invalid') return result(accepted,400);
      return accepted==='conflict' ? result(accepted,409) : result('unavailable',503);
    }
    if (operation==='signal' || operation==='quote' || operation==='account-snapshot') {
      const valid=(operation==='signal'?signalPacket:operation==='quote'?quotePacket:snapshotPacket).safeParse(rawBody);
      if (!valid.success) return result('invalid',400);
      const input=sqlOverride ?? privateQuery('source',config);
      if (!input) return result('unavailable',503);
      const normalized=JSON.stringify(valid.data);
      const digest=createHash('sha256').update(normalized).digest('hex');
      const accepted=await input(operation==='account-snapshot'
        ? Prisma.sql`SELECT sharkai_broker.accept_account_snapshot(${envelope.worker},${normalized}::jsonb,${digest}) AS result`
        : Prisma.sql`SELECT sharkai_broker.accept_strategy_evidence(${operation},${envelope.worker},${normalized}::jsonb,${digest}) AS result`);
      if (accepted==='awaiting_evidence' || accepted==='queued' || accepted==='replayed' || accepted==='recorded') return result(accepted,200);
      return accepted==='forbidden' ? result('forbidden',403) : result('rejected',409);
    }
    const parsed=command.safeParse(rawBody);
    if (!parsed.success) return result('forbidden',403);
    const c={worker:envelope.worker,...parsed.data};
    const sql=sqlOverride ?? privateQuery('worker',config);
    if (!sql) return result('unavailable',503);
    const raw=await sql(Prisma.sql`SELECT sharkai_broker.read_worker_job(${c.worker},${c.job_id}::uuid) AS result`);
    const read=profile.safeParse(raw);
    if (!read.success || read.data.job.id!==c.job_id || read.data.job.worker_id!==c.worker) return result('unavailable',404);
    const p=read.data;
    const access=credential.safeParse(configuredEntry(config.SHARKAI_ORDER_WORKER_CREDENTIALS,p.credential_ref));
    if (!access.success || access.data.broker!==p.broker || access.data.account_key!==p.provider_account_key
        || Date.parse(p.credential_expires_at)<=clock().valueOf()+5000 || !timingSafeEqual(Buffer.from(p.credential_sha256,'hex'),
        createHash('sha256').update(access.data.token).digest())) return result('blocked',403,'CREDENTIAL_NOT_AUTHORIZED');
    return operation==='submit' ? await submit(sql,c.worker,c,p,access.data.token,send,clock) : await poll(sql,c.worker,c,p,access.data.token,send,clock);
  } catch { return result('unavailable',503,'INSPECT_DURABLE_STATE'); }
}
