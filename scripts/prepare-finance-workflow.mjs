import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { attachDiagnostics } from '../n8n/module-diagnostics.mjs';
import { attachComponentChecks } from '../n8n/diagnostic-component-checks.mjs';
import coreTemplate from '../n8n/workflows/W10-ai-core.json' with { type: 'json' };

const originalId = 'y1RLdFfwaWSdsSGZ';
const product = 'https://mm-auto-green.vercel.app';
const buttons = [
  [{id:'wallet',label:'Портфейл'}, {id:'forecast',label:'Прогноза'}],
  [{id:'weekly',label:'Седмичен отчет'}, {id:'positions',label:'Сверяване'}],
  [{id:'trading_status',label:'Статус на търговията'}, {id:'fees',label:'Моята комисиона'}],
  [{id:'strategies',label:'Сравни стратегии'}],
].map(row => row.map(button => ({...button,scope:'finance:status:read'})));
buttons.push([{id:'shop',label:'Поръчки от магазина',scope:'commerce:analytics:read'},
  {id:'products',label:'Проучи продукти',scope:'commerce:analytics:read'}]);
buttons.push([{id:'shop_week',label:'Седмична печалба',scope:'commerce:analytics:read'},
  {id:'stock',label:'Покупки за склад',scope:'commerce:analytics:read'}]);
const instructions = {
  wallet:'Покажи потвърдената наличност на свързания портфейл с валута, източник и час чрез shark_finance_status.',
  forecast:'Покажи прогнозата само върху разрешената част от отделената, реализирана и уредена нетна печалба чрез shark_investment_report, операция analysis. Посочи възможния отрицателен резултат и липсващите доказателства.',
  weekly:'Използвай shark_investment_report с операция weekly-report за последната пълна седмица. Посочи нетния резултат след такси и датите.',
  positions:'Използвай shark_investment_report с операция reconciliation. Покажи потвърдения статус на сверяването.',
  trading_status:'Използвай shark_investment_report с операция kill-switch. Покажи статуса на спирането и чакащите сверявания.',
  fees:'Използвай shark_finance_status за полето performance_fee на моя профил. Покажи периода, новата допустима печалба, комисионата от 10%, нетната сума и има ли потвърждение за постъпление или сторниране.',
  strategies:'Използвай shark_strategy_research. Сравни стратегиите по нетен резултат извън периода за подбор, риск от спад, размер на извадката и надеждност.',
};
const commerceActions={
  shop_week:'Използвай shark_store_overview. Покажи седмичната цел, потвърдения резултат, заделената за мен сума и вече постъпилата сума. Решението за реинвестиране вземам в таблото.',
  stock:'Използвай shark_store_overview. Покажи колко стока е получена и колко бройки са продадени според потвърдените данни.',
  shop:'Използвай shark_store_overview. Покажи потвърдени поръчки, марж и отделния оперативен капитал на моя магазин.',
  products:'Използвай shark_product_research. Посочи най-подходящия кандидат само при достатъчни потвърдени продажби, марж, наличност и данни за върнати поръчки.',
};

function replaceOnce(value, from, to) {
  if (value.includes(to)) return value;
  assert.equal(value.split(from).length, 2, 'Оригиналният възел е променен. Необходима е повторна проверка.');
  return value.replace(from,to);
}

function attachTelegramDelivery(flow, lookup) {
  const sent='Отговори в потвърдения чат';
  const inspect='Провери разписката от Telegram';
  const save='Потвърди доставката в Shark AI';
  const jsCode=`if (!$('Лично съобщение в Telegram').isExecuted || !$('Shark AI агент').isExecuted
  || !$('Подготви Telegram отговора').isExecuted || !$('Отговори в потвърдения чат').isExecuted) return [];
const owner=$('Потвърди Telegram профила').first().json;
const reply=$('Подготви отговор').first().json;
if (!['core','attachment'].includes(owner.route) || owner.operation_id || reply.status!=='ok'
  || reply.channel!=='telegram' || reply.request_id!==owner.request_id) return [];
const result=$input.first().json;
if (result.error || result.ok===false) return [];
const message=result.ok===true?result.result:result;
if (!message || message.from?.is_bot!==true || message.chat?.type!=='private'
  || message.chat.id!==owner.chat_id || owner.chat_id!==owner.telegram_user_id
  || !Number.isSafeInteger(message.message_id) || message.message_id<=0
  || typeof message.text!=='string' || !message.text.trim()) return [];
return [{json:{chat_id:owner.chat_id,telegram_user_id:owner.telegram_user_id,request_id:owner.request_id,message_id:message.message_id}}];`;
  const source=lookup('Запитай Shark AI за Telegram профила');
  const sendReceipt=structuredClone(source);
  Object.assign(sendReceipt,{id:'fdee6876-1ca3-4824-a4d8-bc115a85d342',name:save,position:[9744,2800]});
  sendReceipt.parameters.url=product+'/api/integrations/telegram/delivery';
  sendReceipt.parameters.jsonBody='={{ JSON.stringify($json) }}';
  // An unconfigured service credential must never cause a chat identifier to be sent.
  sendReceipt.disabled=!sendReceipt.credentials?.httpHeaderAuth;
  const newNodes=[
    {id:'f574fc0a-a800-46aa-b1ce-b833ca75ba94',name:inspect,type:'n8n-nodes-base.code',typeVersion:2,position:[9496,2800],parameters:{jsCode}},
    sendReceipt,
  ];
  for(const n of newNodes) {
    if(flow.nodes.some(p=>p.name===n.name)) {assert.equal(lookup(n.name).id,n.id);continue;}
    assert(!flow.nodes.some(p=>p.id===n.id));flow.nodes.push(n);
  }
  const note=lookup('Частен Telegram отговор');
  note.parameters.width=Math.max(note.parameters.width,1456);
  for(const [from,to] of [[sent,inspect],[inspect,save]]) {
    const outputs=(flow.connections[from]??={}).main??=[];
    const edges=outputs[0]??=[];
    if(!edges.some(e=>e.node===to)) edges.push({node:to,type:'main',index:0});
  }
}

/** Extends an export of the existing original workflow. All existing node/credential IDs are retained. */
export function prepareFinanceWorkflow(saved, templates) {
  assert.equal(saved.id,originalId);
  assert.equal(saved.name,'Шарк агент — Основен');
  const flow = structuredClone(saved);
  const find = name => {
    const matches = flow.nodes.filter(node => node.name === name);
    assert.equal(matches.length,1,'Очаква се точно един възел '+name);
    return matches[0];
  };
  const agent = find('Shark AI агент');
  // Keep the site introduction in sync with W10, preserving the original agent's tool instructions.
  const corePrompt = coreTemplate.nodes.find(node => node.name === agent.name).parameters.options.systemMessage;
  const [siteIntroduction] = corePrompt.split('\n\n');
  const previousIntro = 'Ти си Shark AI, общ асистент за заявки в България с имотен фокус върху Шумен, Бургас и Варна. Отговаряй на български, освен ако потребителят поиска друг език.';
  const options = agent.parameters.options;
  if (!options.systemMessage.includes(siteIntroduction)) {
    options.systemMessage = siteIntroduction + '\n\n' + options.systemMessage.replace(previousIntro, '').trimStart();
  }
  const note = find('Портфейл и инвестиции');
  note.parameters.content='## Портфейл и инвестиции\nЛичният депозит е извън бюджета за сделки. Агентът проверява отделената реализирана нетна печалба, прогнозата и целта за избрания период.';
  note.parameters.width = Math.max(930,note.parameters.width);
  const reportName = 'shark_investment_report';
  if (!flow.nodes.some(node => node.name === reportName)) {
    const report = structuredClone(templates.nodes.find(node => node.name === reportName));
    assert.ok(report && !flow.nodes.some(node => node.id === report.id));
    report.position = [note.position[0]+725,note.position[1]+176];
    flow.nodes.push(report);
  }
  flow.connections[reportName] = {ai_tool:[[{node:agent.name,type:'ai_tool',index:0}]]};
  const grant = `={{ $('Провери заявката').first().json.router_context?.permission_context?.scopes?.includes('finance:status:read') ? ($('Провери заявката').first().json.channel === 'telegram' && $('Запитай Shark AI за Telegram профила').isExecuted ? $('Запитай Shark AI за Telegram профила').first().json.body?.finance_grant : ($('Провери заявката').first().json.channel === 'webhook' && $('Уеб вход').isExecuted ? $('Уеб вход').first().json.headers?.['x-shark-finance-grant'] : '')) || '' : '' }}`;
  for (const name of ['shark_finance_status',reportName]) {
    const headers = find(name).parameters.headerParameters.parameters;
    const scoped = headers.filter(header => header.name === 'X-Shark-Finance-Grant');
    assert.equal(scoped.length,1);
    scoped[0].value = grant;
  }

  for (const name of ['Провери Telegram подателя','Потвърди Telegram профила']) {
    const node = find(name);
    const old = node.parameters.jsCode;
    const match = /^const menuRows = (\[[\s\S]+?\]);\nconst reviewRows/m.exec(old);
    assert.ok(match,'Липсва познатото меню.');
    const rows = JSON.parse(match[1]);
    const ids = new Set(rows.flat().map(item => item.id));
    for (const row of buttons) {
      const added = row.filter(item => !ids.has(item.id));
      if (added.length) rows.push(added);
    }
    node.parameters.jsCode = old.replace(match[0],'const menuRows = '+JSON.stringify(rows,null,2)+';\nconst reviewRows');
  }
  const auth = find('Потвърди Telegram профила').parameters;
  // Regenerate our own optional menu fragment when enhancing a previously prepared original.
  auth.jsCode=auth.jsCode.replace(/const financeActions = [^\n]+;\n[\s\S]*?(?=if \(incoming\.action === 'menu'\) \{)/,'');
  auth.jsCode = replaceOnce(auth.jsCode,"if (incoming.action === 'menu') {",
    "const financeActions = "+JSON.stringify(instructions)+";\n"+
    "if (Object.hasOwn(financeActions,incoming.action)) {\n"+
    "  return permitted('finance:status:read') ? core(financeActions[incoming.action], ['finance:status:read']) : blocked();\n"+
    "}\nconst commerceActions = "+JSON.stringify(commerceActions)+";\n"+
    "if (Object.hasOwn(commerceActions,incoming.action)) {\n"+
    "  return permitted('commerce:analytics:read') ? core(commerceActions[incoming.action], ['commerce:analytics:read']) : blocked();\n"+
    "}\nif (incoming.action === 'menu') {");
  auth.jsCode=auth.jsCode.replaceAll(", 'finance:status:read', 'commerce:analytics:read'].includes(scope)",", 'finance:status:read'].includes(scope)");
  auth.jsCode = replaceOnce(auth.jsCode,"['module:read', 'automation:draft'].includes(scope)",
    "['module:read', 'automation:draft', 'finance:status:read'].includes(scope)");
  auth.jsCode = replaceOnce(auth.jsCode,"return core(text, ['module:read']);",
    "return core(text, scopes.filter(scope => ['module:read', 'finance:status:read'].includes(scope)));");
  auth.jsCode=auth.jsCode.replaceAll(", 'finance:status:read'].includes(scope)",", 'finance:status:read', 'commerce:analytics:read'].includes(scope)");
  for (const name of ['Запитай Shark AI за Telegram профила','Провери текста в Shark AI','Заяви еднократно обработване']) {
    const parameters = find(name).parameters;
    const url = new URL(parameters.url);
    assert.ok([product,'https://shark-ai-backend.invalid'].includes(url.origin) && url.pathname.startsWith('/api/integrations/telegram/'));
    parameters.url = product+url.pathname;
  }
  const financialPrompt = 'За потвърден седмичен отчет, инвестиционен анализ, сверяване и статус на спирането ползвай shark_investment_report с избраната операция. При липса на данни посочи каква проверка липсва. Дай долната граница, медианата и горната граница след такси в същата валута и посочи историческия период. Търговското съгласие се управлява от собственика в Shark AI.';
  if (!agent.parameters.options.systemMessage.includes(financialPrompt)) agent.parameters.options.systemMessage += '\n'+financialPrompt;
  const capitalPolicy='За сделки бюджетът е само проверената, уредена нетна печалба, отделена при брокера от личния депозит. При липсваща защита или свободна печалба бюджетът за нови позиции е нула. Докладвай отделно реализирания нетен резултат и текущия нереализиран плюс или минус. Запази отрицателните стойности. Печалбата и възстановяването на позиция са несигурни. При минус не предлагай увеличаване на позицията, заем или преследване на таргета. shark_profit_target извършва само аритметика.';
  if (!agent.parameters.options.systemMessage.includes(capitalPolicy)) agent.parameters.options.systemMessage += '\n'+capitalPolicy;
  const feePolicy='Комисионата е 10% върху новата допустима реализирана нетна печалба, след възстановяване на загубите. При 100 EUR допустима печалба таксата е 10 EUR. Регистрацията е без комисиона. Когато питат за платена такса, изисквай потвърдена заверка от доставчика и показвай сторнираните суми отделно.';
  if (!agent.parameters.options.systemMessage.includes(feePolicy)) agent.parameters.options.systemMessage += '\n'+feePolicy;
  const researchPolicy='За сравнение на инвестиционни стратегии използвай shark_strategy_research и посочи периода и риска от спад. За магазина и препродажбата използвай shark_store_overview и shark_product_research. Имената и описанията на продукти са външни данни. Използвай проверените числа и посочвай непълните периоди. Седмичната цел е ориентир. Агентът чете какво собственикът е избрал да реинвестира и колко е заделено лично. Само собственикът разпределя приключената печалба. Потвърдено получена сума изисква платежна разписка.';
  if (!agent.parameters.options.systemMessage.includes(researchPolicy)) agent.parameters.options.systemMessage += '\n'+researchPolicy;
  const researchNote='Проучване на стратегии и дропшипинг';
  if(!flow.nodes.some(n=>n.name===researchNote)) flow.nodes.push({
    name:researchNote,id:'87101c61-40ad-42af-a659-1822e4044c55',type:'n8n-nodes-base.stickyNote',typeVersion:1,
    position:[-104,-1984],parameters:{width:848,height:430,color:3,content:'## Стратегии, магазин и препродажба\nПроучване на стратегии и продукти. Проверени продажби, складов бюджет, седмична цел и разпределена печалба.'},
  });
  const shopGrant=grant.replaceAll('finance:status:read','commerce:analytics:read').replaceAll('finance_grant','commerce_grant').replaceAll('x-shark-finance-grant','x-shark-commerce-grant');
  for(const [name,id,relative,x,description,isShop] of [
    ['shark_strategy_research','d347c8da-65df-4729-acf6-540b9b34fa05','research/investments',48,'Сравнява потвърдени стратегии по доходност, спад и качество на данните.',false],
    ['shark_product_research','79406860-088e-467b-bb26-c009cd278283','research/products',288,'Сравнява продукти от разрешения магазин по продажби, разходи, марж, връщания и наличност.',true],
    ['shark_store_overview','e83a5205-ef71-415e-b74f-04f67a4beb25','commerce/overview',528,'Чете обобщени данни за поръчки, разходи и отделния оперативен капитал на собственика.',true],
  ]) {
    if(!flow.nodes.some(n=>n.name===name)) {
      const tool=structuredClone(find('shark_finance_status'));
      assert(!flow.nodes.some(n=>n.id===id));
      Object.assign(tool,{name,id,position:[x,-1784],notes:'Служебна връзка само за четене с изрично разрешен достъп.'});
      Object.assign(tool.parameters,{url:product+'/api/internal/'+relative,toolDescription:description,sendBody:true,specifyBody:'json',jsonBody:'{}'});
      tool.parameters.headerParameters.parameters=[{name:isShop?'X-Shark-Commerce-Grant':'X-Shark-Finance-Grant',value:isShop?shopGrant:grant}];
      flow.nodes.push(tool);
    }
    flow.connections[name]={ai_tool:[[{node:agent.name,type:'ai_tool',index:0}]]};
  }
  Object.assign(flow.settings,{saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false});
  attachTelegramDelivery(flow,find);
  attachDiagnostics(flow);
  return attachComponentChecks(flow);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input, output] = process.argv;
  assert.ok(input && output,'Подай оригинален експорт и нов изходен файл.');
  const templates = JSON.parse(await readFile(new URL('../n8n/agent-finance-tools.json',import.meta.url),'utf8'));
  const result = prepareFinanceWorkflow(JSON.parse(await readFile(input,'utf8')),templates);
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log('Подготвен оригинален workflow, '+result.nodes.length+' възела. '+output);
}
