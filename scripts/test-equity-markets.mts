import test from 'node:test';
import assert from 'node:assert/strict';
import {equityCatalog,equityCloses,fetchEquityCloses} from '../lib/markets/equities.server';
import {equityListings,equityWindow} from '../lib/markets/equities';

const [apple,,vanguard] = equityListings;
const now = new Date('2026-11-20T23:30:00.000Z'); // New York is still Friday, Berlin is Saturday.
const bar = (datetime:string,close='120.75')=>({datetime,close});
const meta = {symbol:'AAPL',mic_code:'XNGS',currency:'USD',exchange_timezone:'America/New_York',interval:'1day'};
const packet = {status:'ok',meta,values:[bar('2026-11-20'),bar('2026-11-19','117.5'),bar('2026-11-18','115')]};

test('retains only completed local dates and records the fetch time separately',()=>{
  assert.deepEqual(equityCloses(packet,apple,now),{state:'available',checkedAt:now.toISOString(),points:[
    {day:'2026-11-18',close:115},{day:'2026-11-19',close:117.5},
  ]});
  const result=equityCloses({...packet,meta:{...meta,symbol:'VWCE',mic_code:'XETR',currency:'EUR',exchange_timezone:'Europe/Berlin'}},vanguard,now);
  assert.ok('points' in result && result.points.at(-1)?.day==='2026-11-20');
});

test('a missing or unconfirmed listing cannot supply a quote',()=>{
  for(const patch of [{symbol:'MSFT'},{mic_code:'XNYS'},{currency:'EUR'},{exchange_timezone:'UTC'},{interval:'1h'}]){
    assert.throws(()=>equityCloses({...packet,meta:{...meta,...patch}},apple,now));
  }
  for(const values of [[],[bar('2026-11-20')],[bar('2026-11-23')],[bar('2026-02-30')],[bar('2026-11-19'),bar('2026-11-19')],[bar('2026-11-19','0')],[bar('2026-11-19','-1')],[bar('2026-11-19','NaN')]]){
    assert.throws(()=>equityCloses({...packet,values},apple,now));
  }
});

test('historical quotes stay dated; ranges select observed days only',()=>{
  const result=equityCloses({...packet,values:[bar('2026-10-20'),bar('2026-09-10'),bar('2026-10-14'),bar('2026-10-13')]},apple,now);
  assert.equal(result.state,'historical');
  assert.ok('points' in result);
  assert.deepEqual(equityWindow(result.points,7).map(p=>p.day),['2026-10-14','2026-10-20']);
  assert.equal(equityWindow(result.points,30).length,3);
  assert.equal(equityWindow(result.points,90).length,4);
});

test('only approved listings use a non-demo server credential',async()=>{
  const calls:string[]=[];
  const read=async (listing:typeof equityListings[number])=>{calls.push(listing.symbol);return {state:'unavailable'} as const;};
  for(const env of [{},{TWELVE_DATA_API_KEY:'example'},{TWELVE_DATA_API_KEY:'demo',TWELVE_DATA_PUBLIC_EQUITY_LISTINGS:'XNGS:AAPL'}]){
    const result=await equityCatalog(env as NodeJS.ProcessEnv,read);
    assert.ok(Object.values(result.series).every(v=>v.state==='unlicensed'));
  }
  const result=await equityCatalog({TWELVE_DATA_API_KEY:'example',TWELVE_DATA_PUBLIC_EQUITY_LISTINGS:'XETR:VWCE,XETR:AAPL'} as NodeJS.ProcessEnv,read);
  assert.deepEqual(calls,['VWCE']);assert.equal(result.series.AAPL.state,'unlicensed');
});

test('read-only official API request pins instrument and never puts key in URL',async()=>{
  const response:typeof fetch=async (input,init)=>{
    const url=new URL(String(input));
    assert.equal(url.origin,'https://api.twelvedata.com');
    assert.equal(url.pathname,'/time_series');
    assert.equal(url.searchParams.get('mic_code'),'XNGS');
    assert.equal(url.searchParams.get('adjust'),'none');
    assert.equal(url.searchParams.has('apikey'),false);
    assert.equal(init?.method,'GET'); assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('Authorization'),'apikey fixture');
    return Response.json(packet);
  };
  const result=await fetchEquityCloses(apple,'fixture',response,now);assert.equal(result.state,'available');
  await assert.rejects(fetchEquityCloses(apple,'fixture',async()=>new Response('x'.repeat(100_000)),now));
  await assert.rejects(fetchEquityCloses(apple,'fixture',async()=>Response.json({code:403,status:'error'}),now));
});
