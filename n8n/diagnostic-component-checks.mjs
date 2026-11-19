import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const start = 'Започни диагностиката';
const merge = 'Събери резултатите';
const manual = 'When clicking ‘Execute workflow’';
const input = 'Подготви проверката на ЕЦБ';
const checks = 'Провери курса, одобренията, черновите и паметта';
const source = name => JSON.parse(readFileSync(new URL('./workflows/'+name+'.json',import.meta.url),'utf8'));
const ecbName = name => 'Диагностика W20 · '+name;
const id = name => {
  const hash=createHash('sha256').update('shark-component-diagnostics/'+name).digest('hex');
  return [hash.slice(0,8),hash.slice(8,12),'4'+hash.slice(13,16),'9'+hash.slice(17,20),hash.slice(20,32)].join('-');
};
const code = (name,position,jsCode) => ({name,id:id(name),type:'n8n-nodes-base.code',typeVersion:2,position,
  parameters:{mode:'runOnceForAllItems',jsCode}});

// These are deterministic acceptance fixtures. Run the same pure operations embedded in the reviewed component exports.
// The only outbound request in this diagnostics branch is W20's fixed, credential-free ECB GET.
export function observeComponents(probeId,quote,preview,draft,context,now) {
  const rows=[];
  const row=(id,status,detail,evidence)=>rows.push({id,status,detail,...(evidence?{evidence}:{})});
  const utc=Date.parse(quote?.retrieved_at);
  const value=typeof quote?.rate==='string' && /^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/.test(quote.rate) ? Number(quote.rate) : NaN;
  const expected=quote?.freshness?.expected_observation_date;
  const date=quote?.observation_date;
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const validDate=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const sourceMatches=quote?.request_id===probeId && quote?.source==='ecb-exr-eurusd-reference' &&
    quote?.source_url==='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml' && quote?.instrument==='EUR/USD';
  if (sourceMatches && quote.status==='ok' && value>0 && Number.isFinite(value) && quote.quote_kind==='reference_rate'
      && quote.mode==='READ_ONLY' && quote.timezone==='Europe/Berlin' && date<=today
      && quote.unit==='USD per EUR' && quote.freshness?.state==='as_published' && validDate(date) && validDate(expected)
      && date>=expected && utc<=now+5000 && now-utc<120000) {
    row('W20','passed','ЕЦБ потвърди референтен курс за '+date+' · 1 EUR = '+quote.rate+' USD.',
      {source:quote.source,request_id:quote.request_id,source_url:quote.source_url,observed_on:date,
        expected_on:expected,retrieved_at:quote.retrieved_at,rate:quote.rate});
  } else if (sourceMatches && quote.status==='unavailable' && quote.error?.code==='ECB_UNAVAILABLE') {
    row('W20','unverified','Липсва отговор от официалния източник на ЕЦБ.');
  } else {
    row('W20','failed','Публикацията на ЕЦБ е остаряла, невалидна или не съответства на тази проверка.');
  }
  try {
    const request={request_id:probeId,risk:'write_with_approval',tool_id:'send_email',operation:'preview'};
    const valid=preview(request)?.json;
    const restricted=preview({...request,risk:'restricted_finance'})?.json;
    const ok=valid?.request_id===probeId && valid.status==='review_required' && valid.execution_allowed===false
      && valid.review?.tool_id===request.tool_id && restricted?.error?.code==='FINANCE_MODULE_REQUIRED' && restricted.execution_allowed===false;
    row('W12',ok?'unverified':'failed',ok
      ?'Прегледът изиска човешко одобрение и блокира финансова операция. Нужно е доказателство за записана и решена задача.'
      :'Локалната проверка за човешко одобрение се провали.');
  } catch { row('W12','failed','Грешка при изпълнение на проверката за човешко одобрение.'); }
  try {
    const request={route:'builder',deadline:Date.now()+4500,draft_input:{title:'Проверка на чернова',objective:probeId,
      action:'general_automation',channel:'telegram'}};
    const valid=draft(request)?.[0]?.json;
    const invalid=draft({...request,route:'unsupported'})?.[0]?.json;
    const ok=valid?.mode==='draft' && valid.title===request.draft_input.title && valid.objective===probeId
      && valid.channel==='telegram' && valid.action==='general_automation'
      && Array.isArray(valid.steps) && valid.steps.length>0 && valid.steps.every(s=>typeof s==='string' && s.trim().length>0)
      && Array.isArray(valid.acceptance_checks) && valid.acceptance_checks.length>0
      && invalid?.status==='error' && invalid.error?.code==='INVALID_DRAFT_REQUEST';
    row('W13',ok?'passed':'failed',ok?'Генераторът създаде чернова за ръчната заявка и отхвърли невалидния вход.'
      :'Генераторът на чернови не премина проверката на входа и резултата.',
      ok?{source:'W13-automation-builder',request_id:valid.objective,mode:valid.mode,invalid_input:invalid.error.code}:undefined);
  } catch { row('W13','failed','Грешка при изпълнение на генератора на чернови.'); }
  try {
    const request={request_id:probeId,user_id:'shark-diag-fixture',conversation_id:'shark-diag-fixture',operation:'read'};
    const valid=context(request)?.json;
    const invalid=context({...request,conversation_id:''})?.json;
    const ok=valid?.request_id===probeId && valid.status==='unavailable' && valid.error?.code==='CONTEXT_STORAGE_UNCONFIGURED'
      && Array.isArray(valid.context) && valid.context.length===0 && invalid?.status==='blocked'
      && invalid.error?.code==='INVALID_CONTEXT_REQUEST';
    row('W14',ok?'unverified':'failed',ok
      ?'Проверени са входът и отговорът при несвързана памет. Нужно е отделно потвърждение от хранилището.'
      :'Неочакван резултат от проверката за памет и контекст.');
  } catch { row('W14','failed','Грешка при проверка на паметта и контекста.'); }
  return rows;
}

export function attachComponentChecks(flow) {
  const mainMerge=flow.nodes.find(n=>n.name===merge);
  assert.ok(mainMerge?.type==='n8n-nodes-base.merge' && flow.nodes.some(n=>n.name===start),'Install base diagnostics first');
  mainMerge.parameters.numberInputs=4;
  const ecb=source('W20-investment-market-data');
  const quoteNodes=ecb.nodes.filter(n=>!['n8n-nodes-base.stickyNote','n8n-nodes-base.executeWorkflowTrigger'].includes(n.type));
  const imported=quoteNodes.map(n=>{
    const next=structuredClone(n);
    next.name=ecbName(n.name); next.id=id(next.name);
    next.position=[n.position[0]-1190,n.position[1]-4100];
    if (typeof next.parameters.jsCode==='string') {
      next.parameters.jsCode=next.parameters.jsCode.replace(/\$\('([^']+)'\)/g,(_all,name)=>{
        assert.ok(quoteNodes.some(x=>x.name===name),'Missing W20 reference '+name);return "$('"+ecbName(name)+"')";
      });
    }
    return next;
  });
  const pure=file=>{
    const workflow=source(file);
    const functions=workflow.nodes.filter(n=>n.type==='n8n-nodes-base.code');
    assert.equal(functions.length,1,file);return functions[0].parameters.jsCode;
  };
  const contracts='function preview($json){\n'+pure('W12-human-approval')+'\n}\n'
    +'function draft($fixture){const $input={all:()=>[{json:$fixture}]};\n'+pure('W13-automation-builder')+'\n}\n'
    +'function context($json){\n'+pure('W14-memory-and-context')+'\n}\n';
  const note='Секция: Курс и проверки на модул 1';
  const group={name:note,id:id(note),type:'n8n-nodes-base.stickyNote',typeVersion:1,position:[-1540,-4336],
    parameters:{color:3,width:2392,height:656,content:'## Диагностика · ЕЦБ и модул 1\nРеферентен курс от ЕЦБ и ръчни проверки на одобренията, черновите и паметта. Резултатите се включват в общия отчет.'}};
  const nodes=[group,code(input,[-1450,-4055],`if ($execution.mode!=='manual' || !$('${manual}').isExecuted) return [];
const probe=$input.first().json.probe_id;
if (probe!=='n8n-'+$execution.id) return [];
return [{json:{request_id:probe,instrument:'EUR/USD'}}];`),...imported,
    code(checks,[500,-4055],contracts+'\n'+observeComponents.toString()+
    "\nconst probe=$('"+start+"').first().json.probe_id;\nreturn [{json:{kind:'components',observations:observeComponents(probe,$input.first().json,preview,draft,context,Date.now())}}];")];
  for(const n of nodes) {
    const old=flow.nodes.find(x=>x.name===n.name || x.id===n.id);
    if(old){assert.deepEqual(old,n);continue;} flow.nodes.push(n);
  }
  const link=(from,to,output=0,index=0)=>{
    const outputs=(flow.connections[from]??={}).main??=[];
    const targets=outputs[output]??=[];
    if (!targets.some(t=>t.node===to && t.index===index)) targets.push({node:to,type:'main',index});
  };
  link(start,input);
  const trigger=ecb.nodes.find(n=>n.type==='n8n-nodes-base.executeWorkflowTrigger');
  for(const [from,wires] of Object.entries(ecb.connections)) {
    wires.main.forEach((targets,output)=>targets.forEach(t=>link(from===trigger.name?input:ecbName(from),ecbName(t.node),output,t.index)));
  }
  for(const n of quoteNodes) if(!ecb.connections[n.name]?.main?.some(w=>w.length)) link(ecbName(n.name),checks);
  link(checks,merge,0,3);
  return flow;
}
