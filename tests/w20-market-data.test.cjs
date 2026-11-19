const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const test = require('node:test');

const workflow = JSON.parse(readFileSync(join(__dirname,'../n8n/workflows/W20-investment-market-data.json'),'utf8'));
const node = name => workflow.nodes.find(candidate=>candidate.name===name);
const parser = node('Провери дата и EUR USD');
const parse = new Function('$input','$','Date',parser.parameters.jsCode);
const inbound = new Function('$input',node('Провери заявката за курс').parameters.jsCode);
const verifyBody = new Function('$input',node('Ограничи XML отговора').parameters.jsCode);
const run = (observation,now) => {
  class CivilClock extends Date { constructor(){ super(now); } }
  const Clock = new Proxy(CivilClock,{construct(target,args) {
    return args.length ? new Date(...args) : new CivilClock();
  }});
  return parse({all:()=>[{json:observation}]},()=>({first:()=>({json:{request_id:'synthetic-ecb-fixture'}})}),Clock)[0].json;
};
const ecb = (date,rates=[{currency:'USD',rate:'1.0840'},{currency:'JPY',rate:'180.1'}])=>({
  'gesmes:Envelope':{$:{xmlns:'http://www.ecb.int/vocabulary/2002-08-01/eurofxref'},'gesmes:subject':'Reference rates',
   'gesmes:Sender':{'gesmes:name':'European Central Bank'},
   Cube:{Cube:{$:{time:date},Cube:rates.map($=>({$}))}}},
});
const asInput=(fn,value)=>fn({all:()=>[{json:value}]})[0].json;

test('W20 has one inactive credential-free provider path',()=>{
  assert.equal(workflow.active,false);
  const names=new Set(workflow.nodes.map(n=>n.name));
  assert.equal(names.size,workflow.nodes.length);
  for(const [source,typed] of Object.entries(workflow.connections)){
    assert.ok(names.has(source));
    for(const targets of typed.main)for(const target of targets)assert.ok(names.has(target.node));
  }
  const [transport]=workflow.nodes.filter(n=>n.type.endsWith('.httpRequest'));
  assert.equal(transport.parameters.method,'GET');
  assert.equal(transport.parameters.url,'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  assert.equal(transport.parameters.options.redirect.redirect.followRedirects,false);
  assert.ok(!transport.credentials);
  assert.equal(transport.retryOnFail,false);
});
test('fixed instrument admits an opaque request ID but no caller-selected host or clock',()=>{
  assert.equal(asInput(inbound,{}).decision,'fetch');
  assert.equal(asInput(inbound,{instrument:'EUR/USD',request_id:'r-1'}).request_id,'r-1');
  for(const input of [{instrument:'GBP/USD'},{url:'https://external.invalid'},{as_of:'2026-11-19'},{request_id:'bad/value'}]){
    const result=asInput(inbound,input);assert.equal(result.status,'unavailable');assert.ok(!Object.hasOwn(result,'rate'));
  }
});
test('XML boundary rejects malformed, oversized and DTD bodies',()=>{
  assert.equal(asInput(verifyBody,{data:'<bound/>'}).decision,'parse');
  for(const data of [null,'','a'.repeat(33000),'<!DOCTYPE x><x/>','<!ENTITY x "sample"><x/>']){
    assert.equal(asInput(verifyBody,{data}).decision,'invalid_feed');
  }
});
test('exact decimal and official attribution survive W20 normalization',()=>{
  const result=run(ecb('2026-11-19'),'2026-11-19T16:40:00.000Z');
  assert.equal(result.status,'ok');assert.equal(result.mode,'READ_ONLY');
  assert.equal(result.rate,'1.0840');assert.equal(result.unit,'USD per EUR');
  assert.equal(result.quote_kind,'reference_rate');assert.equal(result.source,'ecb-exr-eurusd-reference');
  assert.equal(result.observation_date,'2026-11-19');assert.equal(result.timezone,'Europe/Berlin');
  assert.equal(result.retrieved_at,'2026-11-19T16:40:00.000Z');
});
test('expected publication respects weekends, cutoff and Frankfurt daylight time',()=>{
  const prior='2026-06-12';
  const monday='2026-06-15';
  const early=run(ecb(prior),'2026-06-15T14:30:00.000Z');
  assert.equal(early.status,'ok');assert.equal(early.freshness.expected_observation_date,prior);
  const late=run(ecb(prior),'2026-06-15T15:30:00.000Z');
  assert.equal(late.status,'stale');assert.equal(late.freshness.expected_observation_date,monday);
  assert.ok(!Object.hasOwn(late,'rate'));
  assert.equal(run(ecb(monday),'2026-06-15T14:30:00.000Z').status,'ok');
  assert.equal(run(ecb(prior),'2026-06-14T19:00:00.000Z').status,'ok');
  assert.equal(run(ecb('2026-11-13'),'2026-11-16T15:30:00.000Z').status,'ok');
});
test('TARGET closing dates keep the last actual reference until the next publication',()=>{
  const prior='2026-04-02';
  assert.equal(run(ecb(prior),'2026-04-03T20:00:00.000Z').status,'ok');
  const easterMonday=run(ecb(prior),'2026-04-06T20:00:00.000Z');
  assert.equal(easterMonday.status,'ok');assert.equal(easterMonday.freshness.expected_observation_date,prior);
  const tuesday=run(ecb(prior),'2026-04-07T17:30:00.000Z');
  assert.equal(tuesday.status,'stale');assert.equal(tuesday.freshness.expected_observation_date,'2026-04-07');
  assert.equal(run(ecb('2026-12-24'),'2026-12-26T20:00:00.000Z').status,'ok');
  assert.equal(run(ecb('2026-04-30'),'2026-05-01T20:00:00.000Z').status,'ok');
});
test('invalid source, future/holiday dates, absent, duplicate and bogus USD rates stay unavailable',()=>{
  const date='2026-11-19', time='2026-11-19T16:40:00.000Z';
  for(const xml of [
    {},{error:'simulated provider timeout'},ecb('2026-11-20'),ecb('2026-11-15'),ecb('2026-11-31'),
    ecb(date,[{currency:'JPY',rate:'180'}]),
    ecb(date,[{currency:'USD',rate:'1.1'},{currency:'USD',rate:'1.2'}]),
    ecb(date,[{currency:'USD',rate:'0'},{currency:'JPY',rate:'180'}]),
    ecb(date,[{currency:'USD',rate:'1e10'},{currency:'JPY',rate:'180'}]),
  ]){
    const result=run(xml,time);assert.equal(result.status,'unavailable');assert.ok(!Object.hasOwn(result,'rate'));
  }
});
