import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {authorizedCommerceRead,issueCommerceGrant} from '../lib/commerce/agent-access.server';
import {signWalletStatusGrant} from '../lib/wallet-investments-grants';
import {capitalInput,commerceRange,fulfillmentInput} from '../lib/commerce/owner-input';

const service=randomBytes(32).toString('hex');
process.env.SHARKAI_WALLET_STATUS_SERVICE_SECRET=service;
process.env.SHARKAI_WALLET_STATUS_GRANT_SECRET=randomBytes(32).toString('hex');
const state={enabled:true,revision:3};
const access=async(user:string)=>{assert.equal(user,'fixture-owner');return {...state};};
const grant=await issueCommerceGrant('fixture-owner','binding-a',access);
assert.ok(grant);
const packet=(token:string,body:object={},bearer=service)=>new Request('http://localhost/analytics',{
  method:'POST',headers:{authorization:'Bearer '+bearer,'X-Shark-Commerce-Grant':token,'Content-Type':'application/json'},body:JSON.stringify(body),
});
const project=async(user:string)=>({owner:user});
let paired=true;
const chat=async(id:string,user:string)=>paired&&id==='binding-a'&&user==='fixture-owner';
assert.equal((await authorizedCommerceRead(packet(grant),project,access,chat)).status,200);
assert.equal((await authorizedCommerceRead(packet(grant,{},'wrong'),project,access,chat)).status,403);
assert.equal((await authorizedCommerceRead(packet(grant,{owner:'someone-else'}),project,access,chat)).status,400);
assert.equal((await authorizedCommerceRead(packet((await signWalletStatusGrant('fixture-owner',3))!),project,access,chat)).status,403);
paired=false;
assert.equal((await authorizedCommerceRead(packet(grant),project,access,chat)).status,403);
paired=true;
const withdrawn=await authorizedCommerceRead(packet(grant),async()=>{state.enabled=false;return {private:'fixture'};},access,chat);
assert.equal(withdrawn.status,403);
assert(!JSON.stringify(await withdrawn.json()).includes('fixture'));
assert.equal(await issueCommerceGrant('fixture-owner',undefined,access),null);
state.enabled=true;state.revision++;
assert.equal((await authorizedCommerceRead(packet(grant),project,access,chat)).status,403);
assert(capitalInput.safeParse({currency:'EUR',amount_minor:'0',agent_read_allowed:false}).success);
assert(!capitalInput.safeParse({currency:'EUR',amount_minor:'10',owner:'different'}).success);
assert(!fulfillmentInput.safeParse({action:'confirm',order_ref:'4'}).success);
assert(!commerceRange(new URLSearchParams({from:'2024-01-01',to:'2026-01-01'})));
console.log('Commerce grants: distinct scopes, source identity, revocation during reads, Telegram unlink and owner-only write inputs passed.');
