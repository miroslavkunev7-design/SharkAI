import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PrismaClient, Prisma } from '@prisma/client';
import { handleBrokerWorker } from '../../lib/investments/order-worker.server';
import { makeProfitPacket, provisionProfitPolicy } from './profit-only-check.mts';

type Query=(sql:string,values?:readonly unknown[])=>Promise<{rows:Record<string,any>[]}>;
export async function setupBrokerWorkerFixtures(q:Query) {
  for (const file of ['investment-owner-mandates','investment-worker-approvals','investment-strategy-intake','investment-diagnostics','investment-profit-only']) {
    await q(await readFile(new URL('../../n8n/sql/'+file+'.sql',import.meta.url),'utf8'));
  }
  await q(`ALTER TABLE public."WalletInvestmentSettings" ADD "currency" text,ADD "authorizedAmountMinor" bigint,
    ADD "instrumentCode" text,ADD "strategyLabel" text,ADD "targetPeriod" text,ADD "targetDays" int,ADD "targetStartDate" date,
    ADD "targetAmountMinor" bigint,ADD "targetReturnBps" int,ADD "accessRevision" int DEFAULT 0,ADD "updatedAt" timestamp;
    CREATE TABLE public."Subscription"(id text,"userId" text,plan text,status text,"currentPeriodStart" timestamp,"currentPeriodEnd" timestamp)`);
}
export async function checkBrokerWorker(q:Query,db:PrismaClient) {
  let queryError:unknown;
  const sql=async(s:Prisma.Sql)=>{
    try { return (await db.$queryRaw<Array<{result:unknown}>>(s))[0].result; }
    catch (error) { queryError=error; throw error; }
  };
  const shared=randomBytes(32).toString('hex');
  const token=randomBytes(32).toString('base64url');
  const worker='private-test-worker';
  const credentialHash=createHash('sha256').update(token).digest('hex');
  for (const broker of ['IBKR','SAXO'] as const) {
    const account='worker-'+broker;
    const owner='fixture-'+account;
    const brokerKey=broker==='IBKR' ? 'U1000024' : 'acct+foo/bar=';
    const policy=randomUUID(),version=randomUUID();
    let job=randomUUID(),nonce=randomBytes(24).toString('base64url');
    const label='Exact strategy';
    await q(`INSERT INTO public."WalletInvestmentSettings"("userId","currency","authorizedAmountMinor","instrumentCode","strategyLabel",
      "targetPeriod","targetStartDate") VALUES ($1,'USD',800,'asset',$2,'DAY',current_date)`,[owner,label]);
    await q(`INSERT INTO public."Subscription" VALUES($1,$2,'PRO','active',current_timestamp-interval '1 day',current_timestamp+interval '1 day')`,['sub-'+owner,owner]);
    await q(`INSERT INTO sharkai_broker.account(id,user_id,provider,provider_key,currency,contractual_approval_at,ownership_verified_at,
      scope_verified_at,entitlement_cap_minor,snapshot_id,snapshot_at,exposure_minor,free_cash_minor,reconciled)
      VALUES($1,$2,$3,$4,'USD',now(),now(),now(),1000,'seed',now()-interval '1 minute',0,1000,true)`,[account,owner,broker,brokerKey]);
    await q("INSERT INTO sharkai_broker.asset(account_id,id,broker_instrument_id,held_units,enabled,reconciled_snapshot_id) VALUES($1,'asset',265598,0,true,'seed')",[account]);
    await q(`INSERT INTO sharkai_broker.mandate_policy(id,account_id,subscription_id,plan,strategy_label,allowed_assets,max_loss_minor,
      max_positions,approval_ref,approved_at,expires_at) VALUES($1,$2,$3,'PRO',$4,ARRAY['asset'],550,1,'fixture-risk-review',now(),now()+interval '1 hour')`,
    [policy,account,'sub-'+owner,label]);
    await q(`INSERT INTO sharkai_broker.worker_binding(worker_id,account_id,credential_ref,credential_sha256,
      credential_scope_approved_at,credential_expires_at,approved_until,approval_reference,verified_saxo_client_key)
      VALUES($1,$2,'tokenref',$3,now(),now()+interval '1 hour',now()+interval '1 hour','approved-fixture',$4)`,
    [worker,account,credentialHash,broker==='SAXO'?'client+key=':null]);
    const sourceId=randomUUID();
    await q(`INSERT INTO sharkai_broker.strategy_source(id,account_id,worker_id,asset_id,strategy_label,signal_collector,quote_collector,
      provider_instrument_id,currency,minor_unit_digits,asset_kind,min_units,max_units,quantity_step,price_tick,approval_reference,
      approved_at,expires_at) VALUES($1,$2,$3,'asset',$4,'strategy','broker-feed',265598,'USD',2,'STOCK',1,35,1,1,'fixture',now(),now()+interval '1 hour')`,
    [sourceId,account,worker,label]);
    const signalKey=randomBytes(32).toString('hex'),quoteKey=randomBytes(32).toString('hex');
    const profitKey=randomBytes(32).toString('hex'),auditor='profit-evidence-fixture';
    const env={SHARKAI_BROKER_WORKER_ENABLED:'true',SHARKAI_BROKER_EVIDENCE_ENABLED:'true',SHARKAI_ORDER_WORKER_KEYS:JSON.stringify({[worker]:shared}),
      SHARKAI_ORDER_SIGNAL_KEYS:JSON.stringify({strategy:signalKey}),SHARKAI_ORDER_QUOTE_KEYS:JSON.stringify({'broker-feed':quoteKey}),
      SHARKAI_ORDER_PROFIT_KEYS:JSON.stringify({[auditor]:profitKey}),
      SHARKAI_ORDER_WORKER_CREDENTIALS:JSON.stringify({tokenref:{broker,account_key:brokerKey,token}})};
    assert.equal((await q('SELECT sharkai_broker.owner_worker_status($1) AS enabled',['foreign-owner'])).rows[0].enabled,false);
    const post=async(kind:string,source:string,key:string,body:object)=>{
      const data=JSON.stringify(body);
      const t=String(Math.floor(Date.now()/1000));
      const sig=createHmac('sha256',Buffer.from(key,'hex')).update(['shark-order-v1',kind,source,t,data].join('\n')).digest('hex');
      const req=new Request('https://example.invalid/internal',{method:'POST',body:data,headers:{'content-type':'application/json',
        'x-shark-order-worker':source,'x-shark-order-time':t,'x-shark-order-signature':sig}});
      const received=await handleBrokerWorker(req,kind,env,sql,async()=>{throw new Error('Evidence cannot send an order');});
      if (received.status===503 && queryError) throw queryError;
      return received;
    };
    const protection=await provisionProfitPolicy(q,{user:owner,account,asset:'asset',worker,credentialHash,collector:auditor});
    const start={binding_id:sourceId,provider:broker,provider_account_key:brokerKey,currency:'USD',snapshot_id:'before-consent',
      observed_at:new Date().toISOString(),report_ref:'fixture-first',evidence_sha256:'a'.repeat(64),
      basis:'verified_complete_settled_no_margin_after_fees',settled_cash_minor:'1000',exposure_minor:'0',held_units:{asset:'0'},
      closed_jobs:[],performance:null};
    const readOffers=async()=>(await q(`SELECT sharkai_broker.owner_mandates($1,'public."WalletInvestmentSettings"'::regclass) AS r`,[owner])).rows[0].r;
    const packet=(snap:{snapshot_id:string;observed_at:string},cash:number,basis:number)=>makeProfitPacket({
      policy:protection,provider:broker,providerKey:brokerKey,snapshot:snap.snapshot_id,observedAt:snap.observed_at,cash,basis});
    assert.equal((await (await post('account-snapshot','broker-feed',quoteKey,start)).json()).status,'recorded');
    assert.equal((await readOffers()).offers.length,0);
    const firstPacket=packet(start,1000,0);
    assert.equal((await post('profit-evidence','broker-feed',quoteKey,firstPacket)).status,403);
    assert.equal((await post('profit-evidence',auditor,profitKey,{...firstPacket,borrowed_minor:'1'})).status,400);
    assert.equal((await post('profit-evidence',auditor,profitKey,{...firstPacket,policy_digest:'f'.repeat(64)})).ok,false);
    assert.equal((await (await post('profit-evidence',auditor,profitKey,firstPacket)).json()).status,'recorded');
    assert.equal((await (await post('profit-evidence',auditor,profitKey,firstPacket)).json()).status,'replayed');
    const ready=await readOffers();
    assert.equal(ready.offers.length,1);
    assert.equal((await q(`SELECT sharkai_broker.accept_owner_mandate($1,$2,$3,'public."WalletInvestmentSettings"'::regclass,$4) AS ok`,
      [owner,policy,ready.offers[0].digest,version])).rows[0].ok,true);
    const performance={consent_version:version,lifetime_net_minor:'0',window_net_minor:'0',
      window_start:new Date().toISOString().slice(0,10),window_end:new Date(Date.now()+86_400_000).toISOString().slice(0,10)};
    // JSON dates have millisecond precision; advance past the database's microsecond consent timestamp.
    const brokerTime=async()=>((await q('SELECT clock_timestamp() AS t FROM pg_sleep(0.01)')).rows[0].t as Date).toISOString();
    const initial={...start,snapshot_id:'s1',observed_at:await brokerTime(),report_ref:'fixture-net',performance};
    assert.equal((await (await post('account-snapshot','broker-feed',quoteKey,initial)).json()).status,'recorded');
    assert.equal((await (await post('profit-evidence',auditor,profitKey,packet(initial,1000,0))).json()).status,'recorded');
    assert.equal((await q('SELECT sharkai_broker.owner_worker_status($1) AS enabled',[owner])).rows[0].enabled,true);
    const diagnosticKeys={signals:['strategy'],quotes:['broker-feed'],profits:[auditor],workers:[worker],tokens:{
      tokenref:{digest:credentialHash,account:createHash('sha256').update(broker+'/'+brokerKey).digest('hex')},
    }};
    const diagnostic=async(subject:string,keys:unknown)=>(await q(
      'SELECT sharkai_broker.diagnostic_worker_binding($1,$2::jsonb) AS ok',[subject,JSON.stringify(keys)])).rows[0].ok;
    assert.equal(await diagnostic(owner,diagnosticKeys),true);
    assert.equal(await diagnostic(owner,{...diagnosticKeys,profits:[]}),false);
    assert.equal(await diagnostic(owner,{...diagnosticKeys,quotes:['wrong-collector']}),false);
    assert.equal(await diagnostic(owner,{...diagnosticKeys,tokens:{}}),false);
    assert.equal(await diagnostic('unknown-diagnostic-owner',diagnosticKeys),false);
    const stage=async(id:string,units:number,snapshot='s1',age=0,side:'BUY'|'SELL'='BUY')=>{
      const observed=new Date(Date.now()-age*1000);
      const terms={consent_version:version,snapshot_id:snapshot,asset_id:'asset',currency:'USD',provider_instrument_id:265598,
        side,kind:'LIMIT',units,limit_price_minor:100};
      const common={binding_id:sourceId,signal_id:id,observed_at:observed.toISOString(),provider:broker,provider_account_key:brokerKey,
        evidence_sha256:'b'.repeat(64),terms};
      const quote={...common,expires_at:new Date(observed.valueOf()+30_000).toISOString(),max_notional_minor:units*100,
        max_fee_minor:1,provider_enforced_no_short:true};
      assert.equal((await post('quote','strategy',signalKey,quote)).status,403);
      const first=await post('quote','broker-feed',quoteKey,quote);
      if (age>30) return assert.equal(first.status,409);
      assert.equal((await first.json()).status,'awaiting_evidence');
      assert.equal((await (await post('signal','strategy',signalKey,common)).json()).status,'queued');
      assert.equal((await (await post('signal','strategy',signalKey,common)).json()).status,'replayed');
      assert.equal((await post('quote','broker-feed',quoteKey,{...quote,max_fee_minor:0})).status,409);
    };
    const signed=(operation:string,id=job,n=nonce,sec=0,extra={},useKey=shared) => {
      const data=JSON.stringify({job_id:id,nonce:n,...extra});
      const t=String(Math.floor(Date.now()/1000)+sec);
      const sig=createHmac('sha256',Buffer.from(useKey,'hex')).update(['shark-order-v1',operation,worker,t,data].join('\n')).digest('hex');
      return new Request('https://example.invalid/internal',{method:'POST',body:data,headers:{'content-type':'application/json',
        'x-shark-order-worker':worker,'x-shark-order-time':t,'x-shark-order-signature':sig}});
    };
    let submissions=0, polls=0,uncertain=false;
    const transport:typeof fetch=async (input,opts) => {
      assert.equal(opts?.redirect,'error');
      assert.equal(new Headers(opts?.headers).get('authorization'),'Bearer '+token);
      const url=new URL(String(input));
      assert.equal(url.origin,broker==='IBKR'?'https://api.ibkr.com':'https://gateway.saxobank.com');
      if (opts?.method==='POST') {
        submissions++;
        const body=JSON.parse(String(opts.body));
        assert.equal(broker==='IBKR'?body.orders[0].acctId:body.AccountKey,brokerKey);
        if (uncertain) throw new Error('Disconnect after submit');
        return Response.json(broker==='IBKR'?[{order_id:'71',order_status:'Submitted'}]:{OrderId:'71'});
      }
      polls++;
      assert.equal(opts?.method,'GET');
      if (broker==='SAXO') { assert.equal(url.searchParams.get('ClientKey'),'client+key='); assert.equal(url.searchParams.get('AccountKey'),brokerKey); }
      return Response.json(broker==='IBKR' ? {order_id:'71',account:brokerKey,conid:265598,side:'B',total_size:3,cum_fill:3,order_status:'Filled'}
        : {Data:[{OrderId:'71',LogId:'90',ActivityTime:new Date().toISOString(),SubStatus:'Confirmed',AccountKey:brokerKey,
          Uic:265598,ClientKey:'client+key=',BuySell:'Buy',FilledAmount:3,Status:'FinalFill'}]});
    };
    const call=async(op:string,req:Request,config:Partial<NodeJS.ProcessEnv>=env)=>{
      const response=await handleBrokerWorker(req,op,config,sql,transport);
      if (response.status===503 && queryError) throw queryError;
      return response;
    };
    assert.equal((await call('submit',signed('submit'),{})).status,503);
    assert.equal((await call('submit',signed('submit',job,nonce,-30))).status,403);
    assert.equal((await call('submit',signed('poll'))).status,403);
    assert.equal((await call('submit',signed('submit',job,nonce,0,{capital:100000}))).status,403);
    assert.equal((await call('submit',signed('submit',job,nonce,0,{},randomBytes(32).toString('hex')))).status,403);
    const stale=randomUUID(),over=randomUUID();
    await stage(stale,2,'s1',90); await stage(over,15); await stage(job,3);
    const due=await q('SELECT * FROM sharkai_broker.list_worker_actions($1,true)',[worker]);
    assert.ok(due.rows.some(row=>row.job_id===job && row.operation==='submit' && row.dispatch_nonce===null));
    assert.equal((await call('submit',signed('submit',stale))).status,404);
    assert.equal((await call('submit',signed('submit',over))).status,409);
    assert.equal(submissions,0);
    const contender=randomUUID(),contenderNonce=randomBytes(24).toString('base64url');
    await stage(contender,3);
    const pair=await Promise.all([call('submit',signed('submit')),call('submit',signed('submit',contender,contenderNonce))]);
    assert.deepEqual(pair.map(x=>x.status).sort(),[200,409]);
    if (pair[1].ok) {job=contender;nonce=contenderNonce;}
    assert.equal((await (await call('submit',signed('submit'))).json()).status,'replayed');
    assert.equal(submissions,1);
    const pending=await q('SELECT * FROM sharkai_broker.list_worker_actions($1,false)',[worker]);
    assert.ok(pending.rows.every(row=>row.operation==='poll'));
    assert.ok(pending.rows.some(row=>row.job_id===job && row.operation==='poll' && row.dispatch_nonce===nonce));
    assert.equal((await call('poll',signed('poll',job,randomBytes(24).toString('base64url')))).status,409);
    assert.equal(polls,0);
    assert.equal((await (await call('poll',signed('poll'),{...env,SHARKAI_BROKER_WORKER_ENABLED:'false'})).json()).status,'FILLED');
    assert.equal(polls,1);
    const r=(await q("SELECT filled_units,reconciliation_required FROM sharkai_broker.order_ledger WHERE account_id=$1 AND request_key=$2",[account,'worker:'+job])).rows[0];
    assert.equal(r.filled_units,'3'); assert.equal(r.reconciliation_required,true);
    assert.equal((await call('poll',signed('poll'))).status,409);
    const snapshot={binding_id:sourceId,provider:broker,provider_account_key:brokerKey,currency:'USD',snapshot_id:'s2',
      observed_at:await brokerTime(),report_ref:'fixture-net2',evidence_sha256:'b'.repeat(64),
      basis:'verified_complete_settled_no_margin_after_fees',settled_cash_minor:'699',exposure_minor:'300',held_units:{asset:'3'},
      closed_jobs:[job],performance:{consent_version:version,lifetime_net_minor:'-1',window_net_minor:'-1',
        window_start:new Date().toISOString().slice(0,10),window_end:new Date(Date.now()+86_400_000).toISOString().slice(0,10)}};
    assert.equal((await post('account-snapshot','broker-feed',quoteKey,{...snapshot,performance:null})).status,409);
    assert.equal((await q("SELECT snapshot_id FROM sharkai_broker.account WHERE id=$1",[account])).rows[0].snapshot_id,'s1');
    assert.equal((await (await post('account-snapshot','broker-feed',quoteKey,snapshot)).json()).status,'recorded');
    assert.equal((await (await post('account-snapshot','broker-feed',quoteKey,snapshot)).json()).status,'replayed');
    const lossReport={...packet(snapshot,699,300),total_costs_minor:'1',mandate_closeout_minor:'-1',period_closeout_minor:'-1'};
    assert.equal((await (await post('profit-evidence',auditor,profitKey,lossReport)).json()).status,'recorded');
    assert.equal(await diagnostic(owner,diagnosticKeys),false);
    assert.equal((await q("SELECT reconciliation_required FROM sharkai_broker.order_ledger WHERE request_key=$1",['worker:'+job])).rows[0].reconciliation_required,false);
    const record=await q("SELECT * FROM sharkai_broker.worker_order WHERE id=$1",[job]);
    const unknownJob=randomUUID(),unknownNonce=randomBytes(24).toString('base64url');
    assert.equal(record.rows.length,1);
    const chasingLoss=randomUUID();
    await stage(chasingLoss,1,'s2');
    assert.equal((await call('submit',signed('submit',chasingLoss,randomBytes(24).toString('base64url')))).status,409);
    assert.equal(submissions,1);
    await stage(unknownJob,3,'s2',0,'SELL');
    uncertain=true;
    assert.equal((await call('submit',signed('submit',unknownJob,nonce))).status,409);
    assert.equal((await (await call('submit',signed('submit',unknownJob,unknownNonce))).json()).status,'UNKNOWN');
    assert.equal((await (await call('submit',signed('submit',unknownJob,unknownNonce))).json()).status,'replayed');
    assert.equal(submissions,2);
    await assert.rejects(q('UPDATE sharkai_broker.worker_order SET units=1 WHERE id=$1',[job]),/immutable/);
    await q('SELECT sharkai_broker.halt($1,$2)',[owner,account]);
    assert.equal(await diagnostic(owner,diagnosticKeys),false);
    assert.equal((await q('SELECT sharkai_broker.owner_worker_status($1) AS enabled',[owner])).rows[0].enabled,false);
    assert.equal((await call('submit',signed('submit',over,randomBytes(24).toString('base64url')))).status,409);
    assert.equal(submissions,2);
  }
  console.log('Broker worker verified on isolated PostgreSQL with signed commands, bounded mandates, fixed broker origins, single dispatch, provider fills, unknown states and halt.');
}
