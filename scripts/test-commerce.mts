import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {PrismaClient} from '@prisma/client';
import {readCommerceDashboard,setCommerceCapital,readCommerceAgentAccess,reviewCommerceFulfillment,confirmCommerceFulfillment,receiveShopify} from '../lib/commerce/commerce.server';
import {receiveCommerceEvidence} from '../lib/commerce/evidence.server';
import {receivePrintful} from '../lib/commerce/printful-webhook.server';
import {checkResaleEvidence} from './fixtures/resale-evidence-check.mts';
import {checkProcurement} from './fixtures/commerce-procurement-check.mts';
import {checkResaleSettlements} from './fixtures/resale-split-check.mts';

const base=await realpath(process.env.SHARKAI_EMBEDDED_PG_ROOT??'D:/SharkAI-workbench/telegram-db-test');
const dep=(name:string)=>import(pathToFileURL(join(base,'node_modules',name)).href);
const {default:EmbeddedPostgres}=await dep('embedded-postgres/dist/index.js'),{default:pg}=await dep('pg/lib/index.js');
const {initdb}=await dep('@embedded-postgres/windows-x64/dist/index.js'),{gracefulExit}=await dep('exit-hook/index.js');
const dir=await mkdtemp(join(base,'commerce-')),path=join(dir,'db'),pwfile=join(dir,'password'),password=randomBytes(20).toString('hex');
const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const addr=listener.address();assert(addr&&typeof addr!=='string');
const port=addr.port;await new Promise<void>((resolve,reject)=>listener.close(e=>e?reject(e):resolve()));
const cluster=new EmbeddedPostgres({databaseDir:path,port,user:'commerce_fixture',password,persistent:true,postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:()=>{}});
let pool,db:PrismaClient|undefined,started=false;
try{
 await writeFile(pwfile,password+'\n');await promisify(execFile)(initdb,['--pgdata='+path,'--username=commerce_fixture','--pwfile='+pwfile,
   '--auth=scram-sha-256','--encoding=UTF8','--locale=C','--no-sync','--no-instructions']);await rm(pwfile);await cluster.start();started=true;
 pool=new pg.Pool({port,host:'127.0.0.1',user:'commerce_fixture',password,database:'postgres'});
 db=new PrismaClient({datasourceUrl:'postgresql://commerce_fixture:'+password+'@127.0.0.1:'+port+'/postgres',log:[]});
 const q=(sql:string,params:unknown[]=[])=>pool.query(sql,params);
 await q('CREATE TABLE public."User"(id text primary key); INSERT INTO public."User" VALUES (\'owner\'),(\'outsider\'); CREATE ROLE anon; CREATE ROLE authenticated');
 await q(await readFile(new URL('../n8n/sql/commerce-dropshipping.sql',import.meta.url),'utf8'));
 const store=randomUUID(),contract='a'.repeat(64),keys={supplier:randomBytes(32).toString('hex'),book:randomBytes(32).toString('hex'),cash:randomBytes(32).toString('hex')};
 const shop='fixture-shop.myshopify.com',k={shop,store:'12',shopify_secret:'only-local-shopify-hmac',shopify_access_token:'synthetic-shopify-token',printful_access_token:'synthetic-printful-token'};
 const env={SHARKAI_COMMERCE_EVIDENCE_ENABLED:'true',SHARKAI_COMMERCE_FULFILLMENT_ENABLED:'true',SHARKAI_COMMERCE_STORES:JSON.stringify([k]),SHARKAI_COMMERCE_EVIDENCE_KEYS:JSON.stringify(keys)};
 await q(`INSERT INTO sharkai_commerce.store VALUES ($1,'owner',$2,'12','EUR','shopify-','dedicated-fixture',$3,'cash','supplier','book',2000,true,true,true,now()-interval '1 hour',now()+interval '1 hour',NULL,true)`,[store,shop,contract]);
 assert.deepEqual(await readCommerceAgentAccess('owner',db),{enabled:false,revision:0});
 assert.equal(await setCommerceCapital('outsider',{currency:'EUR',amount_minor:'1000'},db),false);
 assert.equal(await setCommerceCapital('owner',{currency:'EUR',amount_minor:'2000',agent_read_allowed:true},db),true);
 const today=new Date().toISOString().slice(0,10),yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
 const range={from:yesterday,to:today,currency:'EUR'};assert.equal((await readCommerceDashboard('owner',range,db)).capital.available_minor,'0');
 const report=async(kind:string,actor:keyof typeof keys,payload:Record<string,unknown>,wrong=false)=>{
   const time=String(Math.floor(Date.now()/1000)),data={store_id:store,currency:'EUR',contract_digest:contract,observed_at:new Date().toISOString(),report_ref:randomUUID(),kind,...payload};
   const raw=JSON.stringify(data),signature=createHmac('sha256',Buffer.from(keys[actor],'hex')).update('sharkai-commerce/v1\n'+actor+'\n'+time+'\n'+raw).digest('hex');
   const req=new Request('http://localhost/evidence',{method:'POST',body:raw,headers:{'content-type':'application/json','x-shark-commerce-collector':actor,'x-shark-commerce-time':time,'x-shark-commerce-signature':wrong?'0'.repeat(64):signature}});
   return receiveCommerceEvidence(req,env,async(s,p,d)=>(await q('SELECT sharkai_commerce.accept_evidence($1,$2,$3) r',[s,p,d])).rows[0].r);
 };
 const catalog={basis:'complete_approved_supplier_catalog',report_ref:'catalog-one',product_count:1,products:[{product_id:'item',name:'Print',shopify_variant:'21',printful_variant:'31',inventory_units:10}]};
 assert.equal((await report('catalog','book',catalog)).status,403);assert.equal((await report('catalog','supplier',catalog,true)).status,403);
 assert.equal((await report('catalog','supplier',catalog)).status,200);
 const money={basis:'settled_dedicated_commerce_no_recourse',cash_minor:'2500',hard_charge_cap_minor:'2000',settled_orders:[]};
 assert.equal((await report('cash','cash',money)).status,200);
 const m={product_id:'item',orders:2,units:4,revenue_minor:'6000',refunds_minor:'700',goods_minor:'2000',fulfillment_minor:'300',advertising_minor:'200',fees_minor:'100',other_costs_minor:'50',customer_count:2,largest_customer_revenue_minor:'3100'};
 const day={basis:'complete_utc_settled_after_discounts_including_shipping_before_refunds_ex_tax',date:yesterday,distinct_orders:2,catalog_ref:'catalog-one',products:[m]};
 assert.equal((await report('day','book',{...day,products:[],distinct_orders:0})).status,409);assert.equal((await report('day','book',day)).status,200);
 const result=await readCommerceDashboard('owner',{...range,to:yesterday},db);assert.equal(result.period_complete,true);assert.equal(result.daily[0].orders,2);assert.equal(result.capital.available_minor,'2000');
 const products=(await q("SELECT sharkai_commerce.product_candidates('owner') r")).rows[0].r;assert.equal(products.catalog_complete,true);assert.equal(products.independent_sources_verified,true);assert.equal(products.products[0].days[0].revenue_minor,'6000');
 const at=new Date().toISOString(),customer={name:'Test Person',company:null,address1:'10 Example St',address2:null,city:'Sofia',zip:'1000'};
 const refunded=new Set<string>();let wrongRecipient=false,timeout=false,posts=0;
 const sender:typeof fetch=async(input,opts)=>{
    const url=new URL(String(input));assert.equal(opts?.redirect,'error');
    if(url.hostname===shop){
      const gid=JSON.parse(String(opts?.body)).variables.id,ref=String(gid).split('/').pop()!;
      return Response.json({data:{order:{id:gid,test:false,createdAt:at,updatedAt:at,cancelledAt:null,displayFinancialStatus:refunded.has(ref)?'REFUNDED':'PAID',displayFulfillmentStatus:'UNFULFILLED',
        totalPriceSet:{shopMoney:{amount:'30.00',currencyCode:'EUR'}},totalRefundedSet:{shopMoney:{amount:refunded.has(ref)?'30.00':'0.00',currencyCode:'EUR'}},
        shippingAddress:{...customer,provinceCode:null,countryCodeV2:'BG'},lineItems:{nodes:[{currentQuantity:1,requiresShipping:true,variant:{id:'gid://shopify/ProductVariant/21'}}],pageInfo:{hasNextPage:false}}}}});
    }
    assert.equal(url.hostname,'api.printful.com');assert.equal(new Headers(opts?.headers).get('X-PF-Store-Id'),'12');
    const ref=url.pathname.includes('@')?url.pathname.split('-').pop()!:String(Number(url.pathname.split('/')[2])-1000);
    if(opts?.method==='POST'){posts++;if(timeout)throw Error('Fixture timeout after dispatch');}
    return Response.json({code:200,result:{id:1000+Number(ref),store:12,external_id:'shopify-'+ref,status:opts?.method==='POST'?'pending':'draft',
      recipient:{...customer,name:wrongRecipient?'Wrong Customer':customer.name,state_code:null,country_code:'BG'},items:[{sync_variant_id:31,quantity:1}],costs:{currency:'EUR',total:'12.50'}}});
 };
 const deliver=async(ref:string,wrong=false,receipt:string=randomUUID(),topic='orders/paid')=>{
    const raw=JSON.stringify(topic==='refunds/create'?{order_id:Number(ref)}:{admin_graphql_api_id:'gid://shopify/Order/'+ref});
    return receiveShopify(new Request('http://localhost/shopify',{method:'POST',body:raw,headers:{'x-shopify-shop-domain':shop,'x-shopify-topic':topic,'x-shopify-webhook-id':receipt,
      'x-shopify-hmac-sha256':wrong?'bad':createHmac('sha256',k.shopify_secret).update(raw).digest('base64')}}),()=>db!,env,sender);
 };
 assert.equal((await deliver('54',true)).status,403);const receipt=randomUUID();
 assert.equal((await deliver('54',false,receipt)).status,200);assert.equal((await deliver('54',false,receipt)).status,200);
 assert.equal((await readCommerceDashboard('outsider',range,db)).orders.length,0);
 const review=(ref:string)=>reviewCommerceFulfillment('owner',ref,db,env,sender);
 const confirm=(ref:string,id:string)=>confirmCommerceFulfillment('owner',ref,id,db,env,sender);
 wrongRecipient=true;assert.equal((await review('54')).status,'unavailable');wrongRecipient=false;
 const denied=await review('54');assert(denied.status==='reviewed');refunded.add('54');
 assert.equal((await deliver('54',false,randomUUID(),'refunds/create')).status,200);
 assert.equal((await confirm('54',denied.review_id)).status,'blocked');assert.equal(posts,0);
 const a=await review('55'),b=await review('56');assert(a.status==='reviewed'&&b.status==='reviewed');timeout=true;
 const pending=await Promise.all([confirm('55',a.review_id),confirm('56',b.review_id)]);
 assert.deepEqual(pending.map(x=>x.status).sort(),['blocked','uncertain']);assert.equal(posts,1);
 assert.equal((await readCommerceDashboard('owner',range,db)).capital.held_minor,'2000');
 const ref=pending[0].status==='uncertain'?'55':'56';
 assert.equal((await confirm(ref,ref==='55'?a.review_id:b.review_id)).status,'blocked');assert.equal(posts,1);
 const pub='cHJpbnRmdWwtY29uZmln',pfKey=randomBytes(32).toString('hex'),when=new Date().toISOString();
 const nativeBody=JSON.stringify({type:'order_updated',store_id:12,occurred_at:when,data:{order:{id:1000+Number(ref),external_id:'shopify-'+ref,store_id:12,status:'pending'}}});
 const native=async(wrong=false)=>receivePrintful(new Request('http://localhost/printful',{method:'POST',body:nativeBody,
   headers:{'x-pf-webhook-public-key':pub,'x-pf-webhook-signature':wrong?'0'.repeat(64):createHmac('sha256',Buffer.from(pfKey,'hex')).update(nativeBody).digest('hex')}}),
   {...env,SHARKAI_PRINTFUL_WEBHOOK_KEYS:JSON.stringify({[pub]:{shop,secret:pfKey}})},async(s,e)=>{
      const o=e.data.order;return (await q('SELECT sharkai_commerce.supplier_observation($1,$2,$3,$4,$5,$6) r',[s,o.store_id,o.id,o.external_id,o.status,e.occurred_at])).rows[0].r;
   });
 assert.equal((await native(true)).status,403);assert.equal((await (await native()).json()).status,'recorded');assert.equal((await (await native()).json()).status,'replayed');
 assert.equal((await readCommerceDashboard('owner',range,db)).capital.held_minor,'2000');
 assert.equal((await report('cash','cash',{...money,cash_minor:'1250',settled_orders:[{order_ref:ref,supplier_id:String(1000+Number(ref)),cost_minor:'1250'}]})).status,200);
 const end=await readCommerceDashboard('owner',range,db);assert.equal(end.capital.held_minor,'0');assert.equal(end.capital.available_minor,'750');
 assert.equal(end.orders.find(o=>o.order_ref==='54')?.status,'refunded');
 await setCommerceCapital('owner',{currency:'EUR',amount_minor:'3500',agent_read_allowed:true},db);
 assert.equal((await report('cash','cash',{...money,cash_minor:'4000'})).status,200);
 const next=await review('57');assert(next.status==='reviewed');timeout=false;
 assert.equal((await confirm('57',next.review_id)).status,'accepted');assert.equal(posts,2);
 assert.equal((await confirm('57',next.review_id)).status,'blocked');assert.equal(posts,2);
 assert.equal(await setCommerceCapital('owner',{currency:'EUR',amount_minor:'0',agent_read_allowed:false},db),true);
 assert.deepEqual(await readCommerceAgentAccess('owner',db),{enabled:false,revision:3});
 await checkResaleEvidence(q,db);
 await checkProcurement(q,db);
 await checkResaleSettlements(q,db);
 console.log('Commerce PASS: real isolated PostgreSQL, Shopify signatures and canonical refunds, complete catalog and settled costs, isolated owner capital, supplier exact draft/protected cap, concurrent approvals, uncertain dispatch and signed cash reconciliation.');
}finally{
 if(db)await db.$disconnect();if(pool)await pool.end();if(started)await cluster.stop();
 assert((await realpath(dir)).toLowerCase().startsWith((base+sep).toLowerCase()));await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:150});
}
gracefulExit(0);
