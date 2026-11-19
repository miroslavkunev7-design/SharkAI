import assert from 'node:assert/strict';
import {test} from 'node:test';
import {quoteHorizon,quoteInvestment,forecastQuoteRequest} from '../lib/investments/forecast-quote.server';
import type {ForecastHistory,ForecastFunding} from '../lib/investments/forecast';
import type {BrokerForecastInputs} from '../lib/investments/forecast-source.server';

const owner='test-quote-owner',binding='verified-bound-source',utcDay=86400000;
const now=new Date('2028-01-31T12:00:00Z'),lastClose=Date.parse('2028-01-30T00:00:00Z');
const history:ForecastHistory={ownerId:owner,accountRef:binding,currency:'EUR',source:'ibkr_portfolio_analyst_net_strategy',
  instrumentCode:'stock',strategyLabel:'strategy',observedAt:'2028-01-31T00:05:00Z',
  basis:'cash_flow_adjusted_after_fees',valuationBasis:'unitized_strategy_nav',
  feeCoverage:{execution:'included',ongoing:'included',financing:'not_applicable',currencyConversion:'not_applicable'},
  applicableCapitalMinor:{min:'1',max:'1000000000000000000'},closes:Array.from({length:1827},(_,i)=>{
    const close=new Date(lastClose-(1826-i)*utcDay),date=close.toISOString().slice(0,10);
    const markTomorrow=new Date(close.valueOf()+utcDay);
    const monthLast=new Date(Date.UTC(markTomorrow.getUTCFullYear(),markTomorrow.getUTCMonth()+1,0)).getUTCDate();
    const febBoundary=markTomorrow.getUTCMonth()===1&&markTomorrow.getUTCDate()===monthLast;
    return {kind:'valued',date,units:febBoundary?'1250':close.getUTCDate()===12?'2000':'1000'};
  })};
const money:ForecastFunding={ownerId:owner,accountRef:binding,currency:'EUR',source:'ibkr_segregated_realized_net_profit',
  availableMinor:'3000',observedAt:'2028-01-31T12:00:00Z',basis:'segregated_settled_realized_net_profit'};
const input={currency:'EUR',period:'month' as const,amount_minor:'12345'};
function sources(h:ForecastHistory|null,f:ForecastFunding|null,mandate=3000n) {
  return {settings:async(user:string)=>{assert.equal(user,owner);return {currency:'EUR',authorizedAmountMinor:4000n,
    instrumentCode:'stock',strategyLabel:'strategy',tradingConsentRevokedAt:null};},
    broker:async(user:string)=>{assert.equal(user,owner);return {history:h,funding:f} as BrokerForecastInputs;},
    mandate:async(user:string,bound:string)=>{assert.equal(user,owner);assert.equal(bound,binding);return mandate;}};
}
test('all six periods preserve exact dates, including clamped calendar month and leap years',()=>{
  for(const [period,days] of Object.entries({day:1,week_1:7,week_2:14,week_3:21,week_4:28,month:29})){
    assert.equal(quoteHorizon(period as typeof input.period,now).horizon_days,days);
  }
  const regular=quoteHorizon('month',new Date('2027-01-31T17:00:00Z'));
  assert.deepEqual(regular,{start_date:'2027-01-31',end_date_exclusive:'2027-02-28',horizon_days:28});
  assert.equal(quoteHorizon('month',now).end_date_exclusive,'2028-02-29');
});
test('verified history on entered capital is independent from spending, matched historical calendar periods include losses',async()=>{
  const quote=await quoteInvestment(owner,input,now,sources(history,null));
  assert.equal(quote.status,'available');assert.equal(quote.authorized_funded_minor,'0');assert.equal(quote.authorized_range,null);
  assert.equal(quote.sample_count,60);assert.equal(quote.window_start,'2023-01-30');assert.equal(quote.window_end,'2028-01-30');
  assert.deepEqual(quote.range,{lower_minor:'-2469',upper_minor:'3087',lower_pct:'-20.000000',upper_pct:'25.000000'});
  const signed=await quoteInvestment(owner,input,now,sources(history,money,2500n));
  assert.equal(signed.authorized_funded_minor,'2500');
  assert.deepEqual(signed.authorized_range,{lower_minor:'-500',upper_minor:'625',lower_pct:'-20.000000',upper_pct:'25.000000'});
  const stopped=await quoteInvestment(owner,input,now,sources(history,money,0n));
  assert.equal(stopped.authorized_funded_minor,'0');assert.deepEqual(stopped.range,quote.range);
});
test('currency, history ownership, recent observations, fees, capital applicability and exact request bounds are enforced',async()=>{
  for(const feeOrSource of [null,{...history,ownerId:'different'},{...history,currency:'USD'},{...history,observedAt:'2028-01-28T12:00:00Z'},
    {...history,applicableCapitalMinor:{min:'10',max:'12000'}},{...history,closes:history.closes.slice(-400)}]){
    const result=await quoteInvestment(owner,input,now,sources(feeOrSource,null));
    assert.equal(result.status,'unavailable');assert.equal(result.range,null);assert.equal(result.authorized_funded_minor,'0');
  }
  for(const period of ['day','week_1','week_2','week_3','week_4','month']){
    assert.equal(forecastQuoteRequest.safeParse({...input,period}).success,true);
    const value=await quoteInvestment(owner,{...input,period:period as typeof input.period},now,sources(history,null));
    assert.equal(value.status,'available');
  }
  for(const bad of [{amount_minor:'0'},{amount_minor:'1e6'},{amount_minor:'oops'},{amount_minor:'9223372036854775808'},
    {period:'arbitrary'},{currency:'NOPE'},{owner_id:'elsewhere'},{funding:1000}]){
    assert.equal(forecastQuoteRequest.safeParse({...input,...bad}).success,false);
  }
});
