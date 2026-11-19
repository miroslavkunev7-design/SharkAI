import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {PrismaClient} from '@prisma/client';
import {readResaleSettlement} from '../../lib/commerce/resale-settlement.server';

type Query=(text:string,parameters?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>;
export async function checkResaleSettlements(q:Query,db:PrismaClient) {
  const store=randomUUID(),owner='merchant-'+store,shop='resale-'+store+'.myshopify.com';
  const contract='c'.repeat(64),custody='account-'+store,beneficiary='9'.repeat(64);
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  const scalar=async(sql:string,params:unknown[]=[]) => (await q(sql,params)).rows[0]?.r;
  const today=await scalar("select date_trunc('week',now() at time zone 'UTC')::date::text r") as string;
  const day=(delta:number)=>new Date(Date.parse(today+'T00:00:00Z')+delta*86400000).toISOString().slice(0,10);
  await q('INSERT INTO public."User" (id) VALUES ($1)',[owner]);
  await q(`INSERT INTO sharkai_commerce.store (id,user_id,shop,printful_store,external_ref_prefix,currency,custody_ref,contract_digest,
    cash_collector,catalog_collector,ledger_collector,hard_charge_cap_minor,dedicated_nonrecourse,external_charge_cap_verified,
    supplier_manual_confirm_only,approved_at,expires_at,exclusive_draft_confirmation)
    VALUES ($1,$2,$3,$4,'','EUR',$5,$6,'merchant-bank','merchant-catalog','merchant-book',9000,true,true,true,
       ($7::date::timestamp AT TIME ZONE 'UTC'),now()+interval '1 year',true)`,
      [store,owner,shop,String(Math.floor(Math.random()*1000000000000)+1),custody,contract,day(-21)]);
  await q("INSERT INTO sharkai_commerce.resale_payout_destination VALUES ($1,$2,'wise-business',$3)",[store,beneficiary,contract]);
  await q("INSERT INTO sharkai_commerce.order_state VALUES ($1,'123','paid',9000,0,now(),now(),now(),$2)",[store,contract]);
  await q(`INSERT INTO sharkai_commerce.fulfillment (store_id,order_ref,review_id,revision,supplier_id,quote_digest,order_digest,max_cost_minor,current_state,expires_at,claimed_at,posted_cost_minor)
    VALUES ($1,'123',$2,1,'754',$3,$3,3000,'reconciled',now(),now()-interval '30 days',3000)`,[store,randomUUID(),contract]);
  const record=async(packet:Record<string,unknown>,signer='merchant-book')=>scalar('SELECT sharkai_commerce.record_resale_week($1,$2,$3) r',
    [signer,packet,hash(JSON.stringify(packet))]);
  const close=(offset:number,previous:string|null,opening:number,net:number,cost=0)=>({
    kind:'resale_week',basis:'settled_resale_after_all_costs_excluding_external_flows',store_id:store,currency:'EUR',contract_digest:contract,
    report_ref:'week-'+offset,week_start:day(offset),week_end:day(offset+6),observed_at:new Date().toISOString(),
    shop,custody_ref:custody,previous_report_ref:previous,evidence_sha256:hash(store+offset),
    net_minor:String(net),opening_cumulative_net_minor:String(opening),closing_cumulative_net_minor:String(opening+net),
    settled_receipts_minor:String(Math.max(0,net)+cost),refunds_minor:'0',goods_minor:String(cost),fulfillment_minor:'0',
    fees_minor:'0',advertising_minor:'0',other_costs_minor:String(Math.max(0,-net)),taxes_minor:'0',
    recovered_purchase_cost_minor:String(cost),recovered_purchases:cost?[{kind:'fulfillment',ref:'123',amount_minor:String(cost)}]:[],
  });
  const fund=async()=>await scalar('SELECT sharkai_commerce.resale_funding($1,$2) r',[owner,'EUR']) as Record<string,unknown>;
  const split=(week:string,amount:number,user=owner)=>scalar("SELECT sharkai_commerce.allocate_resale_profit($1,'EUR',$2,$3) r",[user,week,amount]);
  assert.equal(await scalar("SELECT sharkai_commerce.set_resale_target($1,'EUR',5000) r",[owner]),true);
  assert.equal((await readResaleSettlement(owner,'EUR',db)).period?.target_minor,'5000');
  const first=close(-21,null,0,10000,2500);
  assert.equal(await record({...first,recovered_purchases:[{kind:'fulfillment',ref:'999',amount_minor:'2500'}]}),'invalid');
  assert.equal(await record(first),'recorded');assert.equal(await record(first),'replayed');
  const firstView=(await readResaleSettlement(owner,'EUR',db)).closed[0];
  assert.equal(firstView.allocable_minor,'10000');assert.equal(firstView.status,'awaiting_allocation');
  assert.equal((await fund()).reserved_minor,'10000');assert.equal((await fund()).reinvested_minor,'0');
  assert.equal(await split(day(-21),10001),false);assert.equal(await split(day(-21),4000,'other-'+owner),false);
  const concurrent=await Promise.all([split(day(-21),4000),split(day(-21),4000)]);
  assert.deepEqual(concurrent,[true,true]);assert.equal(await split(day(-21),1),false);
  const balance=(await readResaleSettlement(owner,'EUR',db));
  assert.equal(balance.owner_reserved_minor,'6000');assert.equal(balance.reinvested_total_minor,'4000');assert.equal(balance.owner_paid_minor,'0');
  assert.equal(await record(close(-14,first.report_ref,10000,-2000)),'recorded');
  assert.equal(await record(close(-7,'week--14',8000,3000,600)),'invalid');
  assert.equal(await record(close(-7,'week--14',8000,3000,500)),'recorded');
  const last=(await readResaleSettlement(owner,'EUR',db)).closed;
  assert.equal(last[0].profit_minor,'3000');assert.equal(last[0].allocable_minor,'1000');assert.equal(last[1].profit_minor,'-2000');
  assert.equal(await split(day(-7),0),true);
  const funding=await fund();assert.equal(funding.funding_verified,false);assert.equal(funding.recovered_cost_minor,'3000');assert.equal(funding.reserved_minor,'7000');
  const payout={kind:'resale_owner_payout',basis:'settled_same_currency_owner_profit_payout',store_id:store,currency:'EUR',shop,custody_ref:custody,
    contract_digest:contract,beneficiary_digest:beneficiary,evidence_sha256:hash('payout'+store),amount_minor:'5000',observed_at:'',
    report_ref:'payout-'+store,debit_ref:'d-'+store,credit_ref:'c-'+store};
  // Rely on the database clock for receipts observed after the owner's allocation.
  payout.observed_at=String(await scalar("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') r"));
  const credit=(p:typeof payout,actor='merchant-bank')=>scalar('SELECT sharkai_commerce.record_resale_owner_payout($1,$2,$3) r',[actor,p,hash(JSON.stringify(p))]);
  assert.equal(await credit(payout,'merchant-book'),'forbidden');assert.equal(await credit({...payout,beneficiary_digest:contract}),'forbidden');
  assert.equal(await credit({...payout,amount_minor:'7001'}),'invalid');assert.equal(await credit(payout),'recorded');assert.equal(await credit(payout),'replayed');
  const final=await readResaleSettlement(owner,'EUR',db);
  assert.equal(final.owner_reserved_minor,'2000');assert.equal(final.owner_paid_minor,'5000');assert.equal((await fund()).reserved_minor,'2000');
  assert.equal((await readResaleSettlement('other-'+owner,'EUR',db)).status,'unavailable');
}
