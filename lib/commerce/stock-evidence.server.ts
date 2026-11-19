import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {boundedBytes,currencies,numericRef} from './providers.server';
import {commerceSourceDb,result} from './commerce.server';
import {readPurchaseBinding,verifyWarehouseReceipt} from './procurement.server';
const ref=z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),amount=z.string().regex(/^(?:0|[1-9]\d{0,11})$/);
const base={offer_id:z.string().uuid(),currency:currencies,contract_digest:hash,po_id:numericRef,product_id:ref,observed_at:z.string().datetime({offset:true}),report_ref:ref};
const count=z.number().int().min(0).max(1000000);
const schema=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('stock_payment'),basis:z.literal('final_cleared_all_in_business_purchase'),cost_minor:amount,cash_report_ref:ref}).strict(),
 z.object({...base,kind:z.literal('stock_receipt'),basis:z.literal('posted_zoho_owned_warehouse_receipt'),report_ref:numericRef,warehouse_id:numericRef,vendor_id:numericRef,units_received:count.positive()}).strict(),
 z.object({...base,kind:z.literal('stock_sales'),basis:z.literal('cumulative_settled_merchant_resales_net_of_discounts_ex_tax'),units_sold:count,units_on_hand:count,
  settled_revenue_minor:amount,refunded_minor:amount,selling_cost_minor:amount}).strict()
]);
export async function receiveStockEvidence(req:Request,env:NodeJS.ProcessEnv=process.env,db:Pick<Prisma.TransactionClient,'$queryRaw'>|null=null,send:typeof fetch=fetch) {
 const reply=(status:string,code:number)=>Response.json({status},{status:code,headers:{'cache-control':'no-store'}});
 if(env.SHARKAI_COMMERCE_EVIDENCE_ENABLED!=='true')return reply('unavailable',503);
 const who=req.headers.get('x-shark-commerce-collector')??'',stamp=req.headers.get('x-shark-commerce-time')??'',sig=req.headers.get('x-shark-commerce-signature')??'';
 if(!/^[a-z0-9_-]{1,64}$/i.test(who)||!/^\d{10}$/.test(stamp)||Math.abs(Date.now()-Number(stamp)*1000)>30000||!hash.safeParse(sig).success)return reply('forbidden',403);
 try{
  const raw=env.SHARKAI_COMMERCE_EVIDENCE_KEYS;if(!raw||raw.length>65536)return reply('unavailable',503);
  const keys=z.record(z.string(),hash).parse(JSON.parse(raw));
  if(!Object.hasOwn(keys,who)||new Set(Object.values(keys)).size!==Object.keys(keys).length)return reply('forbidden',403);
  for(const name of ['SHARKAI_ORDER_PROFIT_KEYS','SHARKAI_ORDER_WORKER_KEYS','SHARKAI_ORDER_QUOTE_KEYS','SHARKAI_ORDER_SIGNAL_KEYS','SHARKAI_FEE_COLLECTOR_KEYS'])
   if(env[name]&&Object.values(JSON.parse(env[name]!)).some(v=>Object.values(keys).includes(String(v))))return reply('unavailable',503);
  const bytes=await boundedBytes(req,8192);
  if(!timingSafeEqual(createHmac('sha256',Buffer.from(keys[who],'hex')).update('sharkai-stock/v1\n'+who+'\n'+stamp+'\n').update(bytes).digest(),Buffer.from(sig,'hex'))
    ||Math.abs(Date.now()-Number(stamp)*1000)>30000)return reply('forbidden',403);
  const p=schema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(!p.success)return reply('invalid',400);
  const e=p.data,source=db??commerceSourceDb();
  if(e.kind==='stock_receipt'){
   const b=await readPurchaseBinding(source,null,e.offer_id,true);
   if(b.po!==e.po_id||b.vendor!==e.vendor_id||b.warehouse!==e.warehouse_id||b.contract!==e.contract_digest||b.currency!==e.currency
     ||!await verifyWarehouseReceipt(b,e.report_ref,e.units_received,env,send))return reply('unverified',409);
  }
  const fp=createHash('sha256').update(JSON.stringify(e)).digest('hex');
  const out=await result(source,Prisma.sql`SELECT sharkai_commerce.record_stock_proof(${who},${JSON.stringify(e)}::jsonb,${fp}) r`);
  return out==='recorded'||out==='replayed'?reply(out,200):reply('unverified',out==='forbidden'?403:409);
 }catch{return reply('unavailable',503);}
}
