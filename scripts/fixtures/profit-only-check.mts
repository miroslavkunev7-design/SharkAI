import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
type Query=(sql:string,values?:unknown[])=>Promise<{rows:Record<string,any>[]}>;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
type Policy={id:string;digest:string};
export async function provisionProfitPolicy(q:Query,input:{user:string;account:string;asset:string;worker:string;credentialHash:string;collector:string}):Promise<Policy> {
  const id=randomUUID(), contract=digest('isolated-test-contract-'+id);
  await q(`INSERT INTO sharkai_broker.profit_protection_policy(id,user_id,account_id,protected_custody_ref,profit_lineage_ref,
    provider_contract_sha256,worker_id,credential_sha256,independent_collector,approved_at,expires_at,profit_account_segregated,
    no_principal_access_or_recourse,no_margin_overdraft_or_fx_debit,no_transfer_pledge_or_setoff,bounded_all_in_liability)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()-interval '1 hour',now()+interval '1 hour',true,true,true,true,true)`,
    [id,input.user,input.account,'custody-'+id,'lineage-'+id,contract,input.worker,input.credentialHash,input.collector]);
  await q(`INSERT INTO sharkai_broker.profit_protected_instrument
    SELECT $1::uuid,x.id,x.broker_instrument_id,'STOCK',a.currency,true,true,true,$4 FROM sharkai_broker.asset x
    JOIN sharkai_broker.account a ON a.id=x.account_id WHERE x.account_id=$2 AND x.id=$3`,
    [id,input.account,input.asset,digest('fixture-fully-paid-'+id)]);
  return {id,digest:contract};
}
export function makeProfitPacket(input:{policy:Policy;provider:string;providerKey:string;snapshot:string;observedAt:string;cash:number;basis:number;closeout?:number}) {
  return {policy_id:input.policy.id,policy_digest:input.policy.digest,provider:input.provider,provider_account_key:input.providerKey,
    snapshot_id:input.snapshot,observed_at:input.observedAt,currency:'USD',evidence_sha256:digest('fixture-report-'+input.snapshot),
    report_ref:'fixture-'+input.snapshot,protected_principal_minor:'5000',gross_settled_gains_minor:'1000',
    gross_settled_losses_minor:'0',total_costs_minor:'0',distributed_minor:'0',open_cost_basis_minor:String(input.basis),
    unrealized_loss_minor:'0',segregated_profit_cash_minor:String(input.cash),mandate_closeout_minor:String(input.closeout??0),
    period_closeout_minor:String(input.closeout??0)};
}

export async function checkProfitOnlyBoundary(q:Query) {
  const user='isolated-owner-profits',account='isolated-profit-account',worker='subject-worker',asset='plain-stock',auditor='independent-bookkeeper';
  const forecast='existing-non-uuid-binding',credential=digest('synthetic-trading-credential');
  await q(`INSERT INTO sharkai_broker.account(id,user_id,provider,provider_key,currency,contractual_approval_at,ownership_verified_at,
    scope_verified_at,entitlement_cap_minor,reconciled) VALUES($1,$2,'IBKR','U1023456','USD',now(),now(),now(),1000,false)`,[account,user]);
  await q('INSERT INTO sharkai_broker.asset(account_id,id,broker_instrument_id,held_units,enabled) VALUES($1,$2,123,1,true)',[account,asset]);
  await q(`INSERT INTO sharkai_broker.worker_binding(worker_id,account_id,credential_ref,credential_sha256,credential_scope_approved_at,
    credential_expires_at,approved_until,approval_reference) VALUES($1,$2,'fixture',$3,now(),now()+interval '2 hours',now()+interval '2 hours','fixture')`,[worker,account,credential]);
  await q(`INSERT INTO sharkai_forecast.binding VALUES($1,'book',$2,'ibkr','U1023456','USD',$3,'one',
    now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour',current_date,now()+interval '1 hour',NULL)`,[forecast,user,asset]);
  const read=async(subject=user)=>(await q('SELECT sharkai_broker.owner_profit_budget($1,$2) AS r',[subject,forecast])).rows[0].r;
  assert.equal((await read()).available_profit_minor,'0');
  const policy=await provisionProfitPolicy(q,{user,account,asset,worker,credentialHash:credential,collector:auditor});
  const write=async(snap:string,cash:number,basis:number,loss:number,changes:Record<string,string>={})=>{
    const snapshot=await q(`UPDATE sharkai_broker.account SET snapshot_id=$2,snapshot_at=date_trunc('milliseconds',clock_timestamp()),
      exposure_minor=$3,free_cash_minor=$4,reconciled=true WHERE id=$1 RETURNING snapshot_at`,[account,snap,basis,cash]);
    const observedAt=snapshot.rows[0].snapshot_at.toISOString();
    await q(`INSERT INTO sharkai_broker.verified_account_snapshot VALUES($1,$2,repeat('4',64),$2,repeat('a',64),$3)`,[account,snap,observedAt]);
    const packet={...makeProfitPacket({policy,provider:'IBKR',providerKey:'U1023456',snapshot:snap,observedAt,cash,basis}),
      gross_settled_gains_minor:'750',gross_settled_losses_minor:String(loss),total_costs_minor:'10',distributed_minor:'75',unrealized_loss_minor:'25',...changes};
    return (await q('SELECT sharkai_broker.accept_profit_evidence($1,$2,$3) AS r',[auditor,packet,digest(JSON.stringify(packet))])).rows[0].r;
  };
  assert.equal(await write('one',1000,100,150),'recorded');
  const initial=await read();
  assert.equal(initial.status,'verified');
  assert.equal(initial.protected_principal_minor,'5000');
  assert.equal(initial.settled_realized_profit_minor,'590');
  assert.equal(Number(initial.available_profit_minor)+Number(initial.performance_fee_hold_minor),390);
  assert.equal((await read('other-owner')).available_profit_minor,'0');
  assert.equal(await write('two',6000,100,850,{protected_principal_minor:'20000'}),'recorded');
  const lost=await read();
  assert.equal(lost.status,'verified');
  assert.equal(lost.settled_realized_profit_minor,'-110');
  assert.equal(lost.available_profit_minor,'0');
  assert.equal(await write('three',6000,100,0),'invalid');
  assert.equal((await read()).status,'unverified');
  await assert.rejects(q('UPDATE sharkai_broker.profit_protection_policy SET profit_lineage_ref=$2 WHERE id=$1',[policy.id,randomUUID()]),/lineage/);
  const old=await q(`SELECT account_id,request_key FROM sharkai_broker.order_ledger WHERE state='RESERVED' AND request_key NOT LIKE 'worker:%' LIMIT 1`);
  assert.equal(old.rows.length,1);
  await assert.rejects(q(`UPDATE sharkai_broker.order_ledger SET state='SUBMITTING' WHERE account_id=$1 AND request_key=$2`,
    [old.rows[0].account_id,old.rows[0].request_key]),/Profit-only capital protection/);
  console.log('Profit-only SQL passed: designated account, principal exclusion, net realized loss, deposits, loss-reset rejection, fee hold, ownership isolation and legacy dispatch block.');
}
