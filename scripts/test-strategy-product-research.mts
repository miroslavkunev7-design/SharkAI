import assert from 'node:assert/strict';
import {readInvestmentResearch,readProductResearch} from '../lib/research/research.server';
import type {Close,CommerceDay,Product} from '../lib/research/ranking';

const now=new Date('2026-11-19T12:00:00Z'),code='USD';
const day=(offset:number)=>new Date(Date.UTC(2026,10,19+offset)).toISOString().slice(0,10);
const owner='synthetic-owner';
function marks(step:number,forward=true):Close[] {
  let nav=1_000_000_000;
  return Array.from({length:91},(_,i)=>{
    const date=day(i-91),weekday=new Date(date).getUTCDay(),closed=weekday===0||weekday===6;
    if(!closed) nav=Math.round(nav*(1+step/10000));
    return {date,units:String(nav),kind:closed?'confirmed_market_closed':'valued',forward};
  });
}
const strategy=(id:string,growth:number)=>({id,label:id,instrument_code:'TEST',source:'ibkr_portfolio_analyst_net_strategy',
  observed_at:now.toISOString(),closes:marks(growth)});
const investment=async(candidates:unknown[],complete=true)=>readInvestmentResearch(owner,{currency:code,horizonDays:1},async id=>{
  assert.equal(id,owner);return {currency:code,cohort_complete:complete,candidates};
},now);
const a=strategy('a',75),b=strategy('b',25);
const leading=await investment([a,b]);
assert.equal(leading.leader_id,'a');assert.equal(leading.candidates[0].metrics.sample_count,60);
assert.equal(leading.candidates[0].metrics.holdout_samples,20);assert.equal(leading.candidates[0].metrics.max_drawdown_bps,0);
assert.equal((await investment([a,b],false)).leader_id,null);
assert.equal((await investment([a,{...a,id:'same-record'}])).leader_id,null);
assert.equal((await investment([a,{...b,closes:marks(25,false)}])).leader_id,null);
assert.equal((await investment([a,{...b,closes:b.closes.slice(-15)}])).leader_id,null);
assert.equal((await investment([a,{...b,observed_at:day(-4)+'T00:00:00Z'}])).leader_id,null);
const fall={...a,closes:a.closes.map((c,i)=>i>70?{...c,units:String(Math.floor(Number(c.units)*0.5))}:c)};
assert.equal((await investment([fall,b])).leader_id,null);
assert((await investment([fall,b])).candidates.some(s=>Number(s.metrics.max_drawdown_bps)>=4900));
const collapse={...b,closes:b.closes.map((c,i,all)=>i===all.length-1?{...c,units:'0',kind:'valued' as const}:c)};
assert.equal((await investment([a,collapse])).candidates.find(x=>x.id==='b')?.metrics.max_drawdown_bps,10000);

function product(id:string,goods:string):Product {
  const days:CommerceDay[]=Array.from({length:56},(_,i)=>({date:day(i-56),orders:12,units:15,customer_count:10,
    revenue_minor:'20000',refunds_minor:'1000',goods_minor:goods,fulfillment_minor:'1500',advertising_minor:'1000',
    fees_minor:'500',other_costs_minor:'1000',largest_customer_revenue_minor:'3000'}));
  return {product_id:id,name:id,inventory_units:123,inventory_observed_at:now.toISOString(),days};
}
const products=(items:Product[],extra={})=>readProductResearch(owner,{currency:code},async()=>({
  status:'verified',observed_at:now.toISOString(),currency:code,catalog_complete:true,independent_sources_verified:true,products:items,...extra}),now);
const ca=product('a','6000'),cb=product('b','12000');
const sale=await products([ca,cb]);
assert.equal(sale.leader_id,'a');assert.equal(sale.candidates[0].metrics.net_contribution_minor,'504000');
assert.equal(sale.candidates[0].metrics.margin_bps,4736);
assert.equal(sale.candidates[0].metrics.orders,672);assert.equal(sale.candidates[0].metrics.refund_rate_bps,500);
assert.equal((await products([ca,cb],{independent_sources_verified:false})).leader_id,null);
assert.equal((await products([ca,cb],{catalog_complete:false})).leader_id,null);
const newItem=await products([ca,cb,{...ca,product_id:'new',days:[]}]);
assert.equal(newItem.candidates.find(x=>x.id==='new')?.status,'validation_candidate');assert.equal(newItem.leader_id,null);
const clustered={...ca,days:ca.days.map(d=>({...d,largest_customer_revenue_minor:'11000'}))};
assert.equal((await products([clustered,cb])).leader_id,null);
const noMargin={...ca,days:ca.days.map(d=>({...d,refunds_minor:'30000'}))};
assert.equal((await products([noMargin,cb])).leader_id,null);
assert.equal((await products([ca,{...cb,inventory_units:0}])).leader_id,null);
assert.equal((await products([ca,{...cb,inventory_observed_at:day(-2)+'T00:00:00Z'}])).leader_id,null);
assert.equal((await products([{...ca,days:ca.days.map(d=>({...d,customer_count:13}))},cb])).leader_id,null);
const unsorted={...ca,days:[...ca.days].reverse()};assert.equal((await products([unsorted,cb])).status,'unavailable');
assert.equal((await readInvestmentResearch(owner,{horizonDays:0},async()=>{throw Error('invalid');},now)).status,'unavailable');
console.log('Research ranking passed: prospective vs historical comparisons, holdout failure, terminal drawdown, full product costs, scarcity, concentration, duplicate/stale evidence and unavailable leaders.');
