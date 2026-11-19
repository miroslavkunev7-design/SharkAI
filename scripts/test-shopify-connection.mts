import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {commerceCredentials,readShopifyOrder,type Store} from '../lib/commerce/providers.server';
import {readShopifyConnection} from '../lib/commerce/shopify-connection.server';

const shop='isolated-merchant.myshopify.com',owner='isolated-merchant',appSecret=randomUUID(),appId=randomUUID();
const configured=(record:object)=>({SHARKAI_COMMERCE_STORES:JSON.stringify([record])});
const keys={shop,owner_id:owner,shopify_secret:appSecret,shopify_client_id:appId};
const env=configured(keys),never=async()=>{throw Error('Unexpected lookup');};
let grants=0,counts=0,lookups=0,incorrect=false,present=false,ordersDenied=false,identityDenied=false,expired='',scopeError=false;
let handles=['read_orders','read_products'];
const granted=()=>('credential-for-local-test-'+grants);
const mock:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));
  assert.equal(url.origin,'https://'+shop);assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.equal(init?.method,'POST');
  if(url.pathname==='/admin/oauth/access_token'){
    const form=init.body as URLSearchParams;
    assert.equal(form.get('client_secret'),appSecret);assert.equal(form.get('client_id'),appId);assert.equal(form.get('grant_type'),'client_credentials');
    grants++;return Response.json({access_token:granted(),expires_in:86399});
  }
  assert.equal(url.pathname,'/admin/api/2026-04/graphql.json');
  const access=new Headers(init.headers).get('X-Shopify-Access-Token');
  if(access===expired||identityDenied)return new Response(null,{status:401});
  assert(access===granted()||access==='existing-legacy-store-token');
  const inputBody=JSON.parse(String(init.body));
  if(inputBody.query.includes('SharkShopIdentity')){
    lookups++;assert(!/email|customer|payment|order\s*\(/i.test(inputBody.query));
    return Response.json({data:{shop:{myshopifyDomain:incorrect?'wrong.myshopify.com':shop},
      currentAppInstallation:scopeError?null:{accessScopes:handles.map(handle=>({handle}))}},
      ...(scopeError?{errors:[{message:'Restricted',path:['currentAppInstallation']}]}:{})});
  }
  if(inputBody.query.includes('SharkVisibleOrders')){
    counts++;assert(!/customer|address|amount|\bid\b/.test(inputBody.query));
    assert.match(inputBody.variables.filter,/^created_at:>='[\d:T.Z-]+'$/);
    const from=Date.parse(inputBody.variables.filter.split("'")[1]);assert(Math.abs(Date.now()-from-60*86400000)<5000);
    return ordersDenied?Response.json({data:{orders:null},errors:[{message:'Denied'}]}):
      Response.json({data:{orders:{nodes:present?[{__typename:'Order'}]:[]}}});
  }
  assert.match(inputBody.query,/query SharkOrder\(/);
  const stamp=new Date().toISOString(),money={shopMoney:{amount:'0.00',currencyCode:'EUR'}};
  return Response.json({data:{order:{id:inputBody.variables.id,test:false,createdAt:stamp,updatedAt:stamp,cancelledAt:null,
    displayFinancialStatus:'PAID',displayFulfillmentStatus:'UNFULFILLED',totalPriceSet:money,totalRefundedSet:money,
    shippingAddress:null,lineItems:{pageInfo:{hasNextPage:false},nodes:[]}}}});
};
const probe=()=>readShopifyConnection(owner,env,mock,never);
const pair=await Promise.all([probe(),probe()]);
for(const result of pair){
  assert.equal(result.status,'connected');assert.equal(result.shop,shop);assert.equal(result.orders_last_60_days,'none');assert.equal(result.order_access,'ready');
}
assert.equal(grants,1);assert.equal(lookups,2);
const bound:Store={id:randomUUID(),shop,printful_store:null,currency:'EUR',hard_cap:'1',contract:'c'.repeat(64),external_ref_prefix:''};
const order=await readShopifyOrder(bound,'9001',commerceCredentials(bound,env),mock);
assert.equal(order.source.order_ref,'9001');assert.equal(grants,1);
present=true;assert.equal((await probe()).orders_last_60_days,'present');
handles=['read_products'];const before=counts;
let result=await probe();assert.equal(result.status,'connected');assert.equal(result.order_access,'missing_scope');assert.equal(result.orders_last_60_days,'unverified');assert.equal(counts,before);
handles=['read_orders'];result=await probe();assert.equal(result.order_access,'missing_scope');assert.equal(result.orders_last_60_days,'present');
ordersDenied=true;assert.equal((await probe()).orders_last_60_days,'unverified');ordersDenied=false;
scopeError=true;result=await probe();assert.equal(result.status,'connected');assert.equal(result.order_access,'unverified');scopeError=false;
incorrect=true;assert.equal((await probe()).status,'identity_mismatch');incorrect=false;
expired=granted();result=await probe();assert.equal(result.status,'connected');assert.equal(grants,2);
identityDenied=true;assert.equal((await probe()).status,'unauthorized');identityDenied=false;
assert.equal((await readShopifyConnection('different-owner',env,mock,never)).status,'not_configured');
assert.equal((await readShopifyConnection(owner,{},never,never)).status,'not_configured');
const legacy=configured({shop,shopify_access_token:'existing-legacy-store-token',shopify_secret:appSecret});
assert.equal((await readShopifyConnection(owner,legacy,mock,async()=>null)).status,'not_configured');
assert.equal((await readShopifyConnection(owner,legacy,mock,async()=>shop)).status,'connected');
assert.equal((await readShopifyConnection(owner,{SHARKAI_COMMERCE_STORES:JSON.stringify([keys,keys])},never,never)).status,'unavailable');
assert.equal((await readShopifyConnection(owner,configured({...keys,shop:'example.invalid'}),never,never)).status,'unavailable');
console.log('Shopify connection PASS: owner isolation, exact canonical store, independent scope and visible-order checks, compatible credentials, shared read-only token cache, renewal after rejection and real order-adapter contract.');
