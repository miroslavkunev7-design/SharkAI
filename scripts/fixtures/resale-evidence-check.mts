import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {PrismaClient} from '@prisma/client';
import {receiveCommerceEvidence,recordCommerceEvidence} from '../../lib/commerce/evidence.server';

type Query=(sql:string,params?:unknown[])=>Promise<{rows:Record<string,any>[]}>;
const day=86400000;
const date=(time:number)=>new Date(time).toISOString().slice(0,10);

export async function checkResaleEvidence(q:Query,db:PrismaClient){
 await q(await readFile(new URL('../../n8n/sql/commerce-resale-settlement.sql',import.meta.url),'utf8'));
 const keys={ledger:randomBytes(32).toString('hex'),cashier:randomBytes(32).toString('hex'),catalog:randomBytes(32).toString('hex')};
 const env={SHARKAI_COMMERCE_EVIDENCE_ENABLED:'true',SHARKAI_COMMERCE_EVIDENCE_KEYS:JSON.stringify(keys)};
 const send=async(packet:Record<string,unknown>,actor:keyof typeof keys='ledger',corrupt=false,delay=0)=>{
   const ts=String(Math.floor((Date.now()-delay)/1000)),body=JSON.stringify(packet);
   const signature=createHmac('sha256',Buffer.from(keys[actor],'hex')).update('sharkai-commerce/v1\n'+actor+'\n'+ts+'\n'+body).digest('hex');
   const req=new Request('http://localhost/api/internal/commerce/evidence',{method:'POST',body,headers:{
     'content-type':'application/json','x-shark-commerce-collector':actor,'x-shark-commerce-time':ts,
     'x-shark-commerce-signature':corrupt?'f'.repeat(64):signature}});
   return receiveCommerceEvidence(req,env,(s,p,d)=>recordCommerceEvidence(s,p,d,db));
 };
 const id=randomUUID(),shop='resale-fixture.myshopify.com',custody='resale-separate',contract='e'.repeat(64);
 const today=new Date(),monday=Date.parse(date(today.getTime()))-((today.getUTCDay()+6)%7+14)*day;
 await q("INSERT INTO public.\"User\" VALUES ('resale-fixture-owner')");
 await q(`INSERT INTO sharkai_commerce.store(id,user_id,shop,printful_store,currency,external_ref_prefix,custody_ref,contract_digest,cash_collector,catalog_collector,
  ledger_collector,hard_charge_cap_minor,dedicated_nonrecourse,external_charge_cap_verified,supplier_manual_confirm_only,approved_at,expires_at,exclusive_draft_confirmation)
  VALUES($1,'resale-fixture-owner',$2,'31','EUR','',$3,$4,'cashier','catalog','ledger',1000,true,true,true,$5,now()+interval '30 days',true)`,
  [id,shop,custody,contract,new Date(monday+day/2)]);
 const common={store_id:id,currency:'EUR',contract_digest:contract,report_ref:'week-first',observed_at:new Date(Date.now()-1000).toISOString()};
 const week={...common,kind:'resale_week',basis:'settled_resale_after_all_costs_excluding_external_flows',shop,custody_ref:custody,evidence_sha256:'b'.repeat(64),
   week_start:date(monday),week_end:date(monday+day*6),previous_report_ref:null,opening_cumulative_net_minor:'0',closing_cumulative_net_minor:'100',net_minor:'100',
   settled_receipts_minor:'270',refunds_minor:'20',goods_minor:'100',fulfillment_minor:'15',advertising_minor:'10',fees_minor:'10',taxes_minor:'10',other_costs_minor:'5',
   recovered_purchase_cost_minor:'0',recovered_purchases:[]};
 assert.equal((await send(week,'ledger',true)).status,403);
 assert.equal((await send(week,'ledger',false,60000)).status,403);
 assert.equal((await send(week,'cashier')).status,403);
 assert.equal((await send({...week,net_minor:'99'})).status,400);
 assert.equal((await send({...week,week_end:date(monday+day*5)})).status,400);
 assert.equal((await send({...week,opening_cumulative_net_minor:'100',closing_cumulative_net_minor:'200'})).status,400);
 assert.equal((await send({...week,external_deposits_minor:'100'})).status,400);
 assert.equal((await send({...week,recovered_purchase_cost_minor:'120',recovered_purchases:[{kind:'fulfillment',ref:'x',amount_minor:'120'}]})).status,400);
 assert.equal((await send({...week,recovered_purchase_cost_minor:'1',recovered_purchases:[]})).status,400);
 assert.equal((await send({...week,recovered_purchase_cost_minor:'2',recovered_purchases:[{kind:'procurement',ref:'x',amount_minor:'1'},{kind:'procurement',ref:'x',amount_minor:'1'}]})).status,400);
 assert.notEqual((await send({...week,shop:'other-fixture.myshopify.com'})).status,200);
 assert.notEqual((await send({...week,custody_ref:'another-account'})).status,200);
 assert.equal((await (await send(week)).json()).status,'recorded');
 assert.equal((await (await send(week)).json()).status,'replayed');
 assert.equal((await send({...week,evidence_sha256:'a'.repeat(64)})).status,409);
 const loss={...week,week_start:date(monday+day*7),week_end:date(monday+day*13),report_ref:'week-second',previous_report_ref:'week-first',
   evidence_sha256:'c'.repeat(64),settled_receipts_minor:'120',net_minor:'-50',opening_cumulative_net_minor:'100',closing_cumulative_net_minor:'50'};
 assert.notEqual((await send({...loss,previous_report_ref:'no-such-close'})).status,200);
 assert.equal((await (await send(loss)).json()).status,'recorded');
 const cash={...common,kind:'cash',basis:'settled_dedicated_commerce_no_recourse',cash_minor:'2000',hard_charge_cap_minor:'1000',settled_orders:[]};
 const basis='reconciled_net_owner_contributions_excluding_all_sales_and_earnings';
 const funding=async()=>(await q("SELECT sharkai_commerce.resale_funding('resale-fixture-owner','EUR') r")).rows[0].r;
 assert.equal((await send({...cash,report_ref:'legacy-cash',observed_at:new Date(Date.parse(common.observed_at)-1000).toISOString()},'cashier')).status,200);
 assert.equal((await funding()).funding_verified,false);
 assert.equal((await send({...cash,resale_contributed_minor:'1000'},'cashier')).status,400);
 assert.equal((await send({...cash,resale_basis:basis},'cashier')).status,400);
 assert.equal((await send({...cash,resale_basis:basis,resale_contributed_minor:'1000'},'catalog')).status,403);
 assert.equal((await (await send({...cash,resale_basis:basis,resale_contributed_minor:'1000'},'cashier')).json()).status,'recorded');
 assert.equal((await funding()).funding_verified,true);
 assert.equal((await funding()).confirmed_capital_minor,'950');
 const payout={...common,report_ref:'withdrawal',kind:'resale_owner_payout',basis:'settled_same_currency_owner_profit_payout',shop,custody_ref:custody,
   beneficiary_digest:'a'.repeat(64),evidence_sha256:'b'.repeat(64),amount_minor:'5',debit_ref:'debit',credit_ref:'credit'};
 assert.equal((await send({...payout,debit_ref:'credit'},'cashier')).status,400);
 assert.notEqual((await send(payout,'ledger')).status,200);
 assert.notEqual((await send(payout,'cashier')).status,200);
 await q("INSERT INTO sharkai_commerce.resale_payout_destination(store_id,beneficiary_digest,provider,contract_digest) VALUES($1,$2,'wise-business',$3)",[id,payout.beneficiary_digest,contract]);
 assert.equal((await q("SELECT sharkai_commerce.allocate_resale_profit('resale-fixture-owner','EUR',$1,50) r",[week.week_start])).rows[0].r,true);
 const settledAt=(await q(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`)).rows[0].value;
 const settled={...payout,observed_at:settledAt};
 const afterPosting=Math.max(0,Date.parse(settledAt)-Date.now())+10;
 assert(afterPosting<1000,'Isolated database and application clocks disagree: '+settledAt);
 await new Promise(done=>setTimeout(done,afterPosting));
 const accepted=await send(settled,'cashier');
 assert.equal((await accepted.json()).status,'recorded','payout HTTP '+accepted.status+'; fixture database time '+settledAt);
 assert.equal((await (await send(settled,'cashier')).json()).status,'replayed');
 const statement=(await q("SELECT sharkai_commerce.resale_settlement('resale-fixture-owner','EUR') r")).rows[0].r;
 assert.equal(statement.owner_paid_minor,'5');assert.equal(statement.owner_reserved_minor,'45');
 console.log('Resale evidence passed: authenticated closed weeks, owner/store/account isolation, signed loss, balanced costs, immutable continuity, no deposit injection and independently signed cash lineage.');
}
