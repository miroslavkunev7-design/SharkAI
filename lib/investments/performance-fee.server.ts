import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {prisma} from '../db';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const opaque=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const currency=z.string().regex(/^[A-Z]{3}$/);
const integer=z.string().regex(/^(?:0|-?[1-9]\d{0,18})$/).refine(value=>{
  try {const n=BigInt(value);return n>=BigInt('-9223372036854775808') && n<=BigInt('9223372036854775807');}catch{return false;}
});
const positive=integer.refine(value=>!value.startsWith('-') && value!=='0');
const common={agreement_digest:hash,currency,period_end:z.string().date()};
const debit={...common,amount_minor:positive,beneficiary_hash:hash,receipt_ref:opaque,posted_at:z.string().datetime({offset:true})};
export const performanceFeeEvent=z.discriminatedUnion('operation',[
  z.object({...common,operation:z.literal('period'),mandate_id:z.string().uuid(),period_start:z.string().date(),
    basis:z.literal('cumulative_settled_realized_after_all_costs_before_platform_fee_ex_flow'),
    opening_net_minor:integer,closing_net_minor:integer,closing_unrealized_loss_minor:integer.refine(v=>!v.startsWith('-')),report_ref:opaque}).strict(),
  z.object({...debit,operation:z.literal('credit'),posting:z.literal('provider_final_client_debit_and_beneficiary_credit'),debited_account_hash:hash}).strict(),
  z.object({...debit,operation:z.literal('reversal'),posting:z.literal('provider_final_full_fee_reversal'),original_credit_ref:opaque}).strict(),
]);
type FeeEvent=z.infer<typeof performanceFeeEvent>;
const money=z.string().regex(/^-?\d+$/);
const ownerProjection=z.object({
  status:z.literal('available'),rate_bps:z.literal(1000),currency,period_end:z.string().date(),
  eligible_profit_minor:money,period_result_minor:money,fee_minor:money,client_net_minor:money,
  settlement:z.enum(['accrued','credited','reversed']),
}).strict();
const unavailable={status:'unavailable',rate_bps:1000,currency:null,period_end:null,eligible_profit_minor:null,
  period_result_minor:null,fee_minor:null,client_net_minor:null,settlement:null} as const;
export async function readOwnerPerformanceFee(userId:string) {
  try {
    const rows=await prisma.$queryRaw<{result:unknown}[]>`SELECT sharkai_broker.owner_performance_fee(${userId}) AS result`;
    const parsed=ownerProjection.safeParse(rows[0]?.result);
    return parsed.success ? parsed.data : unavailable;
  } catch {return unavailable;}
}
const plan=z.enum(['FREE','PRO','ULTRA']);
const adminReport=z.object({
  status:z.literal('available'),from:z.string().date(),to:z.string().date(),timezone:z.literal('Europe/Sofia'),
  registrations:z.array(z.object({plan,count:z.number().int().nonnegative()})).length(3),
  members:z.array(z.object({id:z.string(),name:z.string().nullable(),email:z.string(),plan,signupPlan:plan.nullable(),createdAt:z.string().datetime()})).max(20),
  page:z.number().int().positive(),pageSize:z.literal(20),hasMore:z.boolean(),totalRegistrations:z.number().int().nonnegative(),
  currencies:z.array(z.object({currency,earned_minor:money,accrued_minor:money,credited_minor:money,reversed_minor:money,net_received_minor:money})),
}).strict();

export function adminFeePeriod(params:URLSearchParams,now=new Date()) {
  const date=z.string().date();
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const from=params.get('from')??(today.slice(0,7)+'-01'),to=params.get('to')??today,page=params.get('page')??'1';
  if(!date.safeParse(from).success || !date.safeParse(to).success || from>to || to>today || !/^[1-9]\d{0,8}$/.test(page)
    || ['from','to','page'].some(key=>params.getAll(key).length>1)) return null;
  return {from,to,page:Number(page)};
}
export async function readAdministratorFeeReceipts(userId:string,range:{from:string;to:string;page:number}) {
  const rows=await prisma.$queryRaw<{report:unknown}[]>`SELECT sharkai_broker.admin_fee_dashboard(${userId},
    ${range.from}::date,${range.to}::date,${range.page}::integer) AS report`;
  return adminReport.parse(rows[0]?.report);
}

type Env=Partial<NodeJS.ProcessEnv>;
let collectorDb:PrismaClient|undefined;
async function recordFeeEvent(collector:string,event:FeeEvent,digest:string,env:Env) {
  const url=env.SHARKAI_FEE_DATABASE_URL;
  if (!url) throw Error('Fee collector unavailable');
  const role=new URL(url).username;
  const otherUrls=[env.DATABASE_URL,env.POSTGRES_PRISMA_URL,env.POSTGRES_URL_NON_POOLING,env.SHARKAI_ORDER_SOURCE_DATABASE_URL,
    env.SHARKAI_ORDER_WORKER_DATABASE_URL,env.SHARKAI_ORDER_RUNNER_DATABASE_URL,env.SHARKAI_ORDER_PROFIT_DATABASE_URL];
  if (!role || otherUrls.some(other=>other && new URL(other).username===role)) throw Error('Fee collector role unavailable');
  collectorDb??=new PrismaClient({datasourceUrl:url,log:[]});
  const rows=await collectorDb.$transaction(async tx=>{
    await tx.$executeRaw`SET LOCAL statement_timeout='3s'`;
    return tx.$queryRaw<{result:string}[]>`SELECT sharkai_broker.record_performance_fee(${collector},${JSON.stringify(event)}::jsonb,${digest}) AS result`;
  },{maxWait:1500,timeout:4500});
  return rows[0]?.result;
}

async function readBody(request:Request) {
  const reader=request.body?.getReader();
  if (!reader) return null;
  const parts:Uint8Array[]=[];
  let bytes=0,expired=false;
  const deadline=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},2000);
  try {
    for (;;) {
      const step=await reader.read();
      if(step.done) return expired?null:Buffer.concat(parts);
      bytes+=step.value.byteLength;
      if(bytes>4096){await reader.cancel();return null;}
      parts.push(step.value);
    }
  } finally {clearTimeout(deadline);reader.releaseLock();}
}
export async function acceptFeeStatement(request:Request,env:Env=process.env,record=recordFeeEvent,now=Date.now) {
  const send=(status:string,code:number)=>Response.json({status},{status:code,headers:{'Cache-Control':'no-store'}});
  if(env.SHARKAI_FEE_EVIDENCE_ENABLED!=='true') return send('unavailable',503);
  const rawKeys=env.SHARKAI_FEE_COLLECTOR_KEYS;
  const collector=request.headers.get('x-shark-fee-collector')??'';
  const stamp=request.headers.get('x-shark-fee-time')??'';
  const signature=request.headers.get('x-shark-fee-signature')??'';
  if(!rawKeys || rawKeys.length>65536 || !/^[A-Za-z0-9_-]{1,64}$/.test(collector) || !/^\d{10}$/.test(stamp)
    || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(now()-Number(stamp)*1000)>60000) return send('forbidden',403);
  try {
    const keys=z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),hash).parse(JSON.parse(rawKeys));
    const values=Object.values(keys);
    if(!Object.hasOwn(keys,collector) || new Set(values).size!==values.length) return send('forbidden',403);
    for(const raw of [env.SHARKAI_ORDER_WORKER_KEYS,env.SHARKAI_ORDER_PROFIT_KEYS,env.SHARKAI_ORDER_SIGNAL_KEYS,env.SHARKAI_ORDER_QUOTE_KEYS]) {
      if(raw && Object.values(JSON.parse(raw)).some(other=>values.some(key=>key===other))) return send('unavailable',503);
    }
    if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json') return send('invalid',415);
    const body=await readBody(request);
    if(!body?.length) return send('invalid',400);
    const expected=createHmac('sha256',Buffer.from(keys[collector],'hex')).update('sharkai-performance-fee/v1\n'+collector+'\n'+stamp+'\n').update(body).digest();
    if(!timingSafeEqual(expected,Buffer.from(signature,'hex')) || Math.abs(now()-Number(stamp)*1000)>60000) return send('forbidden',403);
    let payload:unknown;
    try {payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{return send('invalid',400);}
    const checked=performanceFeeEvent.safeParse(payload);
    if(!checked.success) return send('invalid',400);
    const fingerprint=createHash('sha256').update(JSON.stringify(checked.data)).digest('hex');
    const status=await record(collector,checked.data,fingerprint,env);
    if(status==='recorded') return send(status,201);
    if(['credited','replayed','reversed'].includes(status)) return send(status,200);
    return send('unverified',status==='forbidden'?403:409);
  } catch {return send('unavailable',503);}
}
