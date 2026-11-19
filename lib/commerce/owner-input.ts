import {z} from 'zod';

export const shopCurrency=z.string().regex(/^[A-Z]{3}$/).refine(c=>Intl.supportedValuesOf('currency').includes(c));
export const supportedStoreCurrency=z.enum(['EUR','USD','GBP','BGN']);
export const capitalInput=z.object({
  currency:supportedStoreCurrency,amount_minor:z.string().regex(/^(?:0|[1-9]\d{0,11})$/),agent_read_allowed:z.boolean().optional(),
}).strict();
export const fulfillmentInput=z.discriminatedUnion('action',[
  z.object({order_ref:z.string().regex(/^[1-9]\d{0,19}$/),action:z.literal('review')}).strict(),
  z.object({order_ref:z.string().regex(/^[1-9]\d{0,19}$/),action:z.literal('confirm'),review_id:z.string().uuid()}).strict(),
]);
export function commerceRange(params:URLSearchParams,now=new Date()) {
  const today=now.toISOString().slice(0,10);
  const earliest=new Date(Date.parse(today+'T00:00:00Z')-29*86400000).toISOString().slice(0,10);
  const from=params.get('from')??earliest,to=params.get('to')??today,currency=params.get('currency')??'EUR';
  if(!z.string().date().safeParse(from).success || !z.string().date().safeParse(to).success || from>to || to>today
      || Date.parse(to)-Date.parse(from)>366*86400000 || !supportedStoreCurrency.safeParse(currency).success
      || ['from','to','currency'].some(k=>params.getAll(k).length>1)) return null;
  return {from,to,currency};
}
export async function readSmallShopBody(request:Request):Promise<unknown> {
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json') return null;
  const reader=request.body?.getReader();
  if(!reader) return null;
  let size=0,expired=false;
  const parts:Uint8Array[]=[];
  const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},1500);
  try {
    for(;;) {
      const chunk=await reader.read();
      if(chunk.done) break;
      size+=chunk.value.byteLength;
      if(size>2048) {await reader.cancel();return null;}
      parts.push(chunk.value);
    }
    return expired?null:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
  }catch {return null;}finally{clearTimeout(timer);reader.releaseLock();}
}
