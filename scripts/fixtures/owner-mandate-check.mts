import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { readOwnerMandates, confirmOwnerMandate } from '../../lib/investments/trading-consent.server';
import { revokeBrokerOwnerTrading } from '../../lib/investments/broker-owner-state.server';
import { makeProfitPacket, provisionProfitPolicy } from './profit-only-check.mts';

type Query = (sql:string,values?:readonly unknown[])=>Promise<{rows:Record<string,unknown>[]}>;

export async function checkOwnerMandate(q:Query,db:PrismaClient) {
  const owner={id:'mandate-acceptance-owner',plan:'PRO'};
  const foreign={id:'mandate-acceptance-another',plan:'PRO'};
  const account='mandate-acceptance-account';
  const instrument='EUR-fixture-stock';
  const pid=randomUUID();
  const previousFlag=process.env.SHARKAI_TRADING_CONSENT_ENABLED;
  const previousSecret=process.env.SHARKAI_TRADING_CONSENT_SECRET;
  try {
    process.env.SHARKAI_TRADING_CONSENT_ENABLED='true';
    process.env.SHARKAI_TRADING_CONSENT_SECRET=randomBytes(40).toString('base64url');
    await q(`INSERT INTO public."WalletInvestmentSettings"
      ("userId","currency","authorizedAmountMinor","instrumentCode","strategyLabel","targetPeriod","targetStartDate","targetAmountMinor","accessRevision","updatedAt")
      VALUES ($1,'EUR',10000,$2,'net-test','WEEK',current_date,500,1,now())`,[owner.id,instrument]);
    await q(`INSERT INTO public."Subscription"(id,"userId",plan,status,"currentPeriodStart","currentPeriodEnd")
      VALUES('mandate-sub',$1,'PRO','active',now()-interval '1 day',now()+interval '6 weeks')`,[owner.id]);
    await q(`INSERT INTO sharkai_broker.account(id,user_id,provider,provider_key,currency,contractual_approval_at,ownership_verified_at,
      scope_verified_at,entitlement_cap_minor,snapshot_id,snapshot_at,exposure_minor,free_cash_minor,reconciled)
      VALUES($1,$2,'IBKR','U1122334','EUR',now(),now(),now(),10000,'mandate-snap',date_trunc('milliseconds',now()),0,15000,true)`,[account,owner.id]);
    await q(`INSERT INTO sharkai_broker.asset VALUES($1,$2,312,0,true,'mandate-snap')`,[account,instrument]);
    await q(`INSERT INTO sharkai_broker.mandate_policy(id,account_id,subscription_id,plan,strategy_label,allowed_assets,
      max_loss_minor,max_positions,approval_ref,approved_at,expires_at) VALUES($1,$2,'mandate-sub','PRO','net-test',ARRAY[$3]::text[],
      800,1,'verified-fixture-only',now(),now()+interval '1 month')`,[pid,account,instrument]);

    assert.equal((await readOwnerMandates(owner,db)).offers.length,0);
    await q(`INSERT INTO sharkai_broker.worker_binding(worker_id,account_id,credential_ref,credential_sha256,credential_scope_approved_at,
      credential_expires_at,approved_until,approval_reference) VALUES('mandate-worker',$1,'fixture',repeat('a',64),now()-interval '1 hour',now()+interval '2 hours',now()+interval '2 hours','fixture')`,[account]);
    const protection=await provisionProfitPolicy(q,{user:owner.id,account,asset:instrument,worker:'mandate-worker',credentialHash:'a'.repeat(64),collector:'mandate-proof'});
    async function prove(snap:string,lifetime=0,period=0) {
      const snapshot=await q(`INSERT INTO sharkai_broker.verified_account_snapshot SELECT id,$2,repeat('b',64),'fixture-'||$2,repeat('c',64),snapshot_at
        FROM sharkai_broker.account WHERE id=$1 RETURNING observed_at`,[account,snap]);
      const observedAt=(snapshot.rows[0].observed_at as Date).toISOString();
      const packet={...makeProfitPacket({policy:protection,provider:'IBKR',providerKey:'U1122334',snapshot:snap,observedAt,cash:15000,basis:0}),currency:'EUR',
        gross_settled_gains_minor:'15000',mandate_closeout_minor:String(lifetime),period_closeout_minor:String(period)};
      const accepted=await q('SELECT sharkai_broker.accept_profit_evidence($1,$2,$3) AS result',['mandate-proof',packet,'f'.repeat(64)]);
      assert.equal(accepted.rows[0].result,'recorded');
    }
    await prove('mandate-snap');
    assert.equal((await readOwnerMandates(foreign,db)).offers.length,0);
    assert.equal((await readOwnerMandates({...owner,plan:'FREE'},db)).offers.length,0);
    const {offers}=await readOwnerMandates(owner,db);
    assert.equal(offers.length,1);
    const offer=offers[0];
    assert.equal(offer.terms.capital_minor,'10000');
    assert.equal(offer.terms.max_loss_minor,'800');
    assert.deepEqual(offer.terms.assets,[instrument]);
    assert.equal(await confirmOwnerMandate(owner,{review:offer.review,accepted:false},db),false);
    assert.equal(await confirmOwnerMandate(foreign,{review:offer.review,accepted:true},db),false);
    assert.equal(await confirmOwnerMandate(owner,{review:offer.review,accepted:true,capital_minor:'999999'},db),false);
    await q(`UPDATE public."Subscription" SET status='canceled' WHERE id='mandate-sub'`);
    assert.equal(await confirmOwnerMandate(owner,{review:offer.review,accepted:true},db),false);
    await q(`UPDATE public."Subscription" SET status='active' WHERE id='mandate-sub'`);
    assert.equal(await confirmOwnerMandate(owner,{review:offer.review,accepted:true},db),true);
    assert.equal((await readOwnerMandates(owner,db)).active?.valid,true);
    const version=String((await q('SELECT consent_version FROM sharkai_broker.account WHERE id=$1',[account])).rows[0].consent_version);
    const guard=async(snap:string,asset=instrument,fee=1)=>(await q(
      "SELECT sharkai_broker.mandate_allows_job($1,$2,$3,$4,'BUY',$5) AS ok",[account,version,asset,snap,fee])).rows[0].ok;
    assert.equal(await guard('mandate-snap'),false);
    async function record(snap:string,lifetime:number,windowNet:number) {
      await q("UPDATE sharkai_broker.account SET snapshot_id=$2,snapshot_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",[account,snap]);
      await q('UPDATE sharkai_broker.asset SET reconciled_snapshot_id=$2 WHERE account_id=$1',[account,snap]);
      await prove(snap,lifetime,windowNet);
      return (await q(`SELECT sharkai_broker.record_mandate_progress($1,'IBKR','U1122334',$2::uuid,$3,
        clock_timestamp(),$4,$5,current_date,current_date+7,'signed-fixture',$6) AS ok`,
        [account,version,snap,lifetime,windowNet,'e'.repeat(64)])).rows[0].ok;
    }
    assert.equal(await record('mandate-first',0,0),true);
    assert.equal(await guard('mandate-first'),true);
    assert.equal(await guard('mandate-first','other-asset'),false);
    await q(`UPDATE sharkai_broker.account SET entitlement_cap_minor=9999 WHERE id=$1`,[account]);
    assert.equal(await guard('mandate-first'),false);
    await q(`UPDATE sharkai_broker.account SET entitlement_cap_minor=10000 WHERE id=$1`,[account]);
    await q(`UPDATE public."Subscription" SET "currentPeriodEnd"=now()-interval '1 second' WHERE id='mandate-sub'`);
    assert.equal(await guard('mandate-first'),false);
    await q(`UPDATE public."Subscription" SET "currentPeriodEnd"=now()+interval '6 weeks' WHERE id='mandate-sub'`);
    await q(`UPDATE public."WalletInvestmentSettings" SET "authorizedAmountMinor"=9000 WHERE "userId"=$1`,[owner.id]);
    assert.equal(await guard('mandate-first'),false);
    await q(`UPDATE public."WalletInvestmentSettings" SET "authorizedAmountMinor"=10000 WHERE "userId"=$1`,[owner.id]);
    assert.equal(await record('mandate-positive',600,501),true);
    assert.equal((await q('SELECT target_state FROM sharkai_broker.account WHERE id=$1',[account])).rows[0].target_state,'REACHED');
    assert.equal(await record('mandate-retreat',-200,200),true);
    assert.equal((await q('SELECT target_state FROM sharkai_broker.account WHERE id=$1',[account])).rows[0].target_state,'REACHED');
    // Previous completed window already reached its goal. A current signed measurement arms the new window.
    await q(`UPDATE sharkai_broker.account SET target_window_start=target_window_start-interval '7 days',
      target_window_end=target_window_end-interval '7 days' WHERE id=$1`,[account]);
    assert.equal(await record('mandate-next-window',100,100),true);
    assert.equal((await q('SELECT target_state FROM sharkai_broker.account WHERE id=$1',[account])).rows[0].target_state,'PENDING');
    assert.equal(await record('mandate-loss',-800,-800),true);
    assert.equal(await guard('mandate-loss'),false);
    assert.equal(await record('mandate-recovery',1,1),true);
    assert.equal(await guard('mandate-recovery'),false);

    await db.$transaction(async tx=>{
      await revokeBrokerOwnerTrading(tx,owner.id);
      await tx.$executeRaw`UPDATE "WalletInvestmentSettings" SET "tradingConsentRevokedAt"=clock_timestamp(),"accessRevision"="accessRevision"+1 WHERE "userId"=${owner.id}`;
    });
    assert.equal((await readOwnerMandates(owner,db)).active,null);
    assert.equal(await confirmOwnerMandate(owner,{accepted:true,review:offer.review},db),false);
    const next=(await readOwnerMandates(owner,db)).offers[0];
    assert.ok(next);
    assert.equal(await confirmOwnerMandate(owner,{accepted:true,review:next.review},db),true);
    assert.equal(await guard('mandate-recovery'),false);
    assert.equal((await readOwnerMandates(foreign,db)).active,null);
    await q('SELECT sharkai_broker.halt($1,$2)',[owner.id,account]);
    assert.equal((await readOwnerMandates(owner,db)).active?.valid,false);
    console.log('Owner mandate acceptance passed: owner-bound signed review, current subscription and limits, risk and target latching, revoke, stale review rejection and fresh explicit regrant.');
  } finally {
    if (previousFlag===undefined) delete process.env.SHARKAI_TRADING_CONSENT_ENABLED;
    else process.env.SHARKAI_TRADING_CONSENT_ENABLED=previousFlag;
    if (previousSecret===undefined) delete process.env.SHARKAI_TRADING_CONSENT_SECRET;
    else process.env.SHARKAI_TRADING_CONSENT_SECRET=previousSecret;
  }
}
