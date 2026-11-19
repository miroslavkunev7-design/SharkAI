import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getAccountSession } from '../auth';
import { prisma } from '../db';
import { stripeBilling } from '../stripe-billing';
import { readRecentTelegramDelivery } from '../telegram-server';
import { getWalletSettings, walletDashboard } from '../wallet-investments-server';
import { financeServiceAuthorized } from '../wallet-investments-grants';
import { readBrokerOwnerState } from './broker-owner-state.server';
import { readOwnerMandates } from './trading-consent.server';
import { readWalletOperation } from './wallet-operations.server';
import { readInvestmentWorkflow } from './workflow-reads.server';
import { readOwnerPerformanceFee } from './performance-fee.server';
import {readCommerceAgentAccess,readCommerceDashboard} from '../commerce/commerce.server';
import {readResaleSettlement} from '../commerce/resale-settlement.server';
import {commerceRange} from '../commerce/owner-input';
import {readInvestmentResearch,readProductResearch} from '../research/research.server';

const definitions = {
  DB:'Връзка и схема в Supabase',W01:'Уеб вход',W02:'Имейл',W03:'WhatsApp (отложен)',W04:'Telegram',
  W10:'AI агент',W11:'Инструменти',W12:'Одобрения',W13:'Чернови на автоматизации',W14:'Памет',
  W19:'Обработка на грешки',W20:'Пазарни данни',W21:'Проверен капитал и прогноза',W23:'Предварителни проверки на поръчка',
  W24:'Сверяване с брокера',W25:'Седмичен резултат',W29:'Справка за спиране',W30:'Статус на портфейла',
  W31:'Потвърден баланс',W32:'Справка за постъпления',W33:'Потвърждение от собственика при Wise',
  W39:'Проверка на подписа за Stripe',CAPITAL:'Защита на личния депозит',MANDATE:'Съгласие на собственика',WORKER:'Готовност на търговския изпълнител',
  FEE:'Комисиона към администратора',
  STRATEGIES:'Сравнение на стратегии',SHOP_ORDERS:'Поръчки от магазина',SHOP_CAPITAL:'Оперативен капитал',
  SHOP_FULFILLMENT:'Изпълнение при доставчика',SHOP_PRODUCTS:'Проучване на продукти',
  SHOP_SETTLEMENT:'Седмична цел и разпределение',SHOP_PROCUREMENT:'Покупки за склад',
} as const;
type Id=keyof typeof definitions;
type Status='passed'|'failed'|'unverified';
type Evidence={status:Status;detail:string};
type Results=Partial<Record<Id,Evidence>>;
const evidence=(status:Status,detail:string):Evidence=>({status,detail});
const verified=(predicate:boolean,pass:string,missing:string)=>evidence(predicate?'passed':'unverified',predicate?pass:missing);
const untestedChannel=evidence('unverified','Изисква отделно наблюдавано изпълнение в оригиналния n8n.');
const missingChannel:Partial<Record<Id,string>>={
  W01:'Липсва запазено потвърждение за уеб заявка и отговор със същия идентификатор.',
  W02:'Липсва разписка за получаване на тестов имейл и доставка на отговора.',
  W04:'Липсва потвърдена двойка от входящо Telegram съобщение и върнат отговор за диагностичния профил.',
  W12:'Липсва наблюдавано решение на оторизиран човек за същата заявка в облачния W12.',
  W14:'Липсва наблюдавано извличане на разрешен контекст за същия разговор от облачния W14.',
  W19:'Липсва наблюдавано обработване на контролирана грешка от облачния W19.',
};
const unavailable=evidence('failed','Източникът не върна проверим отговор.');
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function keyMap(raw:string|undefined) {
  if (!raw || raw.length>65_536) return {};
  try {return z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),z.string().regex(/^[0-9a-f]{64}$/)).parse(JSON.parse(raw));}
  catch {return {};}
}
async function collectorReady(userId:string) {
  const env=process.env;
  if (env.SHARKAI_BROKER_EVIDENCE_ENABLED!=='true' || !env.SHARKAI_ORDER_SOURCE_DATABASE_URL || !env.SHARKAI_ORDER_PROFIT_DATABASE_URL) return false;
  const signals=keyMap(env.SHARKAI_ORDER_SIGNAL_KEYS),quotes=keyMap(env.SHARKAI_ORDER_QUOTE_KEYS),workers=keyMap(env.SHARKAI_ORDER_WORKER_KEYS);
  const profits=keyMap(env.SHARKAI_ORDER_PROFIT_KEYS);
  const otherSigners=new Set([...Object.keys(signals),...Object.keys(quotes),...Object.keys(workers)]);
  const all=[...Object.values(signals),...Object.values(quotes),...Object.values(workers),...Object.values(profits)];
  if (!Object.keys(profits).length || Object.keys(profits).some(id=>otherSigners.has(id)) || new Set(all).size!==all.length) return false;
  const credentials=env.SHARKAI_ORDER_WORKER_CREDENTIALS;
  if (!credentials || credentials.length>65_536) return false;
  let raw:unknown;
  try {raw=JSON.parse(credentials);} catch {return false;}
  const parsed=z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),z.object({
    broker:z.enum(['IBKR','SAXO']),account_key:z.string().min(1).max(128),token:z.string().regex(/^[A-Za-z0-9._~+/=-]{16,8192}$/),
  }).strict()).safeParse(raw);
  if (!parsed.success) return false;
  const tokens=Object.fromEntries(Object.entries(parsed.data).map(([id,entry])=>[id,{digest:hash(entry.token),account:hash(entry.broker+'/'+entry.account_key)}]));
  const ids=JSON.stringify({signals:Object.keys(signals),quotes:Object.keys(quotes),workers:Object.keys(workers),profits:Object.keys(profits),tokens});
  const rows=await prisma.$queryRaw<{ready:boolean}[]>`SELECT sharkai_broker.diagnostic_worker_binding(${userId},${ids}::jsonb) AS ready`;
  return rows.length===1 && rows[0].ready===true;
}
const schemaQuery=()=>prisma.$transaction(async tx=>{
  await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
  const rows=await tx.$queryRaw<Array<{ready:boolean}>>`SELECT
    NOT EXISTS(SELECT 1 FROM unnest(ARRAY['"User"','"Subscription"','"WalletInvestmentSettings"',
      '"TelegramBinding"','"TelegramUpdate"','sharkai_broker.account','sharkai_broker.order_ledger','sharkai_broker.owner_mandate',
      'sharkai_broker.worker_order','sharkai_broker.strategy_source','sharkai_broker.verified_account_snapshot',
      'sharkai_forecast.binding','sharkai_forecast.snapshot','sharkai_commerce.store','sharkai_commerce.stock_purchase',
      'sharkai_commerce.resale_week','sharkai_commerce.resale_payout','sharkai_research.investment_cohort']) n WHERE to_regclass(n) IS NULL)
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='TelegramUpdate' AND column_name='replyDeliveredAt')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='TelegramUpdate' AND column_name='replyMessageId')
    AND to_regprocedure('sharkai_broker.owner_worker_status(text)') IS NOT NULL
    AND to_regprocedure('sharkai_broker.list_worker_actions(text,boolean)') IS NOT NULL
    AND to_regprocedure('sharkai_commerce.resale_funding(text,text)') IS NOT NULL
    AND to_regprocedure('sharkai_commerce.stock_dashboard(text)') IS NOT NULL AS ready`;
  return rows.length===1 && rows[0].ready===true;
},{timeout:3500,maxWait:1000});

function stripeSignature():Evidence {
  const config=stripeBilling();
  if (!config) return evidence('unverified','Липсва настроен Stripe подпис за тази среда.');
  const payload='{"object":"event","type":"sharkai.diagnostic"}';
  const signature=config.stripe.webhooks.generateTestHeaderString({payload,secret:config.webhookSecret});
  if (String(config.stripe.webhooks.constructEvent(payload,signature,config.webhookSecret).type)!=='sharkai.diagnostic') return unavailable;
  try { config.stripe.webhooks.constructEvent(payload+' ',signature,config.webhookSecret); }
  catch { return evidence('passed','Текущият валидатор прие контролния подпис и отхвърли променено съдържание. Доставка от Stripe се проверява отделно.'); }
  return unavailable;
}

async function ownerChecks(userId:string):Promise<Results> {
  const [owner,profile]=await Promise.all([getAccountSession(userId),getWalletSettings(userId)]);
  if (!owner || owner.id!==userId || profile?.userId!==userId || profile.aiAccess!=='ANALYSIS_ONLY') return {};
  const outputs:Results={};
  async function check(ids:Id[],probe:()=>Promise<Results>) {
    try { Object.assign(outputs,await probe()); }
    catch { for(const id of ids) outputs[id]=unavailable; }
  }
  const wallet={userId,currency:profile.currency};
  await Promise.all([
    check(['STRATEGIES'],async()=>{
      const data=await readInvestmentResearch(userId,{currency:profile.currency??undefined});
      return {STRATEGIES:verified(data.status!=='unavailable' && data.candidates.some(c=>Object.keys(c.metrics).length>0),
        'Проучването върна показатели за стратегия от разрешения профил.','Липсва проверена съпоставима история за профила.')};
    }),
    check(['W04'],async()=>{
      const delivery=await readRecentTelegramDelivery(userId);
      return {W04:verified(delivery==='delivered','Потвърден е отговор от Telegram на прието съобщение за същия свързан профил през последните пет минути.',delivery==='inbound'
        ? 'Потвърдено е входящо съобщение от свързания Telegram профил през последните пет минути. Липсва разписка за отговора.'
        : 'Няма скорошно потвърдено входящо съобщение от свързания Telegram профил. Липсва разписка за отговора.')};
    }),
    check(['W21','W25','W31'],async()=>{
      const d=await walletDashboard(profile,owner);
      return {
        W21:verified(d.investments.status==='verified' && d.forecast.status==='available',
          'Потвърдени брокерски средства и изчислен диапазон след такси.','Липсват потвърдени средства, история или условия за диапазона.'),
        W25:verified(d.weekly_report.status==='available','Има проверен седмичен отчет след такси.','Иска се проверен седмичен брокерски отчет.'),
        W31:verified(d.wallet.status==='verified','Проверен е балансът на свързания профил.','Липсва актуален проверен баланс.'),
      };
    }),
    check(['W24','W29'],async()=>{
      const a=await readBrokerOwnerState(userId);
      return {
        W24:verified(a.status==='available' && a.accounts.length>0 && a.accounts.every(x=>x.reconciliation==='verified'),
          'Всички върнати сметки имат актуално проверено сверяване.','Сверяването е непълно или остаряло.'),
        W29:verified(a.status==='available' && a.accounts.length>0,'Прочетен е записаният статус на спирането.','Липсва достъпен брокерски статус за спиране.'),
      };
    }),
    check(['FEE'],async()=>{
      const fee=await readOwnerPerformanceFee(userId);
      return {FEE:verified(fee.status==='available' && (fee.settlement==='credited' || fee.fee_minor==='0'),
        fee.fee_minor==='0'?'За проверения период няма дължима комисиона.':'Последният отчет има потвърден дебит и заверка на уговорената комисиона при получателя.',
        fee.status==='available'?'Наличен е отчет. В него няма потвърдена активна заверка на комисиона.':'Липсва потвърден брокерски отчет за комисионата.')};
    }),
    check(['CAPITAL'],async()=>{
      const rows=await prisma.$queryRaw<Array<{verified:boolean}>>`SELECT sharkai_broker.owner_profit_verified(${userId}) AS verified`;
      return {CAPITAL:verified(rows.length===1 && rows[0].verified===true,
        'Потвърдени са отделната сметка за печалба, защитата на депозита и актуалният брокерски отчет.',
        'Липсва потвърдено отделяне на депозита или актуален отчет за уредената нетна печалба.')};
    }),
    check(['MANDATE'],async()=>{
      const m=await readOwnerMandates(owner);
      return {MANDATE:verified(m.active?.valid===true,'Потвърден е действащ мандат за същия собственик.','Няма валиден потвърден мандат.')};
    }),
    check(['W23','WORKER'],async()=>{
      const state=await readInvestmentWorkflow('order-gateway',profile,userId);
      const ready=state.status==='ok' && state.code==='AUTOMATED_WORKER_STATUS'
        && 'automated_worker' in (state.data ?? {}) && (state.data as {automated_worker?:string}).automated_worker==='awaiting_verified_signal';
      const intakeConfigured=ready && await collectorReady(userId);
      return {W23:verified(ready,'Проверена е готовността на защитения вход. Поръчка не е подавана.','Предварителните проверки не потвърдиха готова сметка.'),
        WORKER:verified(ready && intakeConfigured,'Проверени са правата, свързаната сметка, текущият риск и конфигурацията на източниците. Графикът се проверява отделно.',
          'Изпълнителят или удостоверените източници още не са потвърдени.')};
    }),
    check(['W30'],async()=>{
      const v=await readWalletOperation('onboarding',wallet);
      return {W30:verified(v.status==='ok' && ['VERIFIED_PROVIDER_REVIEW','ACCOUNT_LINKED'].includes(v.code),
        'Прочетен е свързан профил или статус на проверка при Wise.','Липсва доказан свързан профил или статус при Wise.')};
    }),
    check(['W32'],async()=>{
      const v=await readWalletOperation('deposit',wallet);
      return {W32:verified(v.status==='ok' && v.code==='VERIFIED_POSTED_DEPOSITS','Прочетено е проверено извлечение за избраната валута.','Няма проверено извлечение.')};
    }),
    check(['W33'],async()=>{
      const v=await readWalletOperation('withdrawal',wallet);
      const d=v.data as {provider_home?:string}|null;
      return {W33:verified(v.status==='needs_human' && v.code==='OWNER_CONFIRMS_AT_WISE' && d?.provider_home==='https://wise.com/home/',
        'Потвърден е маршрутът към Wise за действие от самия собственик.','Маршрутът за обвързан собственик още не е потвърден.')};
    }),
  ]);
  const current=await getWalletSettings(userId);
  return current?.aiAccess==='ANALYSIS_ONLY' && current.accessRevision===profile.accessRevision ? outputs : {};
}

const body=z.object({probe_id:z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,95}$/)}).strict();
async function readProbe(request:Request) {
  const reader=request.body?.getReader();
  if (!reader) return null;
  let expired=false;
  const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},1500);
  const chunks:Uint8Array[]=[];
  let bytes=0;
  try {
    for (;;) {
      const part=await reader.read();
      if (part.done) break;
      bytes+=part.value.byteLength;
      if (bytes>256) { await reader.cancel();return null; }
      chunks.push(part.value);
    }
    if (expired) return null;
    const parsed=body.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return parsed.success ? parsed.data.probe_id : null;
  } catch { return null; }
  finally {clearTimeout(timer);reader.releaseLock();}
}

async function diagnoseOwner(userId:string):Promise<Results> {
  const invest=await ownerChecks(userId);
  const checks:Results={};
  try {
    const consent=await readCommerceAgentAccess(userId);
    if(!consent.enabled) return invest;
    const rows=await prisma.$queryRaw<{currency:string|null}[]>`SELECT sharkai_commerce.current_store(${userId},NULL::text)->>'currency' AS currency`;
    const currency=rows[0]?.currency;
    const range=currency?commerceRange(new URLSearchParams({currency})):null;
    if(!range) return invest;
    const [store,products,settlement,stock]=await Promise.all([readCommerceDashboard(userId,range),readProductResearch(userId,{currency:range.currency}),
      readResaleSettlement(userId,range.currency),prisma.$queryRaw<{funding:boolean;stock:{items:{state:string}[];status:string}}[]>
        `SELECT (sharkai_commerce.resale_funding(${userId},${range.currency})->>'funding_verified')::boolean funding,sharkai_commerce.stock_dashboard(${userId}) stock`]);
    const stockReceived=stock[0]?.stock?.items?.some(item=>item.state==='received')===true;
    checks.SHOP_ORDERS=verified(store.status==='available' && (store.orders.length>0 || store.period_complete),
      'Потвърдени са поръчки или пълен отчет за периода.','Липсват потвърдени поръчки или пълен отчет.');
    checks.SHOP_CAPITAL=verified(stock[0]?.funding===true && store.capital.cash_minor!==null && store.capital.observed_at!==null,
      'Има потвърдена наличност за отделния търговски бюджет.','Липсва проверена наличност за магазина.');
    checks.SHOP_FULFILLMENT=verified(stockReceived || (store.shop.supplier_connected && store.orders.some(o=>['reviewed','accepted'].includes(o.fulfillment))),
      'Сверен е съществуващ преглед или приета заявка при доставчика.','Липсва потвърдена проверка на поръчка при доставчика.');
    checks.SHOP_PRODUCTS=verified(products.status!=='unavailable' && products.candidates.some(c=>c.status!=='insufficient_data'),
      'Проучването върна обосновани продуктови кандидати.','Липсва проверен каталог или независимо потвърдени данни.');
    checks.SHOP_SETTLEMENT=verified(settlement.period?.target_minor!=null && settlement.closed.some(w=>w.status==='allocated'||w.status==='no_profit'),
      'Сверени са седмичната цел и приключен отчет с решение по разпределението.','Липсва седмична цел или приключен отчет с решение на собственика.');
    checks.SHOP_PROCUREMENT=verified(stock[0]?.stock?.status==='available' && stock[0].stock.items.some(item=>['issued','received'].includes(item.state)),
      'Има потвърдена заявка за покупка за склад.','Липсва потвърдена заявка към договорен доставчик на стока за склад.');
    const current=await readCommerceAgentAccess(userId);
    if(!current.enabled||current.revision!==consent.revision) return invest;
  } catch {return invest;}
  return {...invest,...checks};
}
export async function runModuleDiagnostics(request:Request,probes={schema:schemaQuery,stripe:stripeSignature,owner:diagnoseOwner},env=process.env) {
  const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
  if (!financeServiceAuthorized(request,env.SHARKAI_WALLET_STATUS_SERVICE_SECRET ?? '')) return json({status:'forbidden'},403);
  if (request.headers.get('content-type')?.split(';')[0].trim()!=='application/json') return json({status:'invalid'},400);
  const probe=await readProbe(request);
  if (!probe) return json({status:'invalid'},400);
  const results:Results={W03:evidence('unverified','Каналът е отложен от собственика.')};
  try { results.DB=await probes.schema() ? evidence('passed','Базата отговори. Задължителните таблици и функции са налични.') : evidence('failed','Липсва част от изискваната схема.'); }
  catch { results.DB=evidence('failed','Няма проверена връзка с приложната база.'); }
  try { results.W39=probes.stripe(); } catch { results.W39=unavailable; }
  const owner=env.SHARKAI_DIAGNOSTIC_ACCOUNT_ID;
  if (owner && /^[A-Za-z0-9_-]{1,128}$/.test(owner) && results.DB.status==='passed') {
    try {Object.assign(results,await probes.owner(owner));}
    catch {for(const id of ['W04','W21','W23','W24','W25','W29','W30','W31','W32','W33','CAPITAL','MANDATE','WORKER','FEE'] as const) results[id]=unavailable;}
  }
  const checks=(Object.keys(definitions) as Id[]).map(id=>{
    const missing=id==='DB'||id==='CAPITAL'||id==='MANDATE'||id==='WORKER'||id==='FEE'||id==='STRATEGIES'||Number(id.slice(1))>20
      ? evidence('unverified','Липсва проверим резултат за разрешения диагностичен профил.') : untestedChannel;
    const channelDetail=id.startsWith('SHOP_')?'Нужни са свързан магазин, разрешение от собственика и потвърдени данни от доставчика.':missingChannel[id];
    return {id,label:definitions[id],...(results[id]??(channelDetail?evidence('unverified',channelDetail):missing))};
  });
  return json({contract:'sharkai-module-diagnostics-v1',probe_id:probe,checked_at:new Date().toISOString(),checks});
}
