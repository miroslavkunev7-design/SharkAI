import assert from 'node:assert/strict';
import {test} from 'node:test';
import {housingBrief,readOpportunities,readHousing} from '../lib/investments/investment-progress-opportunities.server';
import {readEuroReference} from '../lib/investments/ecb-euro-reference';
import {readPublicOpportunities} from '../lib/investments/market-opportunities.public';
import {GET as marketOpportunities} from '../app/api/market/opportunities/route';
import {progressWindow,readInvestmentProgress} from '../lib/investments/investment-progress.server';
import {emptyResearch} from '../lib/research/ranking';

const now=new Date('2026-11-19T12:00:00Z');
const category=(codes:string[])=>({category:{index:Object.fromEntries(codes.map((c,i)=>[c,i]))}});
const source={source:'ESTAT',updated:'2026-10-01T12:00:00+03:00',id:['freq','purchase','unit','geo','time'],size:[1,1,1,1,5],
  dimension:{freq:category(['Q']),purchase:category(['TOTAL']),unit:category(['RCH_A']),geo:category(['BG']),
    time:category(['2025-Q2','2025-Q3','2025-Q4','2026-Q1','2026-Q2'])},value:{0:1.5,1:0.5,2:-0.5,3:-2,4:-1},status:{4:'p'}};
test('matches calendar targets including leap days, pre-start and days grouped by signed target start',()=>{
  const monthly={start_date:'2028-01-31',period:'MONTH' as const,days:null};
  const feb=Date.parse('2028-02-29T12:00:00Z');
  assert.deepEqual(progressWindow(monthly,feb),{start:'2028-02-29',end:'2028-03-31'});
  assert.deepEqual(progressWindow(monthly,feb-86400000),{start:'2028-01-31',end:'2028-02-29'});
  assert.deepEqual(progressWindow({...monthly,period:'CUSTOM_DAYS',days:14},feb),{start:'2028-02-28',end:'2028-03-13'});
});
test('signed closeout %, shown for selected window only, can be negative or exceed 100% without clamping',async()=>{
  const m={version:'synthetic',terms:{currency:'EUR',period:'DAY',days:null,start_date:'2026-11-16',goal_minor:'100',goal_bps:null,
      capital_minor:'10000',capital_source:'verified_settled_realized_profit_only',performance_fee_bps:1000,protection_policy_id:'09b138bc-630b-4f97-b5d6-ff0a69092f43'},
    provider:'SAXO',accepted:new Date('2026-11-16T01:00:00Z'),expires:new Date('2026-11-22T00:00:00Z'),revoked:null,halted:null,live:true,loss_stop:null};
  const reports=[{observed:new Date('2026-11-19T08:00:00Z'),net:'-140',realized:'2000',reports:2,hit:true},
    {observed:new Date('2026-11-19T11:59:00Z'),net:'185',realized:'2000',reports:2,hit:true}];
  const rows=[[m],[],reports];
  const data=await readInvestmentProgress('owner',null,{$queryRaw:async()=>rows.shift()} as never,now);
  assert.deepEqual(data.points.map(p=>p.percent),['-140.00','185.00']);
  assert.equal(data.realized_account_minor,'2000');assert.equal(data.reports,2);assert(data.fresh&&data.target_reached);
});
test('Eurostat housing only accepts the requested single geography, quarterly series, current release and independently sourced periods',()=>{
  const valid=housingBrief(source,now);assert(valid);assert.equal(valid.category,'housing');assert.equal(valid.period,'2026-Q2');
  assert.match(valid.value,/-1%/);assert.match(valid.assessment,/предварителна/);
  for(const wrong of [{...source,source:'unknown'},{...source,status:{4:'c'}},{...source,updated:'2027-10-01T12:00:00Z'},
    {...source,dimension:{...source.dimension,geo:category(['DE'])}},{...source,value:{0:1,1:2,2:3,3:4}},
    {...source,dimension:{...source.dimension,time:category(['2025-Q1','2025-Q3','2025-Q4','2026-Q1','2026-Q2'])}}]){
    assert.equal(housingBrief(wrong,now),null);
  }
  assert.equal(housingBrief(source,new Date('2027-11-19T12:00:00Z')),null);
});
test('opportunity analysis includes research only for eligible original owner, exact class and evidence. Public data can stand alone.',async()=>{
  const research=emptyResearch('investments','EUR',now),empty=()=>emptyResearch('investments','EUR',now);
  const metrics={median_net_bps:90,max_drawdown_bps:1200,worst_period_bps:-520,holdout_median_net_bps:-17,
    instrument_code:'OWNER-ETF',source_observed_at:now.toISOString(),window_start:'2025-09-01',window_end:'2026-11-18',sample_count:60,
    source:'ibkr_portfolio_analyst_net_strategy'};
  research.candidates=[{id:'etf',label:'A',status:'eligible',rank:1,metrics,reasons:[]},{id:'unclear',label:'B',status:'insufficient_data',rank:null,metrics,reasons:[]}];
  const verify=(user:string)=>{assert.equal(user,'owner');};
  const inputs={research:async(user:string)=>{verify(user);return research;},housing:async()=>housingBrief(source,now),
    categories:async(user:string)=>{verify(user);return [{id:'etf',kind:'ETF' as const}];},
    cash:async()=>({status:'unavailable' as const,source:'ECB_ESTR_COMPOUNDED_INDEX' as const,source_url:'https://www.ecb.europa.eu/',period:'week_1' as const})};
  const result=await readOpportunities('owner','EUR',7,now,inputs as never);
  assert.equal(result.strategies.length,1);assert.equal(result.strategies[0].category,'ETF');assert.equal(result.strategies[0].leader,false);
  assert.match(result.strategies[0].assessment,/не се повтаря/);assert.deepEqual(result.unavailable_sources,['ЕЦБ · €STR']);
  const noBroker=await readOpportunities('owner','EUR',7,now,{...inputs,research:async()=>empty()} as never);
  assert.deepEqual(noBroker.strategies,[]);assert.equal(noBroker.briefs[0].category,'housing');
});
test('anonymous route rejects private selectors and its public service exposes only market briefs',async()=>{
  for(const suffix of ['?currency=EUR','?owner=someone','?days=3','?days=7&days=1']){
    assert.equal((await marketOpportunities(new Request('https://shark.invalid/api/market/opportunities'+suffix))).status,400);
  }
  const result=await readPublicOpportunities(7,now,{housing:async()=>housingBrief(source,now),cash:async()=>({status:'unavailable'})} as never);
  assert.deepEqual(Object.keys(result).sort(),['as_of','briefs','days','unavailable_sources']);
  assert.equal(result.briefs[0].category,'housing');
});
if(process.argv.includes('--public-sources')){
  test('official public sources provide current evidence without any private connection',async()=>{
    const [housing,cash]=await Promise.all([readHousing(new Date()),readEuroReference('week_1')]);
    assert.ok(housing);assert.equal(cash.status,'available');
    console.log('Eurostat',housing.period,housing.value,'published',housing.as_of,'· ECB €STR',cash.as_of,'matched periods',cash.samples);
    const anonymous=await marketOpportunities(new Request('https://shark.invalid/api/market/opportunities?days=7'));
    assert.equal(anonymous.status,200);
    const publicBody=await anonymous.json();
    assert.deepEqual(Object.keys(publicBody).sort(),['as_of','briefs','days','unavailable_sources']);
    assert.deepEqual(publicBody.briefs.map((brief:Record<string,unknown>)=>brief.category),['housing','euro_cash']);
  });
}
