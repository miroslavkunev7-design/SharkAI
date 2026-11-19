import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareFinanceWorkflow } from './prepare-finance-workflow.mjs';
import { checkGroups, summarizeChecks } from '../n8n/module-diagnostics.mjs';

const sourcePath = process.argv[2];
assert.ok(sourcePath,'Подай път до експорта на оригиналния агент.');
const source = JSON.parse(await readFile(sourcePath,'utf8'));
const tools = JSON.parse(await readFile(new URL('../n8n/agent-finance-tools.json',import.meta.url),'utf8'));
const flow = prepareFinanceWorkflow(source,tools);
assert.deepEqual(prepareFinanceWorkflow(flow,tools),flow);
const nodes = new Map(flow.nodes.map(node => [node.name,node]));
for (const existing of source.nodes) {
  assert.equal(nodes.get(existing.name).id,existing.id);
  assert.deepEqual(nodes.get(existing.name).credentials,existing.credentials);
}
for (const outputs of Object.values(flow.connections)) {
  for (const branches of Object.values(outputs)) {
    for (const connections of branches) for (const edge of connections) assert(nodes.has(edge.node));
  }
}
const status = nodes.get('shark_finance_status');
const report = nodes.get('shark_investment_report');
for (const node of [status, report]) {
  const scoped = node.parameters.headerParameters.parameters[0].value;
  assert(scoped.includes('finance:status:read') && scoped.includes('finance_grant'));
  assert(!scoped.includes('$fromAI'));
  assert.equal(flow.connections[node.name].ai_tool[0][0].node,'Shark AI агент');
}
const execute = (name,input,lookups={}) => {
  const items = [{json:input}];
  return Function('$input','$',nodes.get(name).parameters.jsCode)(
    {all:()=>items,first:()=>items[0]},key=>({isExecuted:Object.hasOwn(lookups,key),first:()=>({json:lookups[key]})}),
  );
};
const prepare = 'Провери Telegram подателя';
const authorize = 'Потвърди Telegram профила';
const chat = {id:77321,type:'private'};
const person = {id:77321,is_bot:false};
const callback = {update_id:330,callback_query:{id:'cb42',from:person,data:'shark:forecast',message:{
  chat,from:{id:77322,is_bot:true},message_id:130,date:Math.floor(Date.now()/1000),
}}};
assert.deepEqual(execute(prepare,callback),[]);
const incoming = execute(prepare,callback,{'Лично съобщение в Telegram':callback})[0].json;
assert.equal(incoming.action,'forecast');
const auth = (action,scopes) => execute(authorize,{
  statusCode:200,body:{channel:'telegram',request_id:incoming.request_id,status:'authorized',user_id:'u1',
    conversation_id:'c1',permission_context:{scopes},finance_grant:'TEST_SECRET_DO_NOT_FORWARD'},
},{[prepare]:{...incoming,action},'Лично съобщение в Telegram':callback})[0].json;
const allowed = ['module:read','finance:status:read'];
const selection = auth('forecast',allowed);
assert.equal(selection.route,'core');
assert.deepEqual(selection.request.permission_context.scopes,['finance:status:read']);
assert(selection.request.message.includes('shark_investment_report'));
assert(!JSON.stringify(selection).includes('TEST_SECRET_DO_NOT_FORWARD'));
assert.equal(auth('forecast',['module:read']).route,'notice');
assert(!JSON.stringify(auth('menu',['module:read'])).includes('shark:forecast'));
assert(JSON.stringify(auth('menu',allowed)).includes('shark:forecast'));
for(const key of ['wallet','weekly','positions','trading_status','fees','strategies']) assert.equal(auth(key,allowed).route,'core');
const shopScopes=['module:read','commerce:analytics:read'];
for(const key of ['products','shop','stock','shop_week']) {
  assert.equal(auth(key,allowed).route,'notice');
  assert.deepEqual(auth(key,shopScopes).request.permission_context.scopes,['commerce:analytics:read']);
}
for(const name of ['shark_strategy_research','shark_product_research','shark_store_overview']) {
  const node=nodes.get(name);
  assert.equal(flow.connections[name].ai_tool[0][0].node,'Shark AI агент');
  const grant=node.parameters.headerParameters.parameters[0];
  assert.equal(grant.name,name==='shark_strategy_research'?'X-Shark-Finance-Grant':'X-Shark-Commerce-Grant');
  assert(!grant.value.includes('$fromAI') && !node.parameters.url.includes('$fromAI'));
}
const receiptNode='Провери разписката от Telegram';
const available={'Лично съобщение в Telegram':{},'Shark AI агент':{},'Подготви Telegram отговора':{},'Отговори в потвърдения чат':{},
  'Потвърди Telegram профила':{route:'core',request_id:incoming.request_id,chat_id:chat.id,telegram_user_id:person.id},
  'Подготви отговор':{status:'ok',channel:'telegram',request_id:incoming.request_id}};
const telegramMessage={message_id:48,chat,from:{is_bot:true},text:'test-only'};
const acknowledgement={chat_id:chat.id,telegram_user_id:person.id,message_id:48,request_id:incoming.request_id};
assert.deepEqual(execute(receiptNode,{ok:true,result:telegramMessage},available),[{json:acknowledgement}]);
assert.deepEqual(execute(receiptNode,telegramMessage,available),[{json:acknowledgement}]);
assert.deepEqual(execute(receiptNode,{ok:false,result:telegramMessage},available),[]);
assert.deepEqual(execute(receiptNode,{...telegramMessage,chat:{id:1,type:'private'}},available),[]);
assert.deepEqual(execute(receiptNode,telegramMessage,{...available,'Подготви отговор':{status:'unavailable'}}),[]);
assert.deepEqual(execute(receiptNode,telegramMessage,{}),[]);
assert.equal(flow.connections['Отговори в потвърдения чат'].main[0].some(edge=>edge.node===receiptNode),true);
assert.equal(flow.settings.saveDataSuccessExecution,'none');
assert.equal(flow.settings.saveDataErrorExecution,'none');
const manual='When clicking ‘Execute workflow’';
assert.equal(flow.nodes.filter(n=>n.type==='n8n-nodes-base.manualTrigger').length,1);
assert.deepEqual(new Set(flow.connections[manual].main[0].map(e=>e.node)),new Set(['Shark — Тестови входове','Започни диагностиката']));
const checks=Object.values(checkGroups).flat().map(id=>({id,status:id==='W03'?'unverified':'passed',detail:'fixture'}));
const now=Date.now();
const packet={statusCode:200,body:{contract:'sharkai-module-diagnostics-v1',probe_id:'n8n-42',checked_at:new Date(now).toISOString(),checks}};
const coreObservations=['W10','W11'].map(id=>({id,status:'passed',detail:'test-only'}));
const quote={id:'W20',status:'passed',evidence:{source:'ecb-exr-eurusd-reference',source_url:'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  request_id:'n8n-42',retrieved_at:new Date(now).toISOString(),observed_on:'2026-01-02',expected_on:'2026-01-02',rate:'1.0500'}};
const draft={id:'W13',status:'passed',evidence:{source:'W13-automation-builder',request_id:'n8n-42',mode:'draft',invalid_input:'INVALID_DRAFT_REQUEST'}};
const components=[quote,draft,{id:'W12',status:'unverified'},{id:'W14',status:'unverified'}];
const local=[...coreObservations,...components];
const summarize=(remote,obs=local)=>summarizeChecks('n8n-42',remote,obs,now,checkGroups);
assert.equal(summarize(packet).all_passed,true);
assert.equal(summarize({statusCode:401}).all_passed,false);
assert.equal(summarize({...packet,body:{...packet.body,probe_id:'other'}}).all_passed,false);
assert.equal(summarize({...packet,body:{...packet.body,checked_at:new Date(now-150000).toISOString()}}).all_passed,false);
const incomplete={...packet,body:{...packet.body,checks:checks.filter(c=>c.id!=='W25')}};
assert.deepEqual(summarize(incomplete).incomplete,['W25']);
assert.deepEqual(summarize(packet,[]).incomplete.sort(),['W10','W11','W13','W20']);
assert.deepEqual(summarize(packet,[...local,{id:'W12',status:'failed'}]).incomplete,['W12']);
assert.deepEqual(summarize(packet,local.map(r=>r===quote?{...r,evidence:{...r.evidence,request_id:'replayed'}}:r)).incomplete,['W20']);
const noMemory=structuredClone(packet);
noMemory.body.checks.find(c=>c.id==='W14').status='unverified';
assert.deepEqual(summarize(noMemory,local.map(r=>r.id==='W14'?{...r,status:'passed'}:r)).incomplete,['W14']);
const bad=structuredClone(packet);
bad.body.checks.find(c=>c.id==='W10').status='failed';
assert(!summarize(bad,[{id:'W10',status:'passed',detail:'fixture'}]).all_passed);
const aggregate=nodes.get('Отчет за всички модули').parameters.jsCode;
const runReport=passed=>Function('$execution','$input',aggregate)({id:'42'},{all:()=>[
  {json:{kind:'remote',packet}},{json:{kind:'core',observations:coreObservations}},
  {json:{kind:'components',observations:components}},{json:{kind:'redaction',passed}},
]})[0].json;
assert(runReport(true).all_passed);
assert(!runReport(false).all_passed);
assert.equal(nodes.get('Има непреминали проверки').type,'n8n-nodes-base.stopAndError');
console.log('Manual diagnostics graph, complete evidence, missing/expired/replayed/failed results and final red branch passed.');
console.log('Original graph preserved, finance tools connected, access-scoped Telegram menu and secret separation passed.');
