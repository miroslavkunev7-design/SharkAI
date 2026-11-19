import {createHash,timingSafeEqual,createHmac} from 'node:crypto';
import {z} from 'zod';

const domain=z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/);
export const numericRef=z.string().regex(/^[1-9][0-9]{0,19}$/);
export const currencies=z.enum(['USD','EUR','GBP','BGN']);
export const storeContract=z.object({id:z.string().uuid(),shop:domain,printful_store:numericRef.nullable(),external_ref_prefix:z.enum(['','shopify-']),currency:currencies,hard_cap:numericRef,contract:z.string().regex(/^[a-f0-9]{64}$/)});
export type Store=z.infer<typeof storeContract>;
const secret=z.string().min(16).max(4096);
const keys=z.object({shop:domain,store:numericRef.nullable().optional(),shopify_secret:secret,shopify_access_token:secret,printful_access_token:secret.optional()}).strict();
export function commerceCredentials(store:Store,env:NodeJS.ProcessEnv=process.env) {
  const config=env.SHARKAI_COMMERCE_STORES;
  if (!config || config.length>65536) throw Error('Store unavailable');
  const list=z.array(keys).max(32).parse(JSON.parse(config));
  const own=list.filter(s=>s.shop===store.shop && (s.store??null)===store.printful_store);
  const access=list.flatMap(s=>s.printful_access_token?[s.shopify_access_token,s.printful_access_token]:[s.shopify_access_token]);
  if(own.length!==1 || new Set(access).size!==access.length || list.some(s=>access.includes(s.shopify_secret))) throw Error('Store unavailable');
  return own[0];
}
type Credentials=z.infer<typeof keys>;
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function authenticShopify(raw:Buffer,signature:string|null,key:string) {
  if(!signature||!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature,'base64'),createHmac('sha256',key).update(raw).digest());
}
export async function boundedBytes(message:Request|Response,max:number,timeout=4000) {
  const reader=message.body?.getReader();if(!reader)throw Error('Missing data');
  let count=0,expired=false;const parts:Uint8Array[]=[];
  const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},timeout);
  try{for(;;){const next=await reader.read();if(expired)throw Error('Timeout');if(next.done)break;count+=next.value.length;
    if(count>max){await reader.cancel();throw Error('Too large');}parts.push(next.value);}return Buffer.concat(parts);}
  finally{clearTimeout(timer);reader.releaseLock();}
}
async function readProvider(send:typeof fetch,url:string,opts:RequestInit) {
  const resp=await send(url,{...opts,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(6000)});
  if(!resp.ok)throw Error('Provider unavailable');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(resp,524288)));
}
const numberId=z.number().int().positive().safe().transform(String);
const quantity=z.number().int().min(0).max(100000);
const price=z.string().regex(/^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,2}0*)?$/);
const money=z.object({shopMoney:z.object({amount:price,currencyCode:currencies})});
const minor=(v:string)=>{const [units,decimal='']=price.parse(v).split('.');return (BigInt(units)*BigInt(100)+BigInt(decimal.padEnd(2,'0').slice(0,2))).toString();};
const addressValue=z.string().max(250).nullable().optional();
const shopAddress=z.object({name:addressValue,company:addressValue,address1:addressValue,address2:addressValue,city:addressValue,provinceCode:addressValue,countryCodeV2:addressValue,zip:addressValue});
const supplierAddress=z.object({name:addressValue,company:addressValue,address1:addressValue,address2:addressValue,city:addressValue,state_code:addressValue,country_code:addressValue,zip:addressValue});
const norm=(v:string|null|undefined)=>(v??'').normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
const address=(parts:(string|null|undefined)[])=>parts[0] && parts[2] && parts[4] && parts[6] ? parts.map(norm) : null;
const order=z.object({id:z.string(),test:z.boolean(),createdAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true}),
  cancelledAt:z.string().nullable(),displayFinancialStatus:z.string(),displayFulfillmentStatus:z.string(),totalPriceSet:money,totalRefundedSet:money,
  shippingAddress:shopAddress.nullable(),lineItems:z.object({pageInfo:z.object({hasNextPage:z.boolean()}),nodes:z.array(z.object({
    currentQuantity:quantity,requiresShipping:z.boolean(),variant:z.object({id:z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]{0,19}$/)}).nullable()})).max(100)})});
const gql=`query SharkOrder($id: ID!) {order(id:$id){id test createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus
  totalPriceSet{shopMoney{amount currencyCode}} totalRefundedSet{shopMoney{amount currencyCode}}
  shippingAddress{name company address1 address2 city provinceCode countryCodeV2 zip} lineItems(first:100){pageInfo{hasNextPage} nodes{currentQuantity requiresShipping variant{id}}}}}`;
export async function readShopifyOrder(store:Store,ref:string,credentials:Credentials,send:typeof fetch=fetch) {
  numericRef.parse(ref);const id='gid://shopify/Order/'+ref;
  const raw=await readProvider(send,'https://'+domain.parse(store.shop)+'/admin/api/2026-04/graphql.json',{method:'POST',
    headers:{'Content-Type':'application/json','X-Shopify-Access-Token':credentials.shopify_access_token},body:JSON.stringify({query:gql,variables:{id}})});
  if(raw.errors?.length) throw Error('Unverified Shopify response');
  const o=order.parse(raw.data?.order);
  if(o.id!==id || o.test || [o.totalPriceSet,o.totalRefundedSet].some(v=>v.shopMoney.currencyCode!==store.currency))throw Error('Unverified Shopify order');
  const status=o.cancelledAt?'cancelled':({PAID:'paid',PARTIALLY_REFUNDED:'partial_refund',REFUNDED:'refunded'}[o.displayFinancialStatus]??'pending');
  const addr=o.shippingAddress;const recipient=addr?address([addr.name,addr.company,addr.address1,addr.address2,addr.city,addr.provinceCode,addr.countryCodeV2,addr.zip]):null;
  const items=o.lineItems.nodes.filter(i=>i.currentQuantity>0).map(i=>({variant:i.variant?.id.split('/').pop()??'',units:i.currentQuantity,physical:i.requiresShipping}));
  const source={order_ref:ref,status,currency:store.currency,total_minor:minor(o.totalPriceSet.shopMoney.amount),refunded_minor:minor(o.totalRefundedSet.shopMoney.amount),ordered_at:o.createdAt,updated_at:o.updatedAt};
  const fingerprint=createHmac('sha256',credentials.shopify_secret).update(JSON.stringify([source,recipient,items,o.displayFulfillmentStatus,o.lineItems.pageInfo.hasNextPage])).digest('hex');
  return {source:{...source,digest:fingerprint},recipient,items,eligible:status==='paid' && source.refunded_minor==='0' && !!recipient &&
      o.displayFulfillmentStatus==='UNFULFILLED' && !o.lineItems.pageInfo.hasNextPage && items.length>0 && items.every(i=>i.physical&&i.variant)};
}
const supplierOrder=z.object({id:numberId,store:numberId,external_id:z.string(),status:z.string(),recipient:supplierAddress,
  items:z.array(z.object({sync_variant_id:numberId,quantity:quantity})).min(1).max(100),costs:z.object({currency:currencies,total:price})});
const mapping=z.array(z.object({shopify_variant:numericRef,printful_variant:numericRef.nullable().optional(),inventory_units:quantity})).max(250);
type ShopifyOrder=Awaited<ReturnType<typeof readShopifyOrder>>;
const sorted=(m:Map<string,number>)=>[...m].sort(([x],[y])=>x.localeCompare(y));
function printfulHeaders(store:Store,k:Credentials){
  if(!store.printful_store||!k.printful_access_token)throw Error('Printful unavailable');
  return {Authorization:'Bearer '+k.printful_access_token,'X-PF-Store-Id':store.printful_store};
}
export async function readPrintfulDraft(store:Store,shopify:ShopifyOrder,mappings:unknown,k:Credentials,send:typeof fetch=fetch) {
  if(!shopify.eligible)throw Error('Order not eligible');
  const variants=mapping.parse(mappings);
  const expected=new Map<string,number>(),actual=new Map<string,number>();
  for(const i of shopify.items) {
    const v=variants.find(p=>p.shopify_variant===i.variant);
    if(!v?.printful_variant)throw Error('Variant unavailable');
    const qty=(expected.get(v.printful_variant)??0)+i.units;
    if(qty>v.inventory_units)throw Error('Quantity unavailable');expected.set(v.printful_variant,qty);
  }
  const external=store.external_ref_prefix+shopify.source.order_ref;
  const raw=await readProvider(send,'https://api.printful.com/orders/@'+external,{headers:printfulHeaders(store,k)});
  const draft=supplierOrder.parse(raw.result);
  const r=draft.recipient, recipient=address([r.name,r.company,r.address1,r.address2,r.city,r.state_code,r.country_code,r.zip]);
  for(const item of draft.items) actual.set(item.sync_variant_id,(actual.get(item.sync_variant_id)??0)+item.quantity);
  const cost=minor(draft.costs.total);
  if(raw.code!==200 || draft.status!=='draft' || draft.store!==store.printful_store || draft.external_id!==external ||
    draft.costs.currency!==store.currency || BigInt(cost)<=BigInt(0) || BigInt(cost)>BigInt(store.hard_cap) || !recipient ||
    digest(sorted(expected))!==digest(sorted(actual)) || digest(recipient)!==digest(shopify.recipient))throw Error('Draft mismatch');
  return {supplier:draft.id,cost,fingerprint:digest([store.id,store.contract,shopify.source.digest,draft.id,cost,store.hard_cap,sorted(actual),recipient])};
}
export async function confirmPrintful(store:Store,ref:string,id:string,credentials:Credentials,send:typeof fetch=fetch) {
  const raw=await readProvider(send,'https://api.printful.com/orders/'+numericRef.parse(id)+'/confirm',{method:'POST',headers:printfulHeaders(store,credentials)});
  const accepted=supplierOrder.parse(raw.result);
  return raw.code===200 && accepted.id===id && accepted.store===store.printful_store && accepted.external_id===store.external_ref_prefix+ref
    && ['pending','inprocess','fulfilled','inreview'].includes(accepted.status) && accepted.costs.currency===store.currency && BigInt(minor(accepted.costs.total))<=BigInt(store.hard_cap);
}
