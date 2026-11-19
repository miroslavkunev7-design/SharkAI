import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {commerceSourceDb,result} from './commerce.server';
import {boundedBytes,currencies,numericRef} from './providers.server';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const opaque=z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const amount=z.string().regex(/^(?:0|[1-9][0-9]{0,11})$/);
const signedAmount=z.string().regex(/^(?:0|-?[1-9][0-9]{0,11})$/);
const count=z.number().int().nonnegative().max(10000000);
const common={store_id:z.string().uuid(),currency:currencies,contract_digest:hash,report_ref:opaque,observed_at:z.string().datetime({offset:true})};
const shop=z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/);
const custody=z.string().min(1).max(200);
const ownerPayout=z.object({...common,kind:z.literal('resale_owner_payout'),basis:z.literal('settled_same_currency_owner_profit_payout'),
 shop,custody_ref:custody,beneficiary_digest:hash,evidence_sha256:hash,amount_minor:z.string().regex(/^[1-9][0-9]{0,11}$/),
 debit_ref:opaque,credit_ref:opaque}).strict();
const resaleWeek=z.object({
 ...common,kind:z.literal('resale_week'),basis:z.literal('settled_resale_after_all_costs_excluding_external_flows'),
 shop,custody_ref:custody,
 evidence_sha256:hash,week_start:z.string().date(),week_end:z.string().date(),previous_report_ref:opaque.nullable(),
 opening_cumulative_net_minor:signedAmount,closing_cumulative_net_minor:signedAmount,net_minor:signedAmount,
 settled_receipts_minor:amount,refunds_minor:amount,goods_minor:amount,fulfillment_minor:amount,recovered_purchase_cost_minor:amount,
 recovered_purchases:z.array(z.object({kind:z.enum(['fulfillment','procurement']),ref:opaque,
   amount_minor:z.string().regex(/^[1-9][0-9]{0,11}$/)}).strict()).max(1000),
 advertising_minor:amount,fees_minor:amount,taxes_minor:amount,other_costs_minor:amount,
}).strict();
function reconcilesResaleWeek(e:z.infer<typeof resaleWeek>){
 const start=Date.parse(e.week_start+'T00:00:00Z'),end=Date.parse(e.week_end+'T00:00:00Z'),day=86400000;
 if(new Date(start).getUTCDay()!==1 || end-start!==6*day || Date.parse(e.observed_at)<end+day) return false;
 if(e.previous_report_ref===e.report_ref || (e.previous_report_ref===null && e.opening_cumulative_net_minor!=='0'))return false;
 const costs=[e.refunds_minor,e.goods_minor,e.fulfillment_minor,e.advertising_minor,e.fees_minor,e.taxes_minor,e.other_costs_minor];
 const net=costs.reduce((balance,cost)=>balance-BigInt(cost),BigInt(e.settled_receipts_minor));
 const inventoryCost=BigInt(e.goods_minor)+BigInt(e.fulfillment_minor), recovered=BigInt(e.recovered_purchase_cost_minor);
 const afterOtherCosts=net+inventoryCost;
 if(recovered>inventoryCost || (recovered>BigInt(0) && recovered>afterOtherCosts))return false;
 if(new Set(e.recovered_purchases.map(row=>row.kind+':'+row.ref)).size!==e.recovered_purchases.length)return false;
 if(e.recovered_purchases.reduce((total,row)=>total+BigInt(row.amount_minor),BigInt(0))!==recovered)return false;
 return net===BigInt(e.net_minor) && BigInt(e.closing_cumulative_net_minor)===BigInt(e.opening_cumulative_net_minor)+net;
}
const product=z.object({product_id:opaque,name:z.string().trim().min(1).max(120),shopify_variant:numericRef,printful_variant:numericRef.nullable().optional(),inventory_units:count}).strict();
const metric=z.object({product_id:opaque,orders:count,units:count,revenue_minor:amount,refunds_minor:amount,goods_minor:amount,fulfillment_minor:amount,
  advertising_minor:amount,fees_minor:amount,other_costs_minor:amount,customer_count:count,largest_customer_revenue_minor:amount}).strict()
  .refine(x=>x.customer_count<=x.orders && x.orders<=x.units && BigInt(x.largest_customer_revenue_minor)<=BigInt(x.revenue_minor) &&
    (x.orders>0 || (x.units===0 && x.customer_count===0 && x.revenue_minor==='0')));
const evidence=z.discriminatedUnion('kind',[
 resaleWeek,ownerPayout,
 z.object({...common,kind:z.literal('cash'),basis:z.literal('settled_dedicated_commerce_no_recourse'),cash_minor:amount,hard_charge_cap_minor:amount,
   resale_basis:z.literal('reconciled_net_owner_contributions_excluding_all_sales_and_earnings').optional(),resale_contributed_minor:amount.optional(),
   settled_orders:z.array(z.object({order_ref:numericRef,supplier_id:numericRef,cost_minor:amount}).strict()).max(200)}).strict(),
 z.object({...common,kind:z.literal('catalog'),basis:z.literal('complete_approved_supplier_catalog'),product_count:count,products:z.array(product).max(200)}).strict(),
 z.object({...common,kind:z.literal('day'),basis:z.literal('complete_utc_settled_after_discounts_including_shipping_before_refunds_ex_tax'),date:z.string().date(),
   catalog_ref:opaque,distinct_orders:count,products:z.array(metric).max(200)}).strict(),
]).refine(e=>{
 if(e.kind==='resale_week')return reconcilesResaleWeek(e);
 if(e.kind==='resale_owner_payout')return e.debit_ref!==e.credit_ref;
 if(e.kind==='cash')return (e.resale_basis!==undefined)===(e.resale_contributed_minor!==undefined)
   && new Set(e.settled_orders.map(x=>x.order_ref)).size===e.settled_orders.length;
 if(new Set(e.products.map(x=>x.product_id)).size!==e.products.length)return false;
 if(e.kind==='catalog'){
   const pod=e.products.flatMap(p=>p.printful_variant?[p.printful_variant]:[]);
   return e.product_count===e.products.length && new Set(e.products.map(p=>p.shopify_variant)).size===e.products.length && new Set(pod).size===pod.length;
 }
 return e.products.every(p=>p.orders<=e.distinct_orders) && e.distinct_orders<=e.products.reduce((s,p)=>s+p.orders,0);
});
type Event=z.infer<typeof evidence>;
export async function recordCommerceEvidence(signer:string,data:Event,fp:string,db:Parameters<typeof result>[0]=commerceSourceDb()){
 const packet=JSON.stringify(data);
 if(data.kind==='resale_week'){
   return result(db,Prisma.sql`SELECT sharkai_commerce.record_resale_week(${signer},${packet}::jsonb,${fp}) r`);
 }
 if(data.kind==='resale_owner_payout'){
   return result(db,Prisma.sql`SELECT sharkai_commerce.record_resale_owner_payout(${signer},${packet}::jsonb,${fp}) r`);
 }
 return result(db,Prisma.sql`SELECT sharkai_commerce.accept_evidence(${signer},${packet}::jsonb,${fp}) r`);
}
export async function receiveCommerceEvidence(req:Request,env:NodeJS.ProcessEnv=process.env,write=recordCommerceEvidence,now=Date.now) {
 const response=(status:string,code:number)=>Response.json({status},{status:code,headers:{'Cache-Control':'no-store'}});
 if(env.SHARKAI_COMMERCE_EVIDENCE_ENABLED!=='true')return response('unavailable',503);
 const actor=req.headers.get('x-shark-commerce-collector')??'',time=req.headers.get('x-shark-commerce-time')??'',sig=req.headers.get('x-shark-commerce-signature')??'';
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(actor)||!/^\d{10}$/.test(time)||!hash.safeParse(sig).success ||
    Math.abs(now()-Number(time)*1000)>30000)return response('forbidden',403);
 try{
  const raw=env.SHARKAI_COMMERCE_EVIDENCE_KEYS;if(!raw||raw.length>65536)return response('unavailable',503);
  const keys=z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),hash).parse(JSON.parse(raw));
  const values=Object.values(keys);
  if(!Object.hasOwn(keys,actor)||new Set(values).size!==values.length)return response('forbidden',403);
  for(const varName of ['SHARKAI_ORDER_PROFIT_KEYS','SHARKAI_ORDER_WORKER_KEYS','SHARKAI_ORDER_QUOTE_KEYS','SHARKAI_ORDER_SIGNAL_KEYS','SHARKAI_FEE_COLLECTOR_KEYS']){
    if(env[varName]&&Object.values(JSON.parse(env[varName]!)).some(v=>values.includes(String(v))))return response('unavailable',503);
  }
  if(req.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return response('invalid',415);
  const bytes=await boundedBytes(req,262144),expected=createHmac('sha256',Buffer.from(keys[actor],'hex')).update('sharkai-commerce/v1\n'+actor+'\n'+time+'\n').update(bytes).digest();
  if(!timingSafeEqual(expected,Buffer.from(sig,'hex'))||Math.abs(now()-Number(time)*1000)>30000)return response('forbidden',403);
  const data=evidence.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(!data.success)return response('invalid',400);
  if((data.data.kind==='resale_week' || data.data.kind==='resale_owner_payout') && Date.parse(data.data.observed_at)>now())return response('invalid',400);
  const answer=await write(actor,data.data,createHash('sha256').update(JSON.stringify(data.data)).digest('hex'));
  return answer==='recorded'||answer==='replayed'?response(answer,200):response('unverified',answer==='forbidden'?403:409);
 }catch{return response('unavailable',503);}
}
