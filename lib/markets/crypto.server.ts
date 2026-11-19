import {z} from 'zod';
import {cryptoRanges, displayCryptoCode, type CryptoCatalog, type CryptoChart, type CryptoRange, type CryptoRow, type MarketPair, type MarketQuote, type MarketCandle} from './crypto';

const endpoint='https://api.kraken.com/0/public/';
const safePair=/^[A-Za-z0-9_.-]{2,40}$/;
const fiat=new Set(Intl.supportedValuesOf('currency'));
const names:Record<string,string>={BTC:'Bitcoin',ETH:'Ethereum',DOGE:'Dogecoin',SOL:'Solana',XRP:'XRP',ADA:'Cardano',LTC:'Litecoin',USDT:'Tether',USDC:'USD Coin'};
const registry=z.record(z.string(),z.unknown());
const envelope=z.object({error:z.array(z.string()),result:registry});
const providerPair=z.object({wsname:z.string(),aclass_base:z.literal('currency'),aclass_quote:z.literal('currency'),status:z.string()});
const decimal=z.string().regex(/^(?:0|[1-9]\d{0,20})(?:\.\d{1,18})?$/);
const ticker=z.object({c:z.array(decimal).min(1),v:z.tuple([decimal,decimal]),t:z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative()]),o:decimal});
const candle=z.tuple([z.number().int().nonnegative(),decimal,decimal,decimal,decimal,decimal,decimal,z.number().int().nonnegative()]);

async function request(resource:string) {
  const response=await fetch(endpoint+resource,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8500),headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('Kraken unavailable');
  const data=envelope.parse(await response.json());
  if(data.error.length)throw Error('Kraken data unavailable');
  const retrieved=Date.now(), header=Date.parse(response.headers.get('date')??'');
  const age=Number(response.headers.get('age')??0);
  const reported=Math.min(Number.isFinite(header)?header:retrieved,retrieved-(Number.isFinite(age)&&age>0?age*1000:0));
  return {data:data.result,retrieved,reported};
}
type Payload=Awaited<ReturnType<typeof request>>;
type Cached={until:number;result:Promise<Payload>};
const cache=new Map<string,Cached>();
const recentChartRequests:number[]=[];
let pendingCharts=0;
function cached(resource:string,ttl:number) {
  const now=Date.now(),hit=cache.get(resource);
  if(hit && hit.until>now)return hit.result;
  for(const [key,item] of cache)if(item.until<=now)cache.delete(key);
  const chartRequest=resource.startsWith('OHLC?');
  if(chartRequest){
    while(recentChartRequests.length && recentChartRequests[0]<=now-60000)recentChartRequests.shift();
    if(recentChartRequests.length>=30 || pendingCharts>=4)throw Error('Kraken chart request budget reached');
    recentChartRequests.push(now);
    pendingCharts++;
  }
  const entry={until:now+ttl,result:request(resource).finally(()=>{if(chartRequest)pendingCharts--;})};
  cache.set(resource,entry);
  void entry.result.catch(()=>{if(cache.get(resource)===entry)entry.until=Date.now()+7000;});
  return entry.result;
}
function records(raw:Record<string,unknown>) {
  const pairs:MarketPair[]=[];
  for(const [id,info] of Object.entries(raw)){
    const p=providerPair.safeParse(info);
    if(!p.success || !safePair.test(id))continue;
    const parts=p.data.wsname.split('/');
    if(parts.length!==2 || !parts.every(s=>/^[A-Z0-9.-]{1,16}$/i.test(s)))continue;
    const [base,quote]=parts.map(displayCryptoCode);
    if(fiat.has(base)&&fiat.has(quote))continue;
    pairs.push({id,base,quote,name:names[base]??base,market_status:p.data.status});
  }
  if(!pairs.length)throw Error('Kraken catalog empty');
  return pairs;
}
function quote(value:unknown):MarketQuote|null {
  const t=ticker.safeParse(value);
  if(!t.success || Number(t.data.c[0])<=0)return null;
  const first=Number(t.data.o),last=Number(t.data.c[0]);
  return {price:t.data.c[0],volume_24h:t.data.v[1],trades_24h:t.data.t[1],day_change_pct:first>0?(last-first)*100/first:null};
}
async function quotes() {
  try{
    const snapshot=await cached('Ticker',30000);
    return Date.now()-snapshot.reported<=180000?snapshot:null;
  }catch{return null;}
}
const pageSize=20;
export async function readCryptoCatalog(query:string,page:number):Promise<CryptoCatalog> {
  const [catalog,stats]=await Promise.all([cached('AssetPairs',3600000),quotes()]);
  const pairs=records(catalog.data),needle=query.trim().toUpperCase().replace(/\s/g,'');
  const rows:CryptoRow[]=pairs.filter(p=>[p.name,p.id,p.base+'/'+p.quote,p.base+p.quote].some(s=>s.toUpperCase().replace(/\s/g,'').includes(needle)))
    .map(p=>({...p,ticker:stats?quote(stats.data[p.id]):null}));
  rows.sort((a,b)=>(b.ticker?.trades_24h??-1)-(a.ticker?.trades_24h??-1)||a.id.localeCompare(b.id));
  const pages=Math.ceil(rows.length/pageSize),actual=Math.min(page,Math.max(1,pages));
  return {source:'Kraken Spot',status:'available',checked_at:stats?new Date(stats.reported).toISOString():null,
    total:pairs.length,matched:rows.length,page:actual,pages,rows:rows.slice((actual-1)*pageSize,actual*pageSize)};
}
export async function readCryptoChart(id:string,range:CryptoRange):Promise<CryptoChart|null>{
  if(!safePair.test(id))return null;
  const catalog=await cached('AssetPairs',3600000);
  const pair=records(catalog.data).find(p=>p.id===id);
  if(!pair)return null;
  const {minutes,days}=cryptoRanges[range],step=minutes*60;
  const [history,stats]=await Promise.all([cached('OHLC?pair='+encodeURIComponent(id)+'&interval='+minutes,45000),quotes()]);
  if(Date.now()-history.reported>180000)throw Error('Stale Kraken candles response');
  const raw=history.data[id];
  if(!Array.isArray(raw) || raw.length>721)throw Error('Kraken history unavailable');
  const now=Math.floor(Date.now()/1000),from=now-days*86400,candles:MarketCandle[]=[];
  // Kraken always includes the still-forming interval as its last row.
  for(const candidate of raw.slice(0,-1)){
    const a=candle.parse(candidate),[start,,highRaw,lowRaw,closeRaw,,volumeRaw,trades]=a;
    if(start<from || start+step>now || !trades)continue;
    const high=Number(highRaw),low=Number(lowRaw),close=Number(closeRaw),volume=Number(volumeRaw);
    if(low<=0 || close<low || close>high || volume<=0 || (candles.length&&candles[candles.length-1].start>=start))throw Error('Invalid Kraken candle');
    candles.push({start,high,low,close,volume,trades});
  }
  return {status:'available',source:'Kraken Spot',pair,range,checked_at:new Date(history.reported).toISOString(),
    ticker_at:stats?new Date(stats.reported).toISOString():null,ticker:stats?quote(stats.data[id]):null,interval_minutes:minutes,candles};
}
