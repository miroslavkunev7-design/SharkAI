import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {PrismaClient} from '@prisma/client';
import {readProcurement,submitProcurement,runApprovedProcurement} from '../../lib/commerce/procurement.server';
import {receiveStockEvidence} from '../../lib/commerce/stock-evidence.server';
import {commerceCredentials,storeContract} from '../../lib/commerce/providers.server';
import {readCommerceDashboard,setCommerceCapital} from '../../lib/commerce/commerce.server';
type Query=(s:string,ps?:unknown[])=>Promise<{rows:Record<string,any>[]}>;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export async function seedStockOffer(q:Query,store:string,po='8001'){
 const supplier=randomUUID(),offer=randomUUID(),email='orders@example.invalid',contract=sha(supplier);
 await q(`INSERT INTO sharkai_commerce.stock_supplier VALUES($1,$2,'eu','330','331','332','Local supplier fixture','warehouse',$3,$4,true,true,true,
  now()-interval '1 hour',now()+interval '2 days',NULL)`,[supplier,store,sha(email),contract]);
 await q(`INSERT INTO sharkai_commerce.stock_offer VALUES($1,$2,$3,$4,'sku','Test product','333',10,800,now()+interval '1 day',$5)`,[offer,supplier,store,po,sha(po)]);
 return {supplier,offer,contract,email};
}
export async function checkProcurement(q:Query,db:PrismaClient) {
 await q(await readFile(new URL('../../n8n/sql/commerce-procurement.sql',import.meta.url),'utf8'));
 const store=randomUUID(),owner='stock-fixture-owner',contract=sha(store),shop='stock-fixture.myshopify.com';
 await q('INSERT INTO public."User" VALUES($1)',[owner]);
 await q(`INSERT INTO sharkai_commerce.store(id,user_id,shop,printful_store,currency,custody_ref,contract_digest,cash_collector,catalog_collector,ledger_collector,
  hard_charge_cap_minor,dedicated_nonrecourse,external_charge_cap_verified,approved_at,expires_at) VALUES($1,$2,$3,NULL,'EUR','stock-only-custody',$4,'cash','catalog','book',1000,true,true,now()-interval '1 minute',now()+interval '3 days')`,[store,owner,shop,contract]);
 const pure=storeContract.parse((await q('SELECT sharkai_commerce.current_store($1,NULL) s',[owner])).rows[0].s);
 assert.equal(pure.printful_store,null);
 assert.equal(commerceCredentials(pure,{SHARKAI_COMMERCE_STORES:JSON.stringify([{shop,shopify_secret:'test-shopify-secret',shopify_access_token:'test-shopify-access'}])}).printful_access_token,undefined);
 const today=new Date().toISOString().slice(0,10),range={from:today,to:today,currency:'EUR'};
 await setCommerceCapital(owner,{currency:'EUR',amount_minor:'1500'},db);
 assert.equal((await readCommerceDashboard(owner,range,db)).shop.supplier_connected,false);
 assert.equal((await q('SELECT sharkai_commerce.dashboard($1,CURRENT_DATE,CURRENT_DATE,$2) r',[owner,'EUR'])).rows[0].r.shop.supplier_connected,false);
 const cash=async(balance:number,contributions:number,ref:string,observed=new Date().toISOString())=>{
  const packet={store_id:store,currency:'EUR',contract_digest:contract,kind:'cash',basis:'settled_dedicated_commerce_no_recourse',report_ref:ref,
   observed_at:observed,cash_minor:String(balance),hard_charge_cap_minor:'1000',settled_orders:[],resale_basis:'reconciled_net_owner_contributions_excluding_all_sales_and_earnings',resale_contributed_minor:String(contributions)};
  assert.equal((await q('SELECT sharkai_commerce.accept_evidence($1,$2,$3) r',['cash',packet,sha(JSON.stringify(packet))])).rows[0].r,'recorded');
 };
 await cash(5000,1500,'first-cash');
 const {supplier,offer,contract:supplierContract,email}=await seedStockOffer(q,store);
 const other=randomUUID(),last=randomUUID();
 for(const [id,po] of [[other,'8002'],[last,'8003']])await q(`INSERT INTO sharkai_commerce.stock_offer VALUES($1,$2,$3,$4,'sku','Test product','333',10,800,now()+interval '1 day',$5)`,[id,supplier,store,po,sha(po)]);
 const keys={cash:randomBytes(32).toString('hex'),warehouse:randomBytes(32).toString('hex'),book:randomBytes(32).toString('hex')};
 const env={SHARKAI_COMMERCE_EVIDENCE_ENABLED:'true',SHARKAI_COMMERCE_PROCUREMENT_ENABLED:'true',SHARKAI_COMMERCE_EVIDENCE_KEYS:JSON.stringify(keys),
  SHARKAI_COMMERCE_ZOHO_CREDENTIALS:JSON.stringify({[supplier]:{org:'330',region:'eu',vendor_email:email,access_token:'test-zoho-access-token'}})};
 let external=0,wrong=false,fail=false,receiptPO='8001';
 const send:typeof fetch=async(url,opts)=>{
  const u=new URL(String(url));assert.equal(u.origin,'https://www.zohoapis.eu');assert.equal(u.searchParams.get('organization_id'),'330');assert.equal(opts?.redirect,'error');
  if(u.pathname.includes('purchasereceives'))return Response.json({code:0,purchasereceive:{purchasereceive_id:'9901',purchaseorder_id:receiptPO,
    vendor_id:'331',location_id:'332',status:'received',is_salesreturn:false,line_items:[{item_id:'333',quantity:10}]}});
  if(opts?.method==='POST'){external++;assert(u.pathname.startsWith('/books/v3/purchaseorders/'));assert(u.pathname.endsWith('/email'));assert.equal(u.searchParams.get('send_attachment'),'true');
    assert.deepEqual(JSON.parse(String(opts.body)).to_mail_ids,[email]);if(fail)throw Error('Synthetic transport timeout');return Response.json({code:0,message:'Mail accepted'});}
  const po=u.pathname.split('/').pop();
  return Response.json({code:0,purchaseorder:{purchaseorder_id:po,purchaseorder_number:'PO-'+po,status:'draft',vendor_id:'331',currency_code:'EUR',location_id:wrong?'other':'332',
   is_emailed:false,is_drop_shipment:false,salesorder_id:null,total:8,line_items:[{item_id:'333',quantity:10,location_id:'332'}],contact_persons_associated:[{contact_person_email:email}]}});
 };
 const call=(data:unknown,id=owner)=>submitProcurement(id,data,db,env,send);
 assert.equal((await readProcurement('outsider',db)).items.length,0);
 wrong=true;assert.equal((await call({action:'review',offer_id:offer})).status,'unavailable');wrong=false;
 const a=await call({action:'review',offer_id:offer}),b=await call({action:'review',offer_id:other});assert(a.status==='reviewed'&&b.status==='reviewed');
 assert.equal((await call({action:'confirm',offer_id:offer,review_id:a.review_id},'outsider')).status,'unavailable');
 const pair=await Promise.all([call({action:'confirm',offer_id:offer,review_id:a.review_id}),call({action:'confirm',offer_id:other,review_id:b.review_id})]);
 assert.deepEqual(pair.map(v=>v.status).sort(),['blocked','issued']);assert.equal(external,1);
 const selected=pair[0].status==='issued'?offer:other,po=selected===offer?'8001':'8002';receiptPO=po;
 const stock=async(kind:string,actor:keyof typeof keys,details:Record<string,unknown>,bad=false)=>{
  const data={kind,offer_id:selected,contract_digest:supplierContract,currency:'EUR',po_id:po,product_id:'sku',observed_at:new Date().toISOString(),...details},body=JSON.stringify(data);
  const stamp=String(Math.floor(Date.now()/1000)),sig=createHmac('sha256',Buffer.from(keys[actor],'hex')).update('sharkai-stock/v1\n'+actor+'\n'+stamp+'\n'+body).digest('hex');
  return receiveStockEvidence(new Request('http://localhost/stock',{method:'POST',body,headers:{'x-shark-commerce-collector':actor,'x-shark-commerce-time':stamp,'x-shark-commerce-signature':bad?'0'.repeat(64):sig}}),env,db,send);
 };
 const receipt={basis:'posted_zoho_owned_warehouse_receipt',warehouse_id:'332',vendor_id:'331',report_ref:'9901',units_received:10};
 assert.equal((await stock('stock_receipt','warehouse',receipt,true)).status,403);
 assert.equal((await stock('stock_receipt','cash',receipt)).status,403);
 assert.equal((await stock('stock_receipt','warehouse',receipt)).status,200);
 const observation=new Date().toISOString();await cash(4200,1500,'paid-cash');
 const payment={basis:'final_cleared_all_in_business_purchase',cost_minor:'800',cash_report_ref:'paid-cash',report_ref:'paid-vendor-1',observed_at:observation};
 const settled=await stock('stock_payment','cash',payment);assert.equal((await settled.json()).status,'recorded');
 assert.equal((await (await stock('stock_payment','cash',payment)).json()).status,'replayed');
 const sales={basis:'cumulative_settled_merchant_resales_net_of_discounts_ex_tax',units_sold:4,units_on_hand:6,
   settled_revenue_minor:'1000',refunded_minor:'50',selling_cost_minor:'100',report_ref:'sales1'};
 assert.equal((await stock('stock_sales','book',sales)).status,200);
 const dashboard=await readProcurement(owner,db),item=dashboard.items.find(i=>i.offer_id===selected)!;
 assert.equal(item.received_units,10);assert.equal(item.stock_units,6);assert.equal(item.realized_margin_minor,'530');
 assert.equal((await q('SELECT sharkai_commerce.resale_cleared_purchase($1,$2,$3)::text cap',[store,'procurement',po])).rows[0].cap,'320');
 assert.equal((await readCommerceDashboard(owner,range,db)).capital.available_minor,'700');
 await cash(6000,0,'profits-alone');assert.equal((await readCommerceDashboard(owner,range,db)).capital.available_minor,'0');
 await cash(5500,3000,'new-allocation');await setCommerceCapital(owner,{currency:'EUR',amount_minor:'3000'},db);
 assert.equal((await call({action:'enable_automation',offer_id:last,max_per_po_minor:'800',total_minor:'800',expires_at:new Date(Date.now()+3600000).toISOString(),accepted:true})).status,'enabled');
 fail=true;assert.equal((await runApprovedProcurement(db,env,send)).status,'needs_reconciliation');assert.equal(external,2);
 assert.equal((await runApprovedProcurement(db,env,send)).processed,0);assert.equal(external,2);
 const mandate=(await readProcurement(owner,db)).mandates[0];assert.equal((await call({action:'disable_automation',mandate_id:mandate.mandate_id})).status,'revoked');
 const mixed=(await q("SELECT id,contract_digest FROM sharkai_commerce.store WHERE user_id='owner'")).rows[0];
 const mixedOffer=await seedStockOffer(q,mixed.id,'8011');
 const mixedCash={store_id:mixed.id,currency:'EUR',contract_digest:mixed.contract_digest,kind:'cash',basis:'settled_dedicated_commerce_no_recourse',
  report_ref:'mixed-supplier-cash',observed_at:new Date().toISOString(),cash_minor:'7000',hard_charge_cap_minor:'2000',settled_orders:[],
  resale_basis:'reconciled_net_owner_contributions_excluding_all_sales_and_earnings',resale_contributed_minor:'4000'};
 assert.equal((await q('SELECT sharkai_commerce.accept_evidence($1,$2,$3) r',['cash',mixedCash,sha(JSON.stringify(mixedCash))])).rows[0].r,'recorded');
 assert.equal(await setCommerceCapital('owner',{currency:'EUR',amount_minor:'4000'},db),true);
 const mixedBudget=(await readCommerceDashboard('owner',range,db)).capital;
 assert.equal(mixedBudget.held_minor,'2000');assert.equal(mixedBudget.available_minor,'750');
 const mixedEnv={...env,SHARKAI_COMMERCE_ZOHO_CREDENTIALS:JSON.stringify({[mixedOffer.supplier]:{org:'330',region:'eu',vendor_email:mixedOffer.email,access_token:'test-zoho-access-token'}})};
 const before=external;
 assert.equal((await submitProcurement('owner',{action:'review',offer_id:mixedOffer.offer},db,mixedEnv,send)).status,'blocked');
 assert.equal(external,before);
 console.log('Procurement PASS: Shopify merchant without Printful, genuine Zoho supplier transmission contract, isolated stock purchase before any buyer, concurrency, owner capital, actual received inventory, signed resale margin, manual profit protection and restricted recurring authorization.');
}
