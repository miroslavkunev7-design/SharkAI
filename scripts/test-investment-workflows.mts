import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { WalletInvestmentSettings } from '@prisma/client';
import { isInvestmentRead, readInvestmentWorkflow } from '../lib/investments/workflow-reads.server';
import type { InvestmentRead } from '../lib/investments/workflow-reads.server';
import { readBrokerForecastInput } from '../lib/investments/forecast-source.server';
import type { BrokerOwnerActivity } from '../lib/investments/broker-owner-state.server';
import { previousBrokerReportWeek, verifiedBrokerWeeklyReport } from '../lib/investments/weekly-report.server';
import { readAuthorizedFinanceStatus } from '../lib/wallet-investments-grants';

const filenames: Record<InvestmentRead,string> = {
  analysis:'W21-investment-analysis',
  'order-gateway':'W23-investment-order-gateway',
  reconciliation:'W24-investment-reconciliation',
  'weekly-report':'W25-investment-weekly-report',
  'kill-switch':'W29-investment-kill-switch',
};
const load = async (file:string) => JSON.parse(await readFile(new URL('../n8n/'+file,import.meta.url),'utf8'));
const now = new Date();
const observed = new Date(now.valueOf()-1_000).toISOString();
const owner = 'private-user-one';
const settings: WalletInvestmentSettings = {
  userId:owner,currency:'USD',authorizedAmountMinor:BigInt('12000'),aiAccess:'ANALYSIS_ONLY',accessRevision:3,
  instrumentCode:'EQUITY',strategyLabel:'long-term',targetPeriod:'DAY',targetDays:null,targetAmountMinor:null,targetReturnBps:null,
  targetStartDate:new Date('2026-06-01T00:00:00Z'),tradingConsentRevokedAt:null,updatedAt:now,
};
const week = previousBrokerReportWeek(now);
const report = verifiedBrokerWeeklyReport({userId:owner,providerAccountKey:'account',broker:'IBKR',currency:'USD'},{
  ownerUserId:owner,providerAccountKey:'account',broker:'IBKR',currency:'USD',ownershipVerified:true,complete:true,sourceId:'fixture',
  observedAt:observed,windowStart:week.window_start,windowEnd:week.window_end,realizedBeforeFeesMinor:'13300',
  unrealizedOpenMinor:'400',unrealizedCloseMinor:'700',feesMinor:'300',depositsMinor:'0',withdrawalsMinor:'0',
},now);
const closes = Array.from({length:62},(_,i)=>({
  date:new Date((Math.floor(now.valueOf()/86_400_000)-62+i)*86_400_000).toISOString().slice(0,10),
  units:(1_000_000+i*100).toString(),kind:'valued' as const,
}));
const verified = await readBrokerForecastInput(owner,{currency:'USD',instrumentCode:'EQUITY',strategyLabel:'long-term'},now,{
  SHARKAI_BROKER_FORECAST_ENABLED:'true',
},async ()=>({binding_ref:'scope-id',provider:'ibkr',currency:'USD',instrument_code:'EQUITY',strategy_label:'long-term',
  funding:{source:'ibkr_broker_settled_cash',cash_basis:'settled_cash_no_margin',available_minor:'19000',equity_minor:'29000'},
  funding_observed_at:observed,
  history:{source:'ibkr_portfolio_analyst_net_strategy',basis:'cash_flow_adjusted_after_fees',coverage:'complete_daily_calendar',
    valuation_basis:'unitized_strategy_nav',fee_coverage:{execution:'included',ongoing:'included',financing:'not_applicable',
      currencyConversion:'not_applicable'},applicable_capital_minor:{min:'10',max:'30000'},closes},
  history_observed_at:observed,weekly_report:null,weekly_observed_at:null}),async (scope,binding)=>{
    assert.equal(scope,owner); assert.equal(binding,'scope-id');
    return {status:'verified',currency:'USD',protected_principal_minor:'17000',settled_realized_profit_minor:'2000',
      available_profit_minor:'1900',unrealized_loss_minor:'100',observed_at:observed};
  });
assert.equal(verified.snapshot.status,'verified');
assert.equal(verified.snapshot.cash_available_minor,'19000');
assert.equal(verified.funding?.availableMinor,'1900');
const authState: BrokerOwnerActivity = {status:'available',accounts:[{
  provider:'ibkr',currency:'USD',halted_at:observed,reconciliation:'verified',snapshot_at:observed,
  positions:[{instrument:'private-asset',units:'2'}],recent_orders:[{
    instrument:'private-order-asset',side:'SELL',status:'WORKING',units:'1',filled_units:'0',recorded_at:observed,
    provider_observed_at:observed,reconciliation_required:true,
  }],
}]};
const sources = {forecast:async()=>({...verified,weeklyReport:report}),broker:async()=>authState};
const validGrant = 'headerheaderheader.payloadpayloadpayloadsignature.signaturesignaturesignature';
for (const operation of Object.keys(filenames) as InvestmentRead[]) {
  assert.ok(isInvestmentRead(operation));
  const flow=await load('workflows/'+filenames[operation]+'.json');
  assert.equal(flow.active,false);
  assert.equal(flow.settings.callerPolicy,'workflowsFromAList');
  assert.equal(flow.settings.callerIds,'y1RLdFfwaWSdsSGZ');
  assert.equal(flow.settings.saveDataSuccessExecution,'none');
  assert.equal(flow.settings.saveDataErrorExecution,'none');
  assert.equal(flow.settings.saveManualExecutions,false);
  assert.equal(flow.settings.saveExecutionProgress,false);
  const gate=flow.nodes.find((n:{name:string})=>n.name==='Приеми само разрешение за четене');
  const evaluate=(items:unknown[])=>new Function('$input',gate.parameters.jsCode)({all:()=>items})[0].json;
  assert.equal(evaluate([{json:{status_grant:validGrant}}]).allowed,true);
  assert.deepEqual(evaluate([{json:{status_grant:validGrant,userId:owner}}]),{allowed:false});
  assert.deepEqual(evaluate([{json:{status_grant:'plain'}}]),{allowed:false});
  assert.deepEqual(evaluate([{json:{status_grant:validGrant}},{json:{status_grant:validGrant}}]),{allowed:false});
  const gateIf=flow.nodes.find((n:{type:string})=>n.type==='n8n-nodes-base.if');
  const http=flow.nodes.find((n:{type:string})=>n.type==='n8n-nodes-base.httpRequest');
  assert.equal(flow.connections[gateIf.name].main[0][0].node,http.name);
  assert.notEqual(flow.connections[gateIf.name].main[1][0].node,http.name);
  assert.equal(http.parameters.method,'POST');
  assert.equal(http.parameters.url,'https://mm-auto-green.vercel.app/api/internal/wallet-investments/investment/'+operation);
  assert.equal(http.parameters.genericAuthType,'httpHeaderAuth');
  assert.equal(http.parameters.headerParameters.parameters[0].name,'X-Shark-Finance-Grant');
  assert.equal(http.parameters.jsonBody,'{}');
  assert.equal(http.parameters.options.redirect.redirect.followRedirects,false);
  const outputName=flow.connections[http.name].main[0][0].node;
  const runCode=flow.nodes.find((n:{name:string})=>n.name===outputName).parameters.jsCode;
  const normalize = (json:unknown) => new Function('$input',runCode)({first:()=>({json})})[0].json;
  const packet=await readInvestmentWorkflow(operation,settings,owner,sources);
  assert.equal(packet.status,operation==='order-gateway'?'blocked':'ok');
  assert.equal(packet.live_orders_enabled,false);
  assert.deepEqual(normalize({statusCode:200,body:packet}),packet);
  assert.equal(normalize({statusCode:403,body:packet}).data,null);
  assert.equal(normalize({statusCode:200,body:{...packet,operation:'bad'}}).data,null);
  assert.equal(normalize({statusCode:200,body:{...packet,live_orders_enabled:true}}).data,null);
  assert.equal((await readInvestmentWorkflow(operation,settings,'foreign',sources)).code,'OWNER_SCOPE_REQUIRED');
  assert.equal((await readInvestmentWorkflow(operation,{...settings,aiAccess:'OFF'},owner,sources)).code,'OWNER_SCOPE_REQUIRED');
  assert.ok(!JSON.stringify(packet).includes('private-order-asset') && !JSON.stringify(packet).includes('private-asset'));
}
assert.ok(!isInvestmentRead('submit-order'));
const armed = await readInvestmentWorkflow('order-gateway',settings,owner,sources,async()=>'awaiting_verified_signal');
assert.equal(armed.mode,'READ_ONLY');
assert.equal(armed.live_orders_enabled,false);
assert.equal(armed.code,'AUTOMATED_WORKER_STATUS');
const schema = JSON.parse(await readFile(new URL('../schemas/investment-order.schema.json',import.meta.url),'utf8'));
assert.equal(schema.additionalProperties,false);
for (const forbidden of ['authorized_capital','ownerId','currency','provider','credentials','allowedAssets']) {
  assert.equal(schema.properties[forbidden],undefined);
}
assert.equal(schema.properties.kind.const,'LIMIT');
assert.ok(schema.required.includes('limitPriceMinor'));
const oldService=process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET;
const oldSigning=process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET;
const service='local_test_secret_transport_1234567890';
process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET=service;
process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET='local_test_secret_signing_0987654321';
try {
  const endpoint='https://localhost/api/internal/wallet-investments/investment/analysis';
  const shouldNotRun=async()=>{throw new Error('No unverified projection allowed');};
  const status=async (headers:Record<string,string>,body?:string)=>
    (await readAuthorizedFinanceStatus(new Request(endpoint,{method:'POST',headers,...(body?{body}:{})}),shouldNotRun)).status;
  assert.equal(await status({},'{}'),403);
  assert.equal(await status({authorization:'Bearer '+service,'x-shark-finance-grant':validGrant},'{"foreign_owner":true}'),400);
  assert.equal(await status({authorization:'Bearer '+service,'x-shark-finance-grant':validGrant},' '.repeat(128)),400);
  assert.equal(await status({authorization:'Bearer '+service,'x-shark-finance-grant':validGrant},'{}'),403);
} finally {
  if (oldService === undefined) delete process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET;
  else process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET=oldService;
  if (oldSigning === undefined) delete process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET;
  else process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET=oldSigning;
}
console.log('Five read-only finance workflow graphs, scoped authorization, verified projections and limit-order schema passed.');
