import {randomUUID} from 'node:crypto';
import {Prisma,PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {prisma} from '../db';
import {authenticShopify,boundedBytes,commerceCredentials,confirmPrintful,currencies,digest,numericRef,readPrintfulDraft,readShopifyOrder,storeContract} from './providers.server';
import type {Store} from './providers.server';

type Raw=Pick<Prisma.TransactionClient,'$queryRaw'>;
export async function result(db:Raw,query:Prisma.Sql) {
  const rows=await db.$queryRaw<{r:unknown}[]>(query);
  return rows[0]?.r;
}
let source:PrismaClient|undefined;
export function commerceSourceDb() {
  const url=process.env.SHARKAI_COMMERCE_SOURCE_DATABASE_URL;
  if(!url)throw Error('Commerce source unavailable');
  const name=new URL(url).username;
  if(!name||['POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','SHARKAI_ORDER_WORKER_DATABASE_URL','SHARKAI_ORDER_PROFIT_DATABASE_URL',
    'SHARKAI_FEE_DATABASE_URL'].some(key=>process.env[key]&&new URL(process.env[key]!).username===name)) throw Error('Separate commerce role required');
  return source??=new PrismaClient({datasourceUrl:url,log:[]});
}
const scope=z.object({from:z.string().date(),to:z.string().date(),currency:currencies}).strict();
const cap=z.object({currency:currencies,amount_minor:z.string().regex(/^(?:0|[1-9][0-9]{0,11})$/),agent_read_allowed:z.boolean().optional()}).strict();
const amount=z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const day=z.object({date:z.string().date(),orders:z.number().int().nonnegative(),units:z.number().int().nonnegative(),revenue_minor:amount,
  refunds_minor:amount,goods_minor:amount,fulfillment_minor:amount,advertising_minor:amount,fees_minor:amount,other_costs_minor:amount});
const dashboard=z.object({status:z.enum(['available','unavailable']),currency:currencies,from:z.string().date(),to:z.string().date(),
  source_observed_at:z.string().nullable(),period_complete:z.boolean(),shop:z.object({connected:z.boolean(),supplier_connected:z.boolean()}),
  capital:z.object({limit_minor:amount,cash_minor:amount.nullable(),held_minor:amount,available_minor:amount,observed_at:z.string().nullable(),agent_read_allowed:z.boolean()}),
  orders:z.array(z.object({order_ref:numericRef,status:z.enum(['paid','pending','cancelled','refunded','partially_refunded']),total_minor:amount,refunded_minor:amount,
    ordered_at:z.string(),source_observed_at:z.string(),fulfillment:z.enum(['none','reviewed','submitting','accepted','uncertain'])})).max(100),daily:z.array(day).max(367)});
export async function readCommerceDashboard(userId:string,value:{from:string;to:string;currency:string},db:Raw=prisma) {
  const r=scope.parse(value);
  const days=(Date.parse(r.to)-Date.parse(r.from))/86400000;
  if(days<0||days>366)throw Error('Invalid reporting interval');
  const data=dashboard.parse(await result(db,Prisma.sql`SELECT sharkai_commerce.dashboard(${userId},${r.from}::date,${r.to}::date,${r.currency}) r`));
  if(data.shop.connected) {
    const bound=await readStore(db,userId,null);
    data.shop.supplier_connected=!!bound.printful_store;
  }
  return data;
}
export async function setCommerceCapital(userId:string,value:unknown,db:Raw=prisma) {
  const f=cap.parse(value);
  return (await result(db,Prisma.sql`SELECT sharkai_commerce.set_cap(${userId},${f.currency},${f.amount_minor}::bigint,${f.agent_read_allowed??null}::boolean) r`))===true;
}
export async function readCommerceAgentAccess(userId:string,db:Raw=prisma) {
  return z.object({enabled:z.boolean(),revision:z.number().int().nonnegative()}).parse(await result(db,Prisma.sql`SELECT sharkai_commerce.agent_access(${userId}) r`));
}
const readStore=async(db:Raw,user:string|null,shop:string|null)=>storeContract.parse(await result(db,Prisma.sql`SELECT sharkai_commerce.current_store(${user}::text,${shop}::text) r`));
const save=async(db:Raw,s:Store,receipt:string|null,rawDigest:string|null,data:unknown)=>result(db,Prisma.sql`SELECT sharkai_commerce.record_order(${s.id}::uuid,${receipt}::uuid,${rawDigest}::text,${JSON.stringify(data)}::jsonb) r`);
const payloadId=z.union([numericRef,z.number().int().positive().safe().transform(String)]);
export async function receiveShopify(req:Request,getDb=commerceSourceDb,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch) {
  const json=(status:string,code:number)=>Response.json({status},{status:code,headers:{'Cache-Control':'no-store'}});
  if(env.SHARKAI_COMMERCE_EVIDENCE_ENABLED!=='true')return json('unavailable',503);
  const shop=req.headers.get('x-shopify-shop-domain'),topic=req.headers.get('x-shopify-topic')??'';
  const delivery=z.string().uuid().safeParse(req.headers.get('x-shopify-webhook-id'));
  if(!shop||!/^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/.test(shop)||!delivery.success
    ||!['orders/paid','orders/updated','orders/cancelled','refunds/create'].includes(topic))return json('invalid',400);
  try {
    const db=getDb(),store=await readStore(db,null,shop),credentials=commerceCredentials(store,env),bytes=await boundedBytes(req,1048576);
    if(!authenticShopify(bytes,req.headers.get('x-shopify-hmac-sha256'),credentials.shopify_secret))return json('forbidden',403);
    const data=JSON.parse(bytes.toString('utf8'));
    const orderRef=topic==='refunds/create'? payloadId.safeParse(data.order_id):numericRef.safeParse(typeof data.admin_graphql_api_id==='string'
      ? /^gid:\/\/shopify\/Order\/([1-9][0-9]{0,19})$/.exec(data.admin_graphql_api_id)?.[1] : payloadId.safeParse(data.id).data);
    if(!orderRef.success)return json('invalid',400);
    const actual=await readShopifyOrder(store,orderRef.data,credentials,send);
    return (await save(db,store,delivery.data,digest(bytes.toString('base64')),actual.source))==='recorded'?json('recorded',200):json('unverified',409);
  } catch{return json('unavailable',503);}
}

const outcome=z.union([z.object({status:z.literal('reviewed'),review_id:z.string().uuid(),currency:currencies,max_cost_minor:amount,expires_at:z.string()}),
  z.object({status:z.enum(['blocked','claimed'])})]);
async function fulfill(userId:string,ref:string,review:string,action:'review'|'confirm',db:Raw,env:NodeJS.ProcessEnv,send:typeof fetch) {
  if(!numericRef.safeParse(ref).success||!z.string().uuid().safeParse(review).success||env.SHARKAI_COMMERCE_FULFILLMENT_ENABLED!=='true')return {status:'blocked'} as const;
  try{
    const store=await readStore(db,userId,null),k=commerceCredentials(store,env),s=await readShopifyOrder(store,ref,k,send);
    if(await save(db,store,null,null,s.source)!=='recorded'||!s.eligible)return {status:'blocked'} as const;
    const mapping=await result(db,Prisma.sql`SELECT sharkai_commerce.approved_mapping(${store.id}::uuid) r`);
    const q=await readPrintfulDraft(store,s,mapping,k,send);
    const guard=outcome.parse(await result(db,Prisma.sql`SELECT sharkai_commerce.authorize_fulfillment(${userId},${action},${ref},${review}::uuid,${q.supplier},${q.fingerprint},${s.source.digest}) r`));
    if(guard.status!=='claimed')return guard;
    let accepted=false;
    try {accepted=await confirmPrintful(store,ref,q.supplier,k,send);} catch { accepted=false; }
    try {
      const durable=await result(db,Prisma.sql`SELECT sharkai_commerce.finish_fulfillment(${userId},${review}::uuid,${q.supplier},${accepted}) r`);
      return {status:accepted&&durable===true?'accepted':'uncertain'} as const;
    }catch{return {status:'uncertain'} as const;}
  }catch{return {status:'unavailable'} as const;}
}
export function reviewCommerceFulfillment(userId:string,orderRef:string,db:Raw=prisma,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch) {
  return fulfill(userId,orderRef,randomUUID(),'review',db,env,send);
}
export function confirmCommerceFulfillment(userId:string,orderRef:string,review:string,db:Raw=prisma,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch) {
  return fulfill(userId,orderRef,review,'confirm',db,env,send);
}
