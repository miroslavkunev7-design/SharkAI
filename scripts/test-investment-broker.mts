import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brokerClientReference, buildBrokerOrderRequest, buildBrokerPoll, parseBrokerAcknowledgement, parseBrokerPoll } from '../lib/investments/broker-protocols.server';
import type { BrokerReceiptBinding, BrokerSandboxTransport } from '../lib/investments/broker-protocols.server';
import { createBrokerOrderStore, exerciseBrokerPoll, exerciseBrokerSubmission } from '../lib/investments/broker-order-store.server';
import { orderFingerprint, planBrokerReservation, targetFromSettings } from '../lib/investments/order-boundary.server';
import type { BrokerOrderIntent, VerifiedBrokerContext } from '../lib/investments/order-boundary.server';
import { previousBrokerReportWeek, verifiedBrokerWeeklyReport } from '../lib/investments/weekly-report.server';
import { ingestBrokerForecastSource, readBrokerForecastInput } from '../lib/investments/forecast-source.server';
import type { AcceptResult } from '../lib/investments/forecast-source.server';
import { estimateInvestmentForecast } from '../lib/investments/forecast';
import { PrismaClient } from '@prisma/client';
import { readBrokerOwnerState, revokeBrokerOwnerTrading } from '../lib/investments/broker-owner-state.server';
import { checkBrokerWorker, setupBrokerWorkerFixtures } from './fixtures/investment-worker-check.mts';
import { checkOwnerMandate } from './fixtures/owner-mandate-check.mts';
import { checkResearchCohort } from './fixtures/research-strategies-check.mts';
import { checkProfitOnlyBoundary } from './fixtures/profit-only-check.mts';

const fixtureRoot = await realpath(process.env.SHARKAI_EMBEDDED_PG_ROOT ?? 'D:/SharkAI-workbench/telegram-db-test');
const localDependency = (file: string) => import(pathToFileURL(join(fixtureRoot,'node_modules',file)).href);
const { default: EmbeddedPostgres } = await localDependency('embedded-postgres/dist/index.js');
const { default: pg } = await localDependency('pg/lib/index.js');
const { initdb } = await localDependency('@embedded-postgres/windows-x64/dist/index.js');
const { gracefulExit } = await localDependency('exit-hook/index.js');
const fixture = await mkdtemp(join(fixtureRoot,'broker-acceptance-'));
assert.ok((await realpath(fixture)).toLowerCase().startsWith((fixtureRoot+sep).toLowerCase()));
const databaseDir=join(fixture,'pgdata');
const passwordFile=join(fixture,'fixture-password');
const password=randomBytes(24).toString('hex');
const owner='fixture_owner';
const listener=createServer();
await new Promise<void>((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));
const address=listener.address();
assert.ok(address && typeof address !== 'string');
const { port }=address;
await new Promise<void>((resolve,reject)=>listener.close(error=>error ? reject(error) : resolve()));
const engine=new EmbeddedPostgres({databaseDir,port,user:owner,password,persistent:true,
  postgresFlags:['-c','listen_addresses=127.0.0.1','-c','timezone=UTC'],onLog:()=>{},onError:()=>{}});
let pool: any;
let appDb: PrismaClient | undefined;
let started=false;
const ago=(milliseconds: number)=>new Date(Date.now()-milliseconds).toISOString();
const intent = (account: string, req: string, units=6): BrokerOrderIntent =>
  ({accountKey:account,requestKey:req,assetId:'fixture-asset',side:'BUY',kind:'LIMIT',units,limitPriceMinor:100});
const context = (order: BrokerOrderIntent, broker: 'IBKR'|'SAXO'='IBKR'): VerifiedBrokerContext => {
  const snapshotAt=ago(500);
  const providerAccountKey=broker==='IBKR'?'U1234567':'saxoFixture';
  return ({
  accountKey:order.accountKey,broker,providerAccountKey:broker==='IBKR'?'U1234567':'saxoFixture',
  authenticatedUserId:'test-owner',ownerUserId:'test-owner',
  configured:true,contractualApprovalVerified:true,providerAccountOwnershipVerified:true,providerAccountActive:true,allowOrderScope:true,
  liveOrdersEnabled:true,consent:{userId:'test-owner',accountKey:order.accountKey,version:'v1',expiresAt:ago(-100_000),
    revokedAt:null,authorizedAmountMinor:1000},entitlement:{allowsOrders:true,confirmedCapMinor:1000},currency:'USD',
  killSwitch:false,providerAccessRevoked:false,reconciliationStatus:'VERIFIED',unresolvedOrderCount:0,
  allowedAssetIds:['fixture-asset'],
  instrument:{assetId:'fixture-asset',providerInstrumentId:265598,currency:'USD',minorUnitDigits:2,minimumUnits:1,
    maximumUnits:20,quantityStep:1,priceTickMinor:5,supportedOrderKinds:['LIMIT','MARKET'],assetKind:'STOCK'},
  risk:{positionsExposureMinor:100,pendingBuyExposureMinor:0,freeCashMinor:1000,heldUnits:10,pendingSellUnits:0,maxDataAgeMs:60_000,snapshotAt},
  profitOnly:{snapshotAt,broker,providerAccountKey,currency:'USD',assetId:'fixture-asset',proofOfNonRecourseAndSegregation:true,
    fullyPaidLimitedLiabilityAsset:true,hardAllInFeeBound:true,settledGains:1500,settledLosses:200,costs:50,distributed:0,openCostBasis:100,
    unrealizedLoss:0,segregatedProfitCash:1000,performanceFeeHold:0,mandateMaxLossMinor:1000,
    lifetimeCloseoutPnl:0,periodCloseoutPnl:0,settledProfitOwnedUnits:10},
  quote:{broker,providerAccountKey:broker==='IBKR'?'U1234567':'saxoFixture',assetId:'fixture-asset',currency:'USD',
    intentFingerprint:orderFingerprint(order),observedAt:ago(250),expiresAt:ago(-20_000),
    maxOrderNotionalMinor:order.units*100,maxFeesMinor:10,providerEnforcedDebitCap:false,providerEnforcedNoShort:true},
  });
};

try {
  await writeFile(passwordFile,password+'\n',{mode:0o600});
  await promisify(execFile)(initdb,['--pgdata='+databaseDir,'--username='+owner,'--pwfile='+passwordFile,
    '--auth=scram-sha-256','--encoding=UTF8','--locale=C','--no-sync','--no-instructions']);
  await rm(passwordFile);
  await engine.start();
  started=true;
  pool=new pg.Pool({host:'127.0.0.1',port,user:owner,password,database:'postgres',max:4});
  const q=(sql: string,values: readonly unknown[]=[])=>pool.query(sql,[...values]);
  const localDb=new PrismaClient({datasourceUrl:'postgresql://'+owner+':'+password+'@127.0.0.1:'+port+'/postgres'});
  appDb=localDb;
  assert.deepEqual(await readBrokerOwnerState('test-owner',localDb),{status:'provider_unconfigured',accounts:[]});
  await localDb.$transaction(tx=>revokeBrokerOwnerTrading(tx,'test-owner'));
  await q((await readFile(new URL('../n8n/sql/investment-order-ledger.sql',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
  assert.equal((await q("SELECT sharkai_broker.owner_can_trade('test-owner') AS allowed")).rows[0].allowed,false);
  await q('CREATE TABLE public."WalletInvestmentSettings" ("userId" text PRIMARY KEY,"tradingConsentRevokedAt" timestamptz)');
  await q('INSERT INTO public."WalletInvestmentSettings" ("userId") VALUES ($1),($2),($3)',['test-owner','halt-owner','other-owner']);
  await q("INSERT INTO sharkai_broker.owner_application(settings_table) VALUES ('public.\"WalletInvestmentSettings\"'::regclass)");
  const store=createBrokerOrderStore(q);
  const seed=async (id: string, provider:'IBKR'|'SAXO', providerKey: string)=>q(
    `INSERT INTO sharkai_broker.account (id,user_id,provider,provider_key,currency,contractual_approval_at,ownership_verified_at,
      scope_verified_at,live_enabled,consent_version,consent_expires_at,consent_cap_minor,entitlement_cap_minor,target_state,
      snapshot_id,snapshot_at,exposure_minor,free_cash_minor,reconciled)
      VALUES ($1,'test-owner',$2,$3,'USD',now(),now(),now(),true,'v1',now()+interval '5 min',1000,1000,'NONE','s1',
      now()-interval '1 second',100,1000,true);
      `.replace(/;\s*$/,''),[id,provider,providerKey]).then(()=>q(
        "INSERT INTO sharkai_broker.asset (account_id,id,broker_instrument_id,held_units,enabled,reconciled_snapshot_id) VALUES ($1,$2,265598,10,true,'s1')",
        [id,'fixture-asset']));

  const order=intent('acct-one','order-one');
  const reportNow=new Date('2026-11-19T11:00:00Z');
  const reportWeek=previousBrokerReportWeek(reportNow);
  assert.deepEqual(reportWeek,{window_start:'2026-11-09T00:00:00.000Z',window_end:'2026-11-16T00:00:00.000Z'});
  const reportAccount={userId:'test-owner',providerAccountKey:'U1234567',broker:'IBKR' as const,currency:'USD'};
  const reportSnapshot={broker:'IBKR' as const,providerAccountKey:'U1234567',ownerUserId:'test-owner',
    ownershipVerified:true as const,complete:true as const,currency:'USD',sourceId:'fixture-report-1',
    observedAt:'2026-11-17T00:00:00Z',windowStart:reportWeek.window_start,windowEnd:reportWeek.window_end,
    realizedBeforeFeesMinor:'850',unrealizedOpenMinor:'100',unrealizedCloseMinor:'20',feesMinor:'25',
    depositsMinor:'10000',withdrawalsMinor:'500'};
  assert.equal(verifiedBrokerWeeklyReport(reportAccount,reportSnapshot,reportNow).net_minor,'745');
  assert.equal(verifiedBrokerWeeklyReport(reportAccount,{...reportSnapshot,ownerUserId:'other-user'},reportNow).status,'unavailable');
  assert.equal(verifiedBrokerWeeklyReport(reportAccount,null,reportNow).net_minor,null);
  const state=context(order);
  const fresh=planBrokerReservation(order,state,Date.now());
  assert.equal(fresh.status,'eligible_for_reservation');
  const proof=state.profitOnly!;
  const protectionBlock={status:'blocked',code:'PROFIT_PROTECTION_REQUIRED'};
  for (const p of [undefined,{...proof,proofOfNonRecourseAndSegregation:false},{...proof,hardAllInFeeBound:false},
    {...proof,fullyPaidLimitedLiabilityAsset:false},{...proof,settledGains:0},{...proof,distributed:1300},
    {...proof,settledLosses:1200},{...proof,segregatedProfitCash:609},{...proof,periodCloseoutPnl:-1},
    {...proof,lifetimeCloseoutPnl:-70},{...proof,unrealizedLoss:900},{...proof,performanceFeeHold:400},{...proof,mandateMaxLossMinor:709}]) {
    assert.deepEqual(planBrokerReservation(order,{...state,profitOnly:p},Date.now()),protectionBlock);
  }
  const exit={...order,side:'SELL' as const};
  const exitContext=context(exit);
  const exitProof={...exitContext.profitOnly!,periodCloseoutPnl:-1,settledProfitOwnedUnits:exit.units};
  assert.equal(planBrokerReservation(exit,{...exitContext,profitOnly:exitProof},Date.now()).status,'eligible_for_reservation');
  assert.deepEqual(planBrokerReservation(exit,{...exitContext,profitOnly:{...exitProof,settledProfitOwnedUnits:exit.units-1}},Date.now()),protectionBlock);
  assert.equal(planBrokerReservation(order,null,Date.now()).status,'blocked');
  assert.deepEqual(planBrokerReservation(order,{...state,killSwitch:true},Date.now()),{status:'blocked',code:'STOPPED'});
  assert.deepEqual(planBrokerReservation(order,{...state,quote:{...state.quote!,observedAt:ago(65_000)}},Date.now()),
    {status:'blocked',code:'MARKET_DATA_UNAVAILABLE'});
  const savedTarget={targetStartDate:new Date('2028-01-31T00:00:00Z'),targetAmountMinor:BigInt(250),targetReturnBps:null};
  assert.equal(targetFromSettings({...savedTarget,targetPeriod:'DAY',targetDays:null})?.windowEnd,'2028-02-01T00:00:00.000Z');
  assert.equal(targetFromSettings({...savedTarget,targetPeriod:'CUSTOM_DAYS',targetDays:3})?.windowEnd,'2028-02-03T00:00:00.000Z');
  assert.equal(targetFromSettings({...savedTarget,targetPeriod:'WEEK',targetDays:null})?.windowEnd,'2028-02-07T00:00:00.000Z');
  assert.equal(targetFromSettings({...savedTarget,targetPeriod:'MONTH',targetDays:null})?.windowEnd,'2028-02-29T00:00:00.000Z');
  for(const period of ['DAY','CUSTOM_DAYS','WEEK','MONTH'] as const) {
    const target={period,windowStart:ago(3600_000),windowEnd:ago(-3600_000),targetReturnBps:100};
    const targetMeasurement={broker:'IBKR' as const,providerAccountKey:state.providerAccountKey,ownershipVerified:true as const,currency:'USD',
      windowStart:target.windowStart,windowEnd:target.windowEnd,observedAt:ago(400),openingEquityMinor:10000,latestEquityMinor:11000,
      externalContributionsMinor:900,externalWithdrawalsMinor:0};
    assert.deepEqual(planBrokerReservation(order,{...state,target,targetMeasurement},Date.now()),{status:'blocked',code:'TARGET_REACHED'});
    assert.equal(planBrokerReservation(order,{...state,target,targetMeasurement:{...targetMeasurement,externalContributionsMinor:950}},Date.now()).status,
      'eligible_for_reservation');
  }

  assert.equal(parseBrokerAcknowledgement('IBKR',{status:200,body:[{id:'review-me',message:['review required']}]},'ref').status,'REVIEW_REQUIRED');
  assert.equal(parseBrokerAcknowledgement('IBKR',{status:200,body:[{order_id:'490',order_status:'Inactive'}]},'ref').status,'UNKNOWN');
  assert.equal(parseBrokerAcknowledgement('SAXO',{status:200,body:{ErrorInfo:{ErrorCode:'TradeNotCompleted'}}},'ref').status,'UNKNOWN');
  assert.deepEqual(parseBrokerAcknowledgement('SAXO',{status:202,body:{OrderId:'202',ErrorInfo:{ErrorCode:'TradeNotCompleted'}}},'ref'),
    {status:'UNKNOWN',reason:'AMBIGUOUS',orderId:'202'});
  assert.equal(parseBrokerAcknowledgement('SAXO',{status:400,body:{ErrorInfo:{ErrorCode:'OrderSizeTooSmall'}}},'ref').status,
    'REJECTED_BY_PROVIDER');
  const saxoOrder=intent('acct-two','saxo-one');
  const saxoState=context(saxoOrder,'SAXO');
  const saxoPlan=planBrokerReservation(saxoOrder,saxoState,Date.now());
  assert.equal(saxoPlan.status,'eligible_for_reservation');
  if (saxoPlan.status!=='eligible_for_reservation') throw new Error('Invalid Saxo fixture');
  const saxoReq=buildBrokerOrderRequest(saxoOrder,saxoPlan,saxoState.instrument);
  assert.equal(saxoReq?.request.path,'/trade/v2/orders');
  assert.deepEqual(saxoReq?.request.body,{AccountKey:'saxoFixture',Uic:265598,AssetType:'Stock',Amount:6,BuySell:'Buy',OrderType:'Limit',
    ManualOrder:false,OrderDuration:{DurationType:'DayOrder'},ExternalReference:saxoReq.clientReference,OrderPrice:1});
  assert.equal(buildBrokerOrderRequest(saxoOrder,saxoPlan,{...saxoState.instrument,assetKind:'ETF'}),null);

  await seed(order.accountKey,'IBKR','U1234567');
  await seed(saxoOrder.accountKey,'SAXO','saxoFixture');
  await q('CREATE ROLE broker_untrusted NOLOGIN');
  assert.equal((await q("SELECT has_schema_privilege('broker_untrusted','sharkai_broker','USAGE') AS allowed")).rows[0].allowed,false);

  let sends=0;
  const transport: BrokerSandboxTransport={execute:async req=>{
    assert.equal(req.path,'/iserver/account/U1234567/orders');
    const sent=req.body as {orders: Array<{cOID:string;quantity:number;price:number}>};
    assert.equal(sent.orders[0].quantity,6);
    assert.equal(sent.orders[0].price,1);
    sends++;
    return {status:200,body:[{order_id:'101',order_status:'Submitted',local_order_id:sent.orders[0].cOID}]};
  }};
  const competing=intent(order.accountKey,'order-competing');
  const choices=await Promise.all([
    exerciseBrokerSubmission(order,state,'s1',store,transport),
    exerciseBrokerSubmission(competing,context(competing),'s1',store,transport),
  ]);
  assert.equal(sends,1);
  assert.deepEqual(choices.map(r=>r.status).sort(),['ACKNOWLEDGED','blocked']);
  const chosen=choices[0].status==='ACKNOWLEDGED' ? order : competing;
  const chosenContext=context(chosen);
  const repeat=await exerciseBrokerSubmission(chosen,chosenContext,'s1',store,transport);
  assert.equal(repeat.status,'replayed');
  const conflict={...chosen,units:5};
  assert.deepEqual(await exerciseBrokerSubmission(conflict,context(conflict),'s1',store,transport),
    {status:'blocked',code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(sends,1);

  const binding:BrokerReceiptBinding={broker:'IBKR',providerAccountKey:'U1234567',providerOrderId:'101',instrumentId:265598,units:6,side:'BUY'};
  const fill={order_id:101,account:'U1234567',conid:265598,side:'B',total_size:'6.0',cum_fill:'6.0',order_status:'Filled'};
  let fillResponse=fill;
  const poll:BrokerSandboxTransport={execute:async req=>{
    assert.equal(req.path,'/iserver/account/order/status/101');
    return {status:200,body:fillResponse};
  }};
  fillResponse={...fill,account:'WRONG'};
  assert.equal(await exerciseBrokerPoll(chosen.accountKey,chosen.requestKey,binding,store,poll),'unavailable');
  fillResponse=fill;
  assert.equal(await exerciseBrokerPoll(chosen.accountKey,chosen.requestKey,binding,store,poll),'recorded');
  assert.equal(await exerciseBrokerPoll(chosen.accountKey,chosen.requestKey,binding,store,poll),'replayed');
  const after=intent(order.accountKey,'next',1);
  assert.deepEqual(await exerciseBrokerSubmission(after,context(after),'s1',store,transport),
    {status:'blocked',code:'RECONCILIATION_REQUIRED'});
  assert.equal((await q("SELECT sharkai_broker.reconcile_snapshot($1,'IBKR','U1234567','s2',clock_timestamp(),700,400,$2::jsonb,$3::text[]) AS closed",
    [chosen.accountKey,JSON.stringify({'fixture-asset':16}),[chosen.requestKey]])).rows[0].closed,true);
  assert.equal((await q('SELECT reconciliation_required FROM sharkai_broker.order_ledger WHERE account_id=$1 AND request_key=$2',
    [chosen.accountKey,chosen.requestKey])).rows[0].reconciliation_required,false);
  await q("UPDATE sharkai_broker.account SET target_id='target-1',target_window_start=now()-interval '1 hour',"+
    "target_window_end=now()+interval '1 hour',target_state='UNKNOWN' WHERE id=$1",[chosen.accountKey]);
  const updateTarget=async (targetState: string)=> (await q(
    "SELECT sharkai_broker.record_target_progress($1,'IBKR','U1234567','target-1',clock_timestamp(),$2) AS recorded",
    [chosen.accountKey,targetState])).rows[0].recorded;
  assert.equal(await updateTarget('REACHED'),true);
  assert.equal(await updateTarget('PENDING'),false);
  assert.deepEqual(await exerciseBrokerSubmission(after,context(after),'s2',store,transport),
    {status:'blocked',code:'TARGET_REACHED'});
  assert.equal(await store.halt('other-user',order.accountKey),false);
  assert.equal(await store.halt('test-owner',order.accountKey),true);
  assert.deepEqual(await exerciseBrokerSubmission(after,context(after),'s2',store,transport),
    {status:'blocked',code:'LIVE_DISABLED'});

  let unknownSends=0;
  const unreachable:BrokerSandboxTransport={execute:async()=>{unknownSends++;throw new Error('connection interrupted');}};
  assert.equal((await exerciseBrokerSubmission(saxoOrder,saxoState,'s1',store,unreachable)).status,'UNKNOWN');
  assert.equal((await exerciseBrokerSubmission(saxoOrder,saxoState,'s1',store,unreachable)).status,'replayed');
  const anotherSaxo=intent(saxoOrder.accountKey,'saxo-two',1);
  assert.deepEqual(await exerciseBrokerSubmission(anotherSaxo,context(anotherSaxo,'SAXO'),'s1',store,unreachable),
    {status:'blocked',code:'RECONCILIATION_REQUIRED'});
  assert.equal(unknownSends,1);
  const saxoBinding:BrokerReceiptBinding={...binding,broker:'SAXO',providerAccountKey:'saxoFixture',verifiedClientKey:'saxoClient'};
  assert.deepEqual(buildBrokerPoll(saxoBinding)?.query,{OrderId:'101',EntryType:'Last',AccountKey:'saxoFixture',
    ClientKey:'saxoClient',IncludeSubAccounts:'false'});
  assert.equal(parseBrokerPoll(saxoBinding,{status:200,body:{Data:[{OrderId:'101',LogId:'201',ActivityTime:ago(20),
    AccountKey:'saxoFixture',Uic:265598,Status:'FinalFill',SubStatus:'Confirmed',FilledAmount:6}]}}).state,'FILLED');
  assert.equal(brokerClientReference('IBKR',chosen.accountKey,chosen.requestKey).length,46);

  await q(await readFile(new URL('../n8n/sql/investment-forecast-sources.sql',import.meta.url),'utf8'));
  await q(`insert into sharkai_forecast.binding
    (id,connector_key,user_id,provider,account_key,currency,instrument_code,strategy_label,ownership_verified_at,
      strategy_isolation_verified_at,provider_read_approved_at,strategy_history_from,expires_at)
    values ('broker-binding-one','worker-one','test-owner','saxo','saxo-verified-account','USD','EQUITY','strategy-01',
      now(),now(),now(),date '2000-01-01',now()+interval '1 hour')`);
  const fixtureKey=randomBytes(32);
  const enabledEnv={SHARKAI_BROKER_FORECAST_ENABLED:'true',
    SHARKAI_BROKER_FORECAST_CONNECTOR_KEYS:JSON.stringify({'worker-one':fixtureKey.toString('hex')})};
  const packetBase={binding_id:'broker-binding-one',provider:'saxo',provider_account_key:'saxo-verified-account',
    currency:'USD',instrument_code:'EQUITY',strategy_label:'strategy-01',provider_report_id:'provider-evidence-one',
    provider_evidence_sha256:'a'.repeat(64)};
  const packet={...packetBase,kind:'funding',snapshot_id:'f-one',observed_at:ago(2000),
    data:{source:'saxo_broker_settled_cash',cash_basis:'settled_cash_no_margin',available_minor:'12900',equity_minor:'14000'}};
  const ingest=async (value: object, options:{tamper?:boolean; signedAge?:number}={})=>{
    const content=JSON.stringify(value);
    const signedAt=Math.floor((Date.now()-(options.signedAge??0))/1000).toString();
    const signature=createHmac('sha256',fixtureKey).update('sharkai-broker-forecast/v1\nworker-one\n'+signedAt+'\n')
      .update(content).digest('hex');
    return await ingestBrokerForecastSource(new Request('https://localhost/api/internal/wallet-investments/forecast-source',{
      method:'POST',body:options.tamper?content+' ':content,headers:{'x-shark-forecast-connector':'worker-one',
        'x-shark-forecast-signed-at':signedAt,'x-shark-forecast-signature':signature}}),
    enabledEnv,async (connector,body,hash) => (await q(
      'select sharkai_forecast.accept_snapshot($1,$2::jsonb,$3) AS returned',[connector,body,hash]
    )).rows[0].returned as AcceptResult);
  };
  assert.equal((await ingest(packet,{tamper:true})).status,403);
  assert.equal((await ingest(packet,{signedAge:65_000})).status,403);
  assert.equal((await ingest({...packet,provider_account_key:'foreign-broker-account'})).status,403);
  assert.equal((await ingest({...packet,data:{...packet.data,source:'saxo_unsettled_margin_cash'}})).status,400);
  assert.equal((await ingest(packet)).status,201);
  assert.equal((await ingest(packet)).status,200);
  assert.equal((await ingest({...packet,data:{...packet.data,available_minor:'99999'}})).status,409);

  const closes=Array.from({length:62},(_,i)=>({date:new Date(
    (Math.floor(Date.now()/86_400_000)-62+i)*86_400_000).toISOString().slice(0,10),
  units:(1_000_000+i).toString(),kind:'valued'}));
  const terminalCloses=closes.map((row,index)=>index===closes.length-1?{...row,units:'0'}:row);
  const historyPacket={...packetBase,kind:'history',snapshot_id:'h-one',observed_at:ago(1000),
    data:{source:'saxo_account_history_net_strategy',basis:'cash_flow_adjusted_after_fees',coverage:'complete_daily_calendar',
      valuation_basis:'unitized_strategy_nav',fee_coverage:{execution:'included',ongoing:'included',
        financing:'not_applicable',currencyConversion:'not_applicable'},applicable_capital_minor:{min:'1000',max:'100000'},closes:terminalCloses}};
  assert.equal((await ingest({...historyPacket,data:{...historyPacket.data,closes:closes.filter((_,i)=>i!==10)}})).status,400);
  assert.equal((await ingest({...historyPacket,data:{...historyPacket.data,closes:closes.map((row,i)=>i===10?{...row,units:'0'}:row)}})).status,400);
  assert.equal((await ingest(historyPacket)).status,201);
  const weekWindow=previousBrokerReportWeek(new Date());
  const weeklyPacket={...packetBase,kind:'weekly_report',snapshot_id:'w-one',observed_at:ago(500),
    data:{source:'saxo_verified_weekly_report',complete:true,...weekWindow,realized_before_fees_minor:'2300',unrealized_open_minor:'100',
      unrealized_close_minor:'50',fees_minor:'50',deposits_minor:'250',withdrawals_minor:'50'}};
  assert.equal((await ingest({...weeklyPacket,data:{...weeklyPacket.data,window_end:weeklyPacket.data.window_start}})).status,400);
  assert.equal((await ingest(weeklyPacket)).status,201);
  const lookup=async (...values: (string|null)[]) => (await q(
    'select sharkai_forecast.read_source($1,$2,$3,$4) AS returned',values
  )).rows[0].returned as unknown;
  const saved={currency:'USD',instrumentCode:'EQUITY',strategyLabel:'strategy-01'};
  const budgetLookup=async (user:string,binding:string)=>(await q(
    'select sharkai_broker.owner_profit_budget($1::text,$2::text) AS returned',[user,binding]
  )).rows[0].returned as unknown;
  const read=(user:string,selection:{currency:string;instrumentCode:string|null;strategyLabel:string|null}=saved)=>
    readBrokerForecastInput(user,selection,new Date(),enabledEnv,lookup,budgetLookup);
  const ownerSource=await read('test-owner');
  const autoSelection = {currency:'USD',instrumentCode:null,strategyLabel:null};
  assert.equal((await read('test-owner',autoSelection)).history?.strategyLabel,'strategy-01');
  assert.equal((await read('another-owner',autoSelection)).funding,null);
  await q(`INSERT INTO sharkai_forecast.binding
    SELECT 'broker-binding-second',connector_key,user_id,provider,'second-fixture-account',currency,
      instrument_code,'another-strategy',ownership_verified_at,strategy_isolation_verified_at,
      provider_read_approved_at,strategy_history_from,expires_at,revoked_at
    FROM sharkai_forecast.binding WHERE id='broker-binding-one'`);
  assert.equal((await read('test-owner',autoSelection)).funding,null);
  assert.equal((await read('test-owner')).history?.strategyLabel,'strategy-01');
  assert.equal(ownerSource.snapshot.status,'verified');
  assert.equal(ownerSource.snapshot.cash_available_minor,'12900');
  assert.equal(ownerSource.snapshot.profit_budget.available_profit_minor,'0');
  assert.equal(ownerSource.funding,null);
  assert.equal(ownerSource.history?.closes.length,62);
  assert.equal(ownerSource.history?.accountRef,'broker-binding-one');
  assert.equal(ownerSource.history?.closes.at(-1)?.units,'0');
  assert.equal(ownerSource.weeklyReport.net_minor,'2200');
  assert.equal(estimateInvestmentForecast({...saved,ownerId:'test-owner',horizonDays:1,authorizedAmountMinor:'12000',
    funding:ownerSource.funding,history:ownerSource.history}).authorized_funded_minor,'0');
  assert.equal((await read('foreign-app-user')).snapshot.status,'provider_unlinked');
  assert.equal((await read('test-owner',{...saved,currency:'EUR'})).history,null);
  await q("UPDATE sharkai_forecast.binding SET revoked_at=clock_timestamp() WHERE id='broker-binding-one'");
  assert.equal((await read('test-owner')).funding,null);
  assert.equal((await ingest(packet)).status,403);

  await seed('halt-owner-first','IBKR','U1000081');
  await seed('halt-owner-second','IBKR','U1000082');
  await seed('halt-other-owner','IBKR','U1000083');
  await q("UPDATE sharkai_broker.account SET user_id='halt-owner' WHERE id IN ('halt-owner-first','halt-owner-second')");
  await q("UPDATE sharkai_broker.account SET user_id='other-owner' WHERE id='halt-other-owner'");
  const reserveHalt = (accountKey: string, requestKey: string, user = 'halt-owner') => store.reserve({
    user,intent:intent(accountKey,requestKey,1),providerInstrument:265598,maxBuyDebitMinor:110,
    clientReference:brokerClientReference(accountKey==='halt-owner-future'?'SAXO':'IBKR',accountKey,requestKey),
    consentVersion:'v1',quoteAt:ago(100),
    quoteExpiresAt:ago(-20_000),snapshotId:'s1',
  });
  assert.equal((await reserveHalt('halt-owner-first','old-reserved')).status,'reserved');
  assert.equal((await reserveHalt('halt-owner-second','old-claimed')).status,'reserved');
  assert.equal(await store.claim('halt-owner-second','old-claimed','s1'),true);
  assert.deepEqual((await readBrokerOwnerState('halt-owner',localDb)).accounts.map(a=>[a.reconciliation,a.positions?.[0]?.units]),[
    ['verified','10'],['pending',undefined],
  ]);
  const initialActivity=await readBrokerOwnerState('halt-owner',localDb);
  assert.equal(initialActivity.accounts[1].recent_orders[0].status,'SUBMITTING');
  assert.equal(initialActivity.accounts[1].recent_orders[0].provider_observed_at,null);
  assert.equal(JSON.stringify(initialActivity).includes('U1000082'),false);
  assert.deepEqual(await readBrokerOwnerState('missing-owner',localDb),{status:'provider_unlinked',accounts:[]});
  await q("UPDATE sharkai_broker.asset SET reconciled_snapshot_id=NULL WHERE account_id='halt-owner-first'");
  const incomplete=(await readBrokerOwnerState('halt-owner',localDb)).accounts[0];
  assert.equal(incomplete.reconciliation,'unavailable');
  assert.equal(incomplete.positions,null);
  await q("UPDATE sharkai_broker.asset SET reconciled_snapshot_id='s1' WHERE account_id='halt-owner-first'");
  await assert.rejects(localDb.$transaction(async tx=>{
    await revokeBrokerOwnerTrading(tx,'halt-owner');
    throw new Error('intentional rollback');
  }),/intentional rollback/);
  assert.equal((await readBrokerOwnerState('halt-owner',localDb)).accounts[0].halted_at,null);

  // Hold the revoke transaction open while another connection attempts to claim.
  let staged!:()=>void;
  const revocationWritten=new Promise<void>(resolve=>{staged=resolve;});
  let commit!:()=>void;
  const commitGate=new Promise<void>(resolve=>{commit=resolve;});
  const revoked=localDb.$transaction(async tx=>{
    await revokeBrokerOwnerTrading(tx,'halt-owner');
    await tx.$executeRaw`UPDATE "WalletInvestmentSettings" SET "tradingConsentRevokedAt"=clock_timestamp() WHERE "userId"='halt-owner'`;
    staged();
    await commitGate;
  },{timeout:5_000});
  await Promise.race([revocationWritten,revoked]);
  const competitor=await pool.connect();
  const pid=(await competitor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const competingClaim=competitor.query(
    "SELECT sharkai_broker.claim_submission('halt-owner-first','old-reserved','s1') AS claimed",
  ).finally(()=>competitor.release());
  let waited=false;
  try {
    for (let i=0;i<50&&!waited;i++) {
      waited=(await q("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting",
        [pid])).rows[0].waiting;
      if (!waited) await new Promise(resolve=>setTimeout(resolve,25));
    }
  } finally {
    commit();
  }
  await revoked;
  assert.equal((await competingClaim).rows[0].claimed,false);
  assert.equal(waited,true);
  assert.deepEqual((await readBrokerOwnerState('halt-owner',localDb)).accounts.map(account=>account.recent_orders[0].status),
    ['VOIDED','SUBMITTING']);
  await q("UPDATE sharkai_broker.order_ledger SET state='UNKNOWN',provider_observed_at=clock_timestamp() WHERE account_id='halt-owner-second'");
  const uncertain=(await readBrokerOwnerState('halt-owner',localDb)).accounts[1].recent_orders[0];
  assert.equal(uncertain.status,'UNKNOWN');
  assert.equal(uncertain.provider_observed_at,null);
  assert.equal((await readBrokerOwnerState('other-owner',localDb)).accounts[0].halted_at,null);
  assert.equal((await reserveHalt('halt-other-owner','other-new','other-owner')).status,'reserved');
  await seed('halt-owner-future','SAXO','afterRevokeFixture');
  await q("UPDATE sharkai_broker.account SET user_id='halt-owner' WHERE id='halt-owner-future'");
  assert.deepEqual(await reserveHalt('halt-owner-future','future-account'),{status:'blocked',code:'STOPPED'});
  await q('CREATE SCHEMA wrong_deployment');
  await q('CREATE TABLE wrong_deployment."WalletInvestmentSettings" ("userId" text PRIMARY KEY,"tradingConsentRevokedAt" timestamptz)');
  await assert.rejects(localDb.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL search_path = wrong_deployment, public`;
    await revokeBrokerOwnerTrading(tx,'other-owner');
  }),/BROKER_REVOCATION_UNAVAILABLE/);
  assert.equal((await readBrokerOwnerState('other-owner',localDb)).accounts[0].halted_at,null);
  console.log('Broker owner control passed: same-DB boundary, atomic rollback, concurrent claim fencing, owner-only activity and isolated halt.');
  await setupBrokerWorkerFixtures(q);
  await checkBrokerWorker(q,localDb);
  await checkOwnerMandate(q,localDb);
  await checkResearchCohort(q);
  await checkProfitOnlyBoundary(q);

  console.log('Investment broker tests passed: explicit consent, size/capital/target gates, concurrent reservations, replay, provider protocol, uncertainty, reconciled fills, and halt.');
  console.log('Broker forecast tests passed: signature integrity, stale/replayed events, account and owner binding, settled cash, net history, and revocation.');
} finally {
  if (appDb) await appDb.$disconnect();
  if (pool) await pool.end();
  if (started) await engine.stop();
  assert.ok((await realpath(fixture)).toLowerCase().startsWith((fixtureRoot+sep).toLowerCase()));
  await rm(fixture,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
gracefulExit(0);
