import {z} from 'zod';
import {boundedBytes} from '../commerce/providers.server';
import {equityListings, type EquityCatalog, type EquityListing, type EquitySeries} from './equities';

const maxRows = 100;
const dayMs = 86_400_000;
const data = z.object({
  status:z.literal('ok'),
  meta:z.object({
    symbol:z.string(), mic_code:z.string(), currency:z.string(), exchange_timezone:z.string(), interval:z.literal('1day'),
  }),
  values:z.array(z.object({
    datetime:z.string().date(),
    close:z.string().regex(/^\d{1,12}(\.\d{1,11})?$/).transform(Number).refine(n=>n>0),
  })).min(1).max(maxRows),
});

function localDay(date:Date, timeZone:string) {
  return new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone}).format(date);
}

export function equityCloses(packet:unknown, listing:EquityListing, now:Date):EquitySeries {
  const {meta,values} = data.parse(packet);
  if (meta.symbol!==listing.symbol || meta.mic_code!==listing.mic || meta.currency!==listing.currency || meta.exchange_timezone!==listing.zone) {
    throw Error('Unexpected equity listing');
  }
  const today = localDay(now,listing.zone);
  const days = new Set<string>();
  const points = [];
  for (const row of values) {
    if (days.has(row.datetime) || row.datetime>today) throw Error('Invalid exchange date');
    days.add(row.datetime);
    // A current local session can still be trading. Publish only earlier completed days.
    if (row.datetime<today) points.push({day:row.datetime,close:row.close});
  }
  points.sort((a,b)=>a.day.localeCompare(b.day));
  const latest = points.at(-1);
  if (!latest) throw Error('No completed sessions');
  const ageDays = (Date.parse(today)-Date.parse(latest.day))/dayMs;
  return {state:ageDays>7?'historical':'available',checkedAt:now.toISOString(),points};
}

export async function fetchEquityCloses(listing:EquityListing, key:string, send=fetch, now=new Date()):Promise<EquitySeries> {
  const params = new URLSearchParams({
    symbol:listing.symbol, mic_code:listing.mic, interval:'1day', outputsize:String(maxRows), adjust:'none',
  });
  const response = await send('https://api.twelvedata.com/time_series?'+params,{
    method:'GET',headers:{Accept:'application/json',Authorization:'apikey '+key},
    signal:AbortSignal.timeout(6000),redirect:'error',cache:'no-store',
  });
  if (!response.ok) { await response.body?.cancel(); throw Error('Market feed unavailable'); }
  const body = await boundedBytes(response,96*1024);
  return equityCloses(JSON.parse(body.toString('utf8')),listing,now);
}

// One in-flight read per supported listing, shared by lists, charts and simultaneous visitors.
const cache = new Map<string,{expires:number; value:Promise<EquitySeries>}>();
function cachedCloses(listing:EquityListing, key:string) {
  const now=Date.now(), hit=cache.get(listing.symbol);
  if (hit && hit.expires>now) return hit.value;
  const entry={expires:now+15*60_000,value:fetchEquityCloses(listing,key).catch(():EquitySeries=>{
    entry.expires=Date.now()+60_000;
    return {state:'unavailable'};
  })};
  cache.set(listing.symbol,entry);
  return entry.value;
}

export async function equityCatalog(env:NodeJS.ProcessEnv=process.env, read=cachedCloses):Promise<EquityCatalog> {
  const key=env.TWELVE_DATA_API_KEY?.trim();
  const licensed = new Set((env.TWELVE_DATA_PUBLIC_EQUITY_LISTINGS??'').split(',').map(value=>value.trim()));
  const pairs=await Promise.all(equityListings.map(async listing=>{
    const approved=key && key.toLowerCase()!=='demo' && licensed.has(listing.mic+':'+listing.symbol);
    const value:EquitySeries=approved?await read(listing,key):{state:'unlicensed'};
    return [listing.symbol,value] as const;
  }));
  return {status:'available',attribution:'Data provided by Twelve Data',series:Object.fromEntries(pairs)};
}
