import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {attachComponentChecks} from '../n8n/diagnostic-component-checks.mjs';

const source=JSON.parse(readFileSync(new URL('../n8n/workflows/W20-investment-market-data.json',import.meta.url),'utf8'));
const start='Започни диагностиката',merge='Събери резултатите',checks='Провери курса, одобренията, черновите и паметта';
const graph={nodes:[{name:start,type:'n8n-nodes-base.code'},{name:merge,type:'n8n-nodes-base.merge',parameters:{numberInputs:3}}],connections:{}};
attachComponentChecks(graph);
const original=structuredClone(graph);
attachComponentChecks(graph);
assert.deepEqual(graph,original);
assert.equal(graph.nodes.find(n=>n.name===merge).parameters.numberInputs,4);
assert.equal(new Set(graph.nodes.map(n=>n.name)).size,graph.nodes.length);
assert.deepEqual(graph.connections[checks].main[0],[{node:merge,type:'main',index:3}]);
const ecb='Диагностика W20 · ';
for(const n of source.nodes.filter(n=>!n.type.endsWith('Trigger') && !n.type.endsWith('stickyNote'))) {
  const clone=graph.nodes.find(x=>x.name===ecb+n.name);
  assert.equal(clone.type,n.type);
  assert.equal(clone.typeVersion,n.typeVersion);
  assert.notEqual(clone.id,n.id);
  if(n.parameters.jsCode) assert.equal(clone.parameters.jsCode.replaceAll(ecb,''),n.parameters.jsCode);
  else assert.deepEqual(clone.parameters,n.parameters);
  if (!source.connections[n.name]) assert.equal(graph.connections[clone.name].main[0][0].node,checks);
}
const external=graph.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest');
assert.equal(external.length,1);
assert.equal(external[0].parameters.method,'GET');
assert.equal(external[0].parameters.url,'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
assert.equal(source.settings.callerIds,'y1RLdFfwaWSdsSGZ');
const run=new Function('$input','$',graph.nodes.find(n=>n.name===checks).parameters.jsCode);
const probe='n8n-acceptance-081';
const today=new Date().toISOString().slice(0,10);
const quote={mode:'READ_ONLY',instrument:'EUR/USD',source:'ecb-exr-eurusd-reference',source_url:external[0].parameters.url,
  request_id:probe,quote_kind:'reference_rate',unit:'USD per EUR',timezone:'Europe/Berlin',
  retrieved_at:new Date().toISOString(),rate:'1.0831',observation_date:today,status:'ok',
  freshness:{state:'as_published',expected_observation_date:today}};
function inspect(packet) {
  const items=run({first:()=>({json:packet})},name=>{ assert.equal(name,start); return {first:()=>({json:{probe_id:probe}})}; });
  assert.equal(items.length,1);
  assert.equal(items[0].json.kind,'components');
  const observations=items[0].json.observations;
  assert.deepEqual(observations.map(r=>r.id),['W20','W12','W13','W14']);
  return observations;
}
const green=inspect(quote);
assert.deepEqual(green.map(r=>r.status),['passed','unverified','passed','unverified']);
assert.equal(green[0].evidence.request_id,probe); assert.equal(green[0].evidence.rate,quote.rate);
assert.equal(green[2].evidence.request_id,probe); assert.equal(green[2].evidence.invalid_input,'INVALID_DRAFT_REQUEST');
for(const bad of [{...quote,request_id:'other'},{...quote,source_url:'https://example.invalid/'},{...quote,rate:'1e25'},
    {...quote,observation_date:'2099-01-01'},{...quote,retrieved_at:'2001-01-01T00:00:00Z'},{...quote,status:'stale'},{}]) {
  const w20=inspect(bad)[0]; assert.equal(w20.status,'failed');assert.equal(w20.evidence,undefined);
}
assert.equal(inspect({...quote,status:'unavailable',error:{code:'ECB_UNAVAILABLE'}})[0].status,'unverified');
console.log('Component diagnostic graph, fixed ECB GET, original W20 code/edges, W12/W14 supplemental evidence and W13 acceptance passed.');
