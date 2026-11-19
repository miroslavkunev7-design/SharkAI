import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {confirmOwnerMandate,readOwnerMandates} from '../lib/investments/trading-consent.server';

const owner={id:'local-consent-test',plan:'PRO'};
const terms={policy_id:randomUUID(),provider:'saxo',plan:'PRO',currency:'EUR',
  capital_minor:'1000',max_loss_minor:'100',max_positions:1,assets:['EUR-FIXTURE'],
  strategy:'local-only',period:'DAY',days:null,start_date:'2026-11-19',goal_minor:null,goal_bps:null,
  expires_at:new Date(Date.now()+300_000).toISOString()};
const protection={capital_source:'verified_settled_realized_profit_only',protection_policy_id:randomUUID(),
  protection_digest:'9'.repeat(64)};
const digest='d'.repeat(64);
const key=randomBytes(32).toString('base64url');
process.env.SHARKAI_TRADING_CONSENT_ENABLED='true';
process.env.SHARKAI_TRADING_CONSENT_SECRET=key;
let currentTerms:typeof terms=terms;
let accepted=0;
const db={$queryRaw:async(query:TemplateStringsArray)=>{
  const sql=query.join('?');
  if(sql.includes('to_regprocedure')) return [{ready:true}];
  if(sql.includes('accept_owner_mandate')) {accepted++;return [{accepted:true}];}
  return [{result:{offers:[{terms:currentTerms,digest}],active:{terms:currentTerms,accepted_at:new Date().toISOString(),valid:true}}}];
}} as unknown as NonNullable<Parameters<typeof readOwnerMandates>[1]>;

assert.deepEqual(await readOwnerMandates(owner,db),{active:null,offers:[]});
const oldReview=await new SignJWT({policy:terms.policy_id,digest,plan:owner.plan})
  .setProtectedHeader({alg:'HS256'}).setSubject(owner.id).setIssuer('sharkai')
  .setAudience('sharkai:owner:trading-review').setIssuedAt().setExpirationTime('5m')
  .sign(new TextEncoder().encode(key));
assert.equal(await confirmOwnerMandate(owner,{accepted:true,review:oldReview},db),false);
assert.equal(accepted,0);
currentTerms={...terms,...protection};
assert.deepEqual(await readOwnerMandates(owner,db),{active:null,offers:[]});
currentTerms={...currentTerms,...{performance_fee_bps:1000}};
const result=await readOwnerMandates(owner,db);
assert.equal(result.offers.length,1);
assert.equal(result.active?.terms.protection_digest,protection.protection_digest);
assert.equal(await confirmOwnerMandate(owner,{accepted:true,review:result.offers[0].review},db),true);
assert.equal(accepted,1);
console.log('Legacy mandate, legacy signed approval, and explicit profit-only policy review checks passed.');
