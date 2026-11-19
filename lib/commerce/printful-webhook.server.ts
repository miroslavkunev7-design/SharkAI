import {createHmac,timingSafeEqual} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {boundedBytes} from './providers.server';
import {commerceSourceDb,result} from './commerce.server';

const id=z.number().int().positive().safe().transform(String);
const settings=z.record(z.string().regex(/^[A-Za-z0-9+/=_-]{12,512}$/),z.object({shop:z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/),
  secret:z.string().regex(/^(?:[A-Fa-f0-9]{2}){16,128}$/)}).strict());
const event=z.object({type:z.enum(['order_updated','order_failed','order_canceled','order_put_hold','order_remove_hold','order_refunded','shipment_sent']),
  occurred_at:z.string().datetime({offset:true}),store_id:id,data:z.object({order:z.object({id,external_id:z.string().min(1).max(80),store_id:id,status:z.string().max(30)})})});
async function observe(shop:string,data:z.infer<typeof event>){
  const o=data.data.order;
  return result(commerceSourceDb(),Prisma.sql`SELECT sharkai_commerce.supplier_observation(${shop},${o.store_id},${o.id},${o.external_id},${o.status},${data.occurred_at}::timestamptz) r`);
}
export async function receivePrintful(request:Request,env:NodeJS.ProcessEnv=process.env,write=observe){
 const reply=(status:string,code:number)=>Response.json({status},{status:code,headers:{'cache-control':'no-store'}});
 if(env.SHARKAI_COMMERCE_EVIDENCE_ENABLED!=='true')return reply('unavailable',503);
 const pub=request.headers.get('x-pf-webhook-public-key')??'',sig=request.headers.get('x-pf-webhook-signature')??'';
 if(!/^[a-f0-9]{64}$/i.test(sig))return reply('forbidden',403);
 try{
   const raw=env.SHARKAI_PRINTFUL_WEBHOOK_KEYS;
   if(!raw||raw.length>65536)return reply('unavailable',503);
   const keys=settings.parse(JSON.parse(raw));
   if(!Object.hasOwn(keys,pub)||new Set(Object.values(keys).map(k=>k.secret.toLowerCase())).size!==Object.keys(keys).length)return reply('forbidden',403);
   const b=await boundedBytes(request,131072);
   if(!timingSafeEqual(createHmac('sha256',Buffer.from(keys[pub].secret,'hex')).update(b).digest(),Buffer.from(sig,'hex')))return reply('forbidden',403);
   const data=event.safeParse(JSON.parse(b.toString('utf8')));
   if(!data.success||data.data.store_id!==data.data.data.order.store_id)return reply('invalid',400);
   const response=await write(keys[pub].shop,data.data);
   return response==='recorded'||response==='replayed'||response==='unmatched'?reply(String(response),200):reply('unverified',409);
 }catch{return reply('unavailable',503);}
}
