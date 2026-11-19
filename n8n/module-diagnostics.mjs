import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const checkGroups = {
  'Общ агент и канали':['W01','W02','W03','W04','W10','W11','W12','W13','W14','W19'],
  'Инвестиции':['W20','W21','W23','W24','W25','W29','CAPITAL','MANDATE','WORKER','STRATEGIES'],
  'Портфейл и база':['DB','W30','W31','W32','W33','W39','FEE'],
  'Магазин и препродажба':['SHOP_ORDERS','SHOP_CAPITAL','SHOP_FULFILLMENT','SHOP_PRODUCTS','SHOP_SETTLEMENT','SHOP_PROCUREMENT'],
};

const probe='Започни диагностиката';
const http='Провери свързаните услуги';
const core='Потвърди изпълнението на агента';
const errors='Провери обработката на грешки';
const join='Събери резултатите';
const report='Отчет за всички модули';
const verdict='Всички задължителни проверки минаха';
const pass='Проверката е успешна';
const fail='Има непреминали проверки';
const note='Секция: Проверка на модулите';
const origin='When clicking ‘Execute workflow’';
const id = name => {
  const hex=createHash('sha256').update('shark-v1-diagnostics/'+name).digest('hex');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);
};
const node=(name,type,typeVersion,position,parameters,extra={})=>({name,id:id(name),type:'n8n-nodes-base.'+type,typeVersion,position,parameters,...extra});
const code=(name,position,jsCode)=>node(name,'code',2,position,{jsCode});

export function summarizeChecks(probeId,remote,observations,now,groups) {
  const required = Object.values(groups).flat();
  const data=remote?.statusCode===200 ? remote.body : null;
  const time=Date.parse(data?.checked_at);
  const valid = data?.contract==='sharkai-module-diagnostics-v1' && data.probe_id===probeId
    && Number.isFinite(time) && time<=now+5000 && now-time<120000
    && Array.isArray(data.checks) && data.checks.length<=80;
  const rows=new Map();
  if(valid) for(const row of data.checks) {
    if(!row || !required.includes(row.id) || !['passed','failed','unverified'].includes(row.status)) continue;
    if(rows.has(row.id)) {rows.set(row.id,{id:row.id,status:'failed',detail:'Услугата върна противоречиви записи.'});continue;}
    rows.set(row.id,{id:row.id,status:row.status,detail:typeof row.detail==='string'?row.detail.slice(0,220):''});
  }
  const localIds=['W10','W11','W12','W13','W14','W20'];
  const requiredLocal=['W10','W11','W13','W20'];
  const seen=new Set();
  for(const row of observations) {
    if(!row || !localIds.includes(row.id) || !['passed','failed','unverified'].includes(row.status)) continue;
    const {id,detail}=row;
    const e=row.evidence;
    let status=row.status;
    if(seen.has(id)) status='failed';
    seen.add(id);
    if(status==='passed' && id==='W20') {
      const age=now-Date.parse(e?.retrieved_at);
      if(e?.source!=='ecb-exr-eurusd-reference' || e.source_url!=='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
        || e.request_id!==probeId || !(age>=-5000 && age<120000) || typeof e.rate!=='string' || !(Number(e.rate)>0)
        || !/^\d{4}-\d{2}-\d{2}$/.test(e.observed_on) || !/^\d{4}-\d{2}-\d{2}$/.test(e.expected_on) || e.observed_on<e.expected_on) status='failed';
    }
    if(status==='passed' && id==='W13' && (e?.source!=='W13-automation-builder' || e.request_id!==probeId
      || e.mode!=='draft' || e.invalid_input!=='INVALID_DRAFT_REQUEST')) status='failed';
    const prior=rows.get(id);
    if(prior?.status==='failed') continue;
    if(!requiredLocal.includes(id) && status!=='failed' && prior?.status==='passed') continue;
    if(!requiredLocal.includes(id) && status==='passed') status='unverified';
    rows.set(id,{id,status,detail:typeof detail==='string'?detail.slice(0,220):''});
  }
  for(const id of requiredLocal) if(!seen.has(id) && rows.get(id)?.status!=='failed') {
    rows.set(id,{id,status:'unverified',detail:'Липсва потвърждение от това изпълнение на n8n.'});
  }
  const labels={DB:'База данни',W01:'Уеб вход',W02:'Имейл',W03:'WhatsApp · отложен',W04:'Telegram',W10:'Отговор от агента',
    W11:'Изпълнение на инструмент',W12:'Човешко одобрение',W13:'Чернова на автоматизация',W14:'Памет',W19:'Обработка на грешки',
    W20:'Пазарни данни от ЕЦБ',W21:'Прогноза върху наличния капитал',W23:'Готовност за поръчки',W24:'Сверяване',W25:'Седмичен отчет',
    W29:'Аварийно спиране',W30:'Свързан портфейл',W31:'Баланс',W32:'Постъпления',W33:'Потвърждение при доставчика',W39:'Подпис на Stripe',
    FEE:'Комисиона към администратора',CAPITAL:'Защита на личния депозит',MANDATE:'Мандат на собственика',WORKER:'Изпълнител на поръчки',
    STRATEGIES:'Сравнение на стратегии',SHOP_PRODUCTS:'Проучване на продукти',SHOP_ORDERS:'Поръчки от магазина',SHOP_CAPITAL:'Оперативен капитал',
    SHOP_FULFILLMENT:'Изпълнение при доставчика',SHOP_SETTLEMENT:'Седмична цел и разпределение',SHOP_PROCUREMENT:'Покупки за склад'};
  const checks=required.map(id=>({label:labels[id],...(rows.get(id)??{id,status:'unverified',detail:valid
    ?'Липсва резултат за тази проверка.':'Липсва актуален удостоверен отчет от Shark AI.'})}));
  return {probe_id:probeId,checked_at:new Date(now).toISOString(),all_passed:checks.every(r=>r.id==='W03'||r.status==='passed'),
    groups:Object.fromEntries(Object.entries(groups).map(([name,ids])=>[name,checks.filter(r=>ids.includes(r.id))])),
    incomplete:checks.filter(r=>r.id!=='W03'&&r.status!=='passed').map(r=>r.id),
    informational:['W03']};
}

export function attachDiagnostics(flow) {
  const trigger=flow.nodes.filter(n=>n.type==='n8n-nodes-base.manualTrigger');
  assert.equal(trigger.length,1);
  assert.equal(trigger[0].name,origin);
  const exists=name=>flow.nodes.find(n=>n.name===name);
  for(const name of ['Покажи отговора от теста','Обобщи автоматичната грешка','Shark AI агент','shark_finance_status']) assert.ok(exists(name),name);
  // n8n permits one Manual Trigger per workflow. Both the original acceptance chain and the diagnostics start there.
  trigger[0].position=[-1376,-2960];
  const native=exists('shark_finance_status');
  const credential=native.credentials?.httpHeaderAuth;
  const local=`if ($execution.mode!=='manual' || !$('${origin}').isExecuted) return [];
const input=$input.first().json;
const req=$('Провери заявката').first().json;
const agent=$('Shark AI агент');
const ok=agent.isExecuted && req.request_id?.startsWith('synthetic-') && input.request_id===req.request_id
  && input.status==='ok' && typeof input.reply==='string' && input.reply.trim().length>0;
const steps=agent.isExecuted?agent.first().json.intermediateSteps:[];
const positive=(o,depth=0)=>{
  if(depth>4 || o==null)return false;
  if(typeof o==='string'){if(o.length>12000)return false;try{return positive(JSON.parse(o),depth+1);}catch{return false;}}
  if(Array.isArray(o))return o.slice(0,8).some(item=>positive(item,depth+1));
  if(typeof o!=='object')return false;
  if('status' in o)return o.status==='ok';
  return ['response','json','output'].some(key=>key in o&&positive(o[key],depth+1));
};
const tool=Array.isArray(steps)&&steps.some(s=>{
  if(!['shark_tool_router','shark_profit_target'].includes(s.action?.tool))return false;
  return positive(s.observation);
});
return [{json:{kind:'core',observations:[
 {id:'W10',status:ok?'passed':'failed',detail:ok?'Агентът върна отговор за същата ръчна заявка.':'Липсва потвърден отговор от агента.'},
 {id:'W11',status:tool?'passed':'failed',detail:tool?'Агентът получи успешен резултат от инструмента.':'Липсва успешен резултат от инструмент.'}
]}}];`;
  const errorCode=`if ($execution.mode!=='manual' || !$('${origin}').isExecuted) return [];
const r=$input.first().json;
return [{json:{kind:'redaction',passed:r.code==='UPSTREAM_TIMEOUT'&&r.request_id==='synthetic-w19-001'
  &&!JSON.stringify(r).includes('W19_SYNTHETIC_RAW_MARKER')}}];`;
  const reportCode=summarizeChecks.toString()
    +`\nconst all=$input.all().map(i=>i.json);
const core=all.find(i=>i.kind==='core');
const redaction=all.find(i=>i.kind==='redaction');
const response=all.find(i=>i.kind==='remote');
const components=all.find(i=>i.kind==='components');
const observed=[...(core?.observations??[]),...(components?.observations??[])];
const result=summarizeChecks('n8n-'+$execution.id,response?.packet,observed,Date.now(),${JSON.stringify(checkGroups)});
result.local_error_redaction=redaction?.passed===true?'passed':'failed';
if (result.local_error_redaction==='failed'){result.all_passed=false;result.incomplete.push('W19_REDACTION');}
return [{json:result}];`;
  const remoteWrapper='Отдели резултатите от услугите';
  const emitted=[
    node(note,'stickyNote',1,[-1488,-3264],{color:4,width:2144,height:800,content:'## Проверка на модулите\nНатисни Execute workflow върху ръчния тригър. Отвори „Отчет за всички модули“ за резултатите. Зелен финал изисква потвърждение за всяка задължителна проверка. WhatsApp е оставен за по-късно.'}),
    code(probe,[-1112,-3120],`if ($execution.mode!=='manual' || !$('${origin}').isExecuted) return [];
return [{json:{probe_id:'n8n-'+$execution.id}}];`),
    node(http,'httpRequest',4.2,[-888,-3120],{method:'POST',url:'https://mm-auto-green.vercel.app/api/internal/wallet-investments/diagnostics',
      ...(credential?{authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth'}:{authentication:'none'}),
      sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify({probe_id:$json.probe_id}) }}',
      options:{timeout:20000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}}}},
      {onError:'continueRegularOutput',...(credential&&{credentials:{httpHeaderAuth:credential}})}),
    code(remoteWrapper,[-624,-3120],`const r=$input.first().json;
return [{json:{kind:'remote',packet:{statusCode:r.statusCode,body:r.statusCode===200?r.body:null}}}];`),
    code(core,[-624,-2912],local),code(errors,[-624,-2704],errorCode),
    node(join,'merge',3.2,[-376,-2912],{mode:'append',numberInputs:3}),
    code(report,[-144,-2912],reportCode),
    node(verdict,'if',2.2,[88,-2912],{conditions:{options:{caseSensitive:true,typeValidation:'strict',version:2},
      conditions:[{id:id('ok'),leftValue:'={{ $json.all_passed }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}),
    node(pass,'noOp',1,[410,-3072],{}),
    node(fail,'stopAndError',1,[410,-2752],{errorType:'errorMessage',errorMessage:"={{ 'Провери отчета за '+$json.incomplete.join(', ') }}"}),
  ];
  for(const x of emitted) {
    const previous=exists(x.name);
    if(previous){assert.equal(previous.id,x.id);continue;}
    assert(!flow.nodes.some(n=>n.id===x.id));flow.nodes.push(x);
  }
  const link=(from,to,output=0,input=0)=>{
    const outputs=(flow.connections[from]??={}).main??=[];
    const edges=outputs[output]??=[];
    if(!edges.some(e=>e.node===to&&e.index===input))edges.push({node:to,type:'main',index:input});
  };
  link(origin,probe);link(probe,http);link(http,remoteWrapper);link(remoteWrapper,join,0,0);
  link('Покажи отговора от теста',core);link(core,join,0,1);
  link('Обобщи автоматичната грешка',errors);link(errors,join,0,2);
  link(join,report);link(report,verdict);link(verdict,pass);link(verdict,fail,1);
  return flow;
}
