import {createHash,randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {prisma} from '../db';
import {result} from './commerce.server';
import {boundedBytes,currencies,digest,numericRef} from './providers.server';
type Db=Pick<Prisma.TransactionClient,'$queryRaw'>;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const fixed=z.object({store:z.string().uuid(),shop:z.string(),currency:currencies,supplier:z.string().uuid(),region:z.enum(['eu','us']),org:numericRef,vendor:numericRef,
  warehouse:numericRef,contract:hash,item:numericRef,product:z.string(),po:numericRef,units:z.number().int().positive(),cap:numericRef,quote:hash,vendor_email_hash:hash});
type Binding=z.infer<typeof fixed>;
const ua=z.union([numericRef,z.number().int().positive().safe().transform(String)]);
const count=z.number().int().min(0).max(1000000);
const token=z.string().min(16).max(4096);
const config=z.object({region:z.enum(['us','eu']),org:numericRef,vendor_email:z.string().email(),access_token:token.optional(),refresh_token:token.optional(),
  client_id:token.optional(),client_secret:token.optional()}).strict();
async function api(send:typeof fetch,url:string,opts:RequestInit) {
  const r=await send(url,{...opts,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(6000)});
  if(!r.ok)throw Error('Provider unavailable');
  return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await boundedBytes(r,524288)));
}
async function credential(b:Binding,env:NodeJS.ProcessEnv,send:typeof fetch) {
  const raw=env.SHARKAI_COMMERCE_ZOHO_CREDENTIALS;if(!raw||raw.length>65536)throw Error('Supplier unavailable');
  const settings=z.record(z.string().uuid(),config).parse(JSON.parse(raw));
  const own=settings[b.supplier],domain=b.region==='us'?'com':'eu',origin='https://www.zohoapis.'+domain;
  if(!own||own.region!==b.region||own.org!==b.org||createHash('sha256').update(own.vendor_email.toLowerCase()).digest('hex')!==b.vendor_email_hash)throw Error('Supplier identity unavailable');
  let access=own.access_token;
  if(!access){
    if(!own.client_id||!own.client_secret||!own.refresh_token)throw Error('Supplier unavailable');
    const auth=await api(send,'https://accounts.zoho.'+domain+'/oauth/v2/token',{method:'POST',body:new URLSearchParams({
      client_id:own.client_id,client_secret:own.client_secret,refresh_token:own.refresh_token,grant_type:'refresh_token'})});
    if(auth.api_domain && auth.api_domain!==origin)throw Error('Provider region differs');
    access=token.parse(auth.access_token);
  }
  return {origin,email:own.vendor_email,headers:{Authorization:'Zoho-oauthtoken '+access,'Content-Type':'application/json'}};
}
const po=z.object({purchaseorder_id:ua,purchaseorder_number:z.string().min(1).max(65),status:z.string(),vendor_id:ua,currency_code:currencies,
  location_id:ua,is_emailed:z.boolean(),is_drop_shipment:z.boolean().optional(),salesorder_id:z.union([z.string(),z.number(),z.null()]).optional(),
  total:z.union([z.number().nonnegative(),z.string()]),line_items:z.array(z.object({item_id:ua,quantity:count,location_id:ua.optional()})).length(1),
  contact_persons_associated:z.array(z.object({contact_person_email:z.string().email()})).max(100)});
const toMinor=(value:number|string)=>{
 const m=/^(0|[1-9][0-9]{0,10})(?:\.([0-9]{1,2})0*)?$/.exec(String(value));
 if(!m)throw Error('Unsupported price precision');
 return BigInt(m[1])*BigInt(100)+BigInt((m[2]??'').padEnd(2,'0'));
};
const base=(org:string)=>'?organization_id='+org;
async function inspect(b:Binding,k:Awaited<ReturnType<typeof credential>>,send:typeof fetch) {
 const path='/purchaseorders/'+b.po+base(b.org);
 const [warehouse,books]=await Promise.all(['/inventory/v1','/books/v3'].map(prefix=>api(send,k.origin+prefix+path,{headers:k.headers})));
 const packets=[warehouse,books].map(x=>{if(x.code!==0)throw Error('Unverified PO');return po.parse(x.purchaseorder??x.purchase_order);});
 const verify=(x:z.infer<typeof po>)=>x.purchaseorder_id===b.po && x.status.toLowerCase()==='draft' && x.vendor_id===b.vendor && x.currency_code===b.currency
   && x.location_id===b.warehouse && x.line_items[0].item_id===b.item && x.line_items[0].quantity===b.units && !x.is_emailed
   && (!x.line_items[0].location_id||x.line_items[0].location_id===b.warehouse) && !x.salesorder_id
   && !x.is_drop_shipment && x.contact_persons_associated.some(c=>c.contact_person_email.toLowerCase()===k.email.toLowerCase());
 if(!packets.every(verify)||packets[0].is_drop_shipment!==false || packets[0].purchaseorder_number!==packets[1].purchaseorder_number
   || toMinor(packets[0].total)!==toMinor(packets[1].total) || toMinor(packets[0].total)<=BigInt(0)||toMinor(packets[0].total)>BigInt(b.cap))throw Error('Unapproved PO');
 return digest([b,k.email.toLowerCase(),packets[0].purchaseorder_number,String(toMinor(packets[0].total))]);
}
export async function readPurchaseBinding(db:Db,userId:string|null,offerId:string,receipt=false) {
 return fixed.parse(await result(db,Prisma.sql`SELECT sharkai_commerce.procurement_binding(${userId}::text,${offerId}::uuid,${receipt}) r`));
}
const projection=z.object({status:z.enum(['available','unavailable']),mandates:z.array(z.object({mandate_id:z.string().uuid(),product_id:z.string(),supplier_name:z.string(),currency:currencies,
  max_per_po_minor:numericRef,total_minor:numericRef,expires_at:z.string()})),items:z.array(z.object({offer_id:z.string().uuid(),product_name:z.string(),supplier_name:z.string(),
  units:count,currency:currencies,max_cost_minor:numericRef,state:z.enum(['offered','reviewed','submitting','issued','uncertain','received']),received_units:count,
  sold_units:count.nullable(),stock_units:count.nullable(),realized_margin_minor:z.string().regex(/^-?\d+$/).nullable()})).max(100)});
export async function readProcurement(userId:string,db:Db=prisma) {return projection.parse(await result(db,Prisma.sql`SELECT sharkai_commerce.stock_dashboard(${userId}) r`));}
const action=z.discriminatedUnion('action',[z.object({action:z.literal('review'),offer_id:z.string().uuid()}).strict(),z.object({action:z.literal('confirm'),offer_id:z.string().uuid(),review_id:z.string().uuid()}).strict(),
 z.object({action:z.literal('enable_automation'),offer_id:z.string().uuid(),accepted:z.literal(true),max_per_po_minor:z.string().regex(/^[1-9][0-9]{0,11}$/),total_minor:z.string().regex(/^[1-9][0-9]{0,11}$/),expires_at:z.string().datetime({offset:true})}).strict(),
 z.object({action:z.literal('disable_automation'),mandate_id:z.string().uuid()}).strict()]);
const returned=z.union([z.object({status:z.literal('reviewed'),review_id:z.string().uuid(),currency:currencies,max_cost_minor:numericRef,expires_at:z.string()}),z.object({status:z.enum(['blocked','claimed'])})]);
export async function submitProcurement(userId:string,body:unknown,db:Db=prisma,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch) {
 const parsed=action.safeParse(body);if(!parsed.success)return {status:'invalid'} as const;
 const p=parsed.data;
 if(p.action==='disable_automation') {
   const revoked=await result(db,Prisma.sql`SELECT sharkai_commerce.set_stock_mandate(${userId},NULL,${p.mandate_id}::uuid,NULL,NULL,NULL) r`);
   return {status:revoked===true?'revoked':'blocked'} as const;
 }
 if(env.SHARKAI_COMMERCE_PROCUREMENT_ENABLED!=='true')return {status:'blocked'} as const;
 if(p.action==='enable_automation'){
   const id=randomUUID();
   const enabled=await result(db,Prisma.sql`SELECT sharkai_commerce.set_stock_mandate(${userId},${p.offer_id}::uuid,${id}::uuid,${p.max_per_po_minor}::bigint,${p.total_minor}::bigint,${p.expires_at}::timestamptz) r`);
   return {status:enabled===true?'enabled':'blocked'} as const;
 }
 return issuePurchase(userId,p.offer_id,p.action==='review'?randomUUID():p.review_id,p.action,null,db,env,send);
}
async function issuePurchase(userId:string,offer:string,review:string,operation:'review'|'confirm'|'auto',mandate:string|null,db:Db,env:NodeJS.ProcessEnv,send:typeof fetch) {
 try{
  const b=await readPurchaseBinding(db,userId,offer),k=await credential(b,env,send),fingerprint=await inspect(b,k,send);
  const guard=returned.parse(await result(db,operation==='auto'
    ?Prisma.sql`SELECT sharkai_commerce.stock_automatic(${userId},${offer}::uuid,${review}::uuid,${mandate}::uuid,${fingerprint}) r`
    :Prisma.sql`SELECT sharkai_commerce.stock_authorize(${userId},${offer}::uuid,${review}::uuid,${operation},${fingerprint}) r`));
  if(guard.status!=='claimed')return guard;
  let ok=false;
  try{
   const res=await api(send,k.origin+'/books/v3/purchaseorders/'+b.po+'/email'+base(b.org)+'&send_attachment=true',{method:'POST',headers:k.headers,
     body:JSON.stringify({to_mail_ids:[k.email],send_from_org_email_id:true,subject:'Purchase order '+b.po,body:'Please process the attached purchase order under our existing supply agreement.'})});
   ok=res.code===0;
  }catch{ok=false;}
  try{const written=await result(db,Prisma.sql`SELECT sharkai_commerce.stock_finish(${userId},${offer}::uuid,${review}::uuid,${ok}) r`);
   return {status:ok&&written===true?'issued':'uncertain'} as const;
  }catch{return {status:'uncertain'} as const;}
 }catch{return {status:'unavailable'} as const;}
}
export async function runApprovedProcurement(db:Db=prisma,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch) {
 if(env.SHARKAI_COMMERCE_PROCUREMENT_ENABLED!=='true')return {status:'disabled',processed:0};
 const due=z.array(z.object({user_id:z.string(),offer_id:z.string().uuid(),mandate_id:z.string().uuid()})).max(3)
  .parse(await result(db,Prisma.sql`SELECT sharkai_commerce.stock_due() r`));
 const statuses=[];
 for(const row of due)statuses.push((await issuePurchase(row.user_id,row.offer_id,randomUUID(),'auto',row.mandate_id,db,env,send)).status);
 return {status:statuses.includes('uncertain')?'needs_reconciliation':'checked',processed:statuses.length};
}
export async function verifyWarehouseReceipt(b:Binding,receipt:string,units:number,env:NodeJS.ProcessEnv,send:typeof fetch){
 const k=await credential(b,env,send),r=await api(send,k.origin+'/inventory/v1/purchasereceives/'+numericRef.parse(receipt)+base(b.org),{headers:k.headers});
 const receive=z.object({purchasereceive_id:ua,purchaseorder_id:ua,vendor_id:ua,location_id:ua,status:z.string(),is_salesreturn:z.boolean().optional(),
  line_items:z.array(z.object({item_id:ua,quantity:count,location_id:ua.optional()})).length(1)}).parse(r.purchasereceive??r.purchase_receive);
 return r.code===0 && receive.purchasereceive_id===receipt && receive.purchaseorder_id===b.po && receive.vendor_id===b.vendor && receive.location_id===b.warehouse
  && receive.status.toLowerCase()==='received' && !receive.is_salesreturn && receive.line_items[0].item_id===b.item && receive.line_items[0].quantity===units
  && (!receive.line_items[0].location_id||receive.line_items[0].location_id===b.warehouse);
}
