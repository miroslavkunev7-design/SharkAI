import {parse} from 'csv-parse/sync';

const series='EST.B.EU000A2QQF08.CI';
export const referenceSource='https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_short-term_rate/html/eurostr_overview.en.html';
const dataUrl='https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF08.CI?format=csvdata&lastNObservations=520';
const days={day:1,week_1:7,week_2:14,week_3:21,week_4:28} as const;
type Period=keyof typeof days|'month';
export function isReferencePeriod(value:string):value is Period {return value==='month'||Object.hasOwn(days,value);}
const dayMs=86400000;
const iso=(date:Date)=>date.toISOString().slice(0,10);

function endDate(start:string,period:Period) {
  const d=new Date(start+'T00:00:00Z');
  if(period!=='month') return iso(new Date(d.valueOf()+days[period]*dayMs));
  const day=d.getUTCDate();
  d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);
  const lastDay=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,lastDay));
  return iso(d);
}
function microPercent(start:bigint,end:bigint) {
  const numerator=(end-start)*BigInt(100000000);
  return (numerator+(numerator<BigInt(0)?-start/BigInt(2):start/BigInt(2)))/start;
}

export function euroReferenceRange(csv:string,period:Period,now=new Date()) {
  const records:Record<string,string>[]=parse(csv,{columns:true,bom:true,skip_empty_lines:true,max_record_size:4096});
  if(!records.length || records.length>520) throw Error('Unexpected ECB series length');
  const observations=new Map<string,bigint>();
  const today=iso(now);
  for(const row of records) {
    const date=row.TIME_PERIOD, value=row.OBS_VALUE;
    if(row.KEY!==series || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date>today || observations.has(date) ||
       !Number.isFinite(Date.parse(date+'T00:00:00Z')) || iso(new Date(date+'T00:00:00Z'))!==date) throw Error('Unexpected ECB observation');
    if(row.OBS_STATUS!=='A') continue;
    if(!/^\d{1,5}(?:\.\d{1,8})?$/.test(value)) throw Error('Invalid index');
    const [whole,fraction='']=value.split('.');
    const index=BigInt(whole+fraction.padEnd(8,'0'));
    if(index<=BigInt(0)) throw Error('Invalid index');
    observations.set(date,index);
  }
  const dates=[...observations.keys()].sort();
  const asOf=dates.at(-1);
  if(!asOf || Date.parse(today)-Date.parse(asOf)>6*dayMs) throw Error('Stale ECB index');
  const values:bigint[]=[];
  for(const start of dates) {
    const end=observations.get(endDate(start,period));
    if(end!==undefined) values.push(microPercent(observations.get(start)!,end));
  }
  // Compare observed start and end values only. Never substitute a previous close for a missing date.
  if(values.length<20) throw Error('Insufficient matched dates');
  values.sort((a,b)=>a===b?0:a<b?-1:1);
  const mid=Math.floor(values.length/2);
  const median=values.length%2?values[mid]:(values[mid-1]+values[mid])/BigInt(2);
  return {status:'available' as const,source:'ECB_ESTR_COMPOUNDED_INDEX' as const,source_url:referenceSource,period,
    from:dates[0],as_of:asOf,samples:values.length,lower_pct_micros:String(values[0]),median_pct_micros:String(median),
    upper_pct_micros:String(values[values.length-1])};
}

export async function readEuroReference(period:Period,get=fetch) {
  try {
    const response=await get(dataUrl,{headers:{Accept:'text/csv'},redirect:'error',signal:AbortSignal.timeout(11000),next:{revalidate:3600}});
    if(!response.ok || !response.body) throw Error('ECB series unavailable');
    const limit=512*1024;
    if(Number(response.headers.get('content-length'))>limit) throw Error('Response exceeds limit');
    const reader=response.body.getReader();
    const chunks:Uint8Array[]=[];
    let size=0;
    try {
      for(;;) {
        const chunk=await reader.read();
        if(chunk.done) break;
        size+=chunk.value.byteLength;
        if(size>limit) {await reader.cancel();throw Error('Response exceeds limit');}
        chunks.push(chunk.value);
      }
    } finally {reader.releaseLock();}
    return euroReferenceRange(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),period);
  } catch {
    return {status:'unavailable' as const,source:'ECB_ESTR_COMPOUNDED_INDEX' as const,source_url:referenceSource,period,
      from:null,as_of:null,samples:0,lower_pct_micros:null,median_pct_micros:null,upper_pct_micros:null};
  }
}
