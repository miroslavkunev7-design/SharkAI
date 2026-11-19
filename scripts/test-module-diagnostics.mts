import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { runModuleDiagnostics } from '../lib/investments/module-diagnostics.server';

const secret=randomBytes(32).toString('hex');
const id='system-check-123';
const env={SHARKAI_WALLET_STATUS_SERVICE_SECRET:secret,SHARKAI_DIAGNOSTIC_ACCOUNT_ID:'fixture-owner-private'};
const request=(body:unknown,auth='Bearer '+secret)=>new Request('http://localhost/api/internal/wallet-investments/diagnostics',{
  method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify(body),
});
const calls:string[]=[];
const probes={
  schema:async()=>{calls.push('schema');return true;},
  stripe:()=>({status:'passed' as const,detail:'Проверен подпис.'}),
  owner:async(user:string)=>{
    calls.push(user);
    return {W21:{status:'passed' as const,detail:'Проверен диапазон.'},W31:{status:'passed' as const,detail:'Проверен баланс.'},
      W33:{status:'passed' as const,detail:'Потвърждава собственикът.'},WORKER:{status:'unverified' as const,detail:'Очаква свързване.'}};
  },
};
assert.equal((await runModuleDiagnostics(request({probe_id:id},'Bearer wrong'),probes,env)).status,403);
assert.equal((await runModuleDiagnostics(request({probe_id:id}),probes,{})).status,403);
assert.equal((await runModuleDiagnostics(request({probe_id:id,user_id:'victim'}),probes,env)).status,400);
assert.equal((await runModuleDiagnostics(request({probe_id:'a'.repeat(1024)}),probes,env)).status,400);
assert.deepEqual(calls,[]);
const response=await runModuleDiagnostics(request({probe_id:id}),probes,env);
assert.equal(response.status,200);
assert.equal(response.headers.get('cache-control'),'private, no-store');
const output=await response.json();
assert.equal(output.contract,'sharkai-module-diagnostics-v1');
assert.equal(output.probe_id,id);
assert.ok(Number.isFinite(Date.parse(output.checked_at)));
assert.deepEqual(calls,['schema','fixture-owner-private']);
assert.deepEqual(output.checks.map((e:{id:string})=>e.id),[
  'DB','W01','W02','W03','W04','W10','W11','W12','W13','W14','W19','W20','W21','W23','W24','W25','W29','W30','W31','W32','W33','W39','CAPITAL','MANDATE','WORKER','FEE',
  'STRATEGIES','SHOP_ORDERS','SHOP_CAPITAL','SHOP_FULFILLMENT','SHOP_PRODUCTS','SHOP_SETTLEMENT','SHOP_PROCUREMENT',
]);
assert.equal(output.checks.find((e:{id:string})=>e.id==='W21').status,'passed');
for (const check of output.checks) assert.deepEqual(Object.keys(check).sort(),['detail','id','label','status']);
assert.doesNotMatch(JSON.stringify(output),/fixture-owner-private|cash_available_minor|balance_minor|Bearer/);
const missing=await (await runModuleDiagnostics(request({probe_id:id}),{...probes,owner:async()=>({})},env)).json();
assert.equal(missing.checks.find((e:{id:string})=>e.id==='W31').status,'unverified');
assert.equal(missing.checks.find((e:{id:string})=>e.id==='CAPITAL').status,'unverified');
const failed=await (await runModuleDiagnostics(request({probe_id:id}),{
  ...probes,schema:async()=>{throw Error('private SQL details');},owner:async()=>{throw Error('should never execute');},
},env)).json();
assert.equal(failed.checks.find((e:{id:string})=>e.id==='DB').status,'failed');
assert.doesNotMatch(JSON.stringify(failed),/private SQL details|should never execute/);
console.log('Module diagnostic contract passed: auth, bounded request, owner isolation, no disclosures, full required IDs, success, missing source, DB failure.');
