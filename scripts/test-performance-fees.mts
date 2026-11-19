import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {acceptFeeStatement,adminFeePeriod} from '../lib/investments/performance-fee.server';

const root=await realpath(process.env.SHARKAI_EMBEDDED_PG_ROOT??'D:/SharkAI-workbench/telegram-db-test');
const dep=(name:string)=>import(pathToFileURL(join(root,'node_modules',name)).href);
const {default:EmbeddedPostgres}=await dep('embedded-postgres/dist/index.js');
const {default:pg}=await dep('pg/lib/index.js');
const {initdb}=await dep('@embedded-postgres/windows-x64/dist/index.js');
const {gracefulExit}=await dep('exit-hook/index.js');
const dir=await mkdtemp(join(root,'performance-fees-'));
const dbdir=join(dir,'db'),pwfile=join(dir,'password'),password=randomBytes(24).toString('hex');
const listener=createServer();
await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
const address=listener.address();
assert(address && typeof address!=='string');
const port=address.port;
await new Promise<void>(resolve=>listener.close(()=>resolve()));
const engine=new EmbeddedPostgres({databaseDir:dbdir,port,user:'fee_test',password,persistent:true,
  postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:()=>{}});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
let pool:any;
let running=false;
try {
  await writeFile(pwfile,password+'\n',{mode:0o600});
  await promisify(execFile)(initdb,['--pgdata='+dbdir,'--username=fee_test','--pwfile='+pwfile,
    '--auth=scram-sha-256','--encoding=UTF8','--locale=C','--no-sync','--no-instructions']);
  await rm(pwfile);
  await engine.start();running=true;
  pool=new pg.Pool({host:'127.0.0.1',port,user:'fee_test',password,database:'postgres',max:4});
  const q=(sql:string,args:unknown[]=[])=>pool.query(sql,args);
  await q(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA sharkai_broker;
    CREATE TABLE public."User"(id text primary key,role text,plan text default 'FREE',name text,email text,"createdAt" timestamp default '2025-01-01 12:00');
    CREATE TABLE sharkai_broker.account(id text primary key,user_id text,provider text,provider_key text,currency text,snapshot_at timestamptz,profit_allocation_revision bigint not null default 0);
    CREATE TABLE sharkai_broker.owner_mandate(version uuid primary key,account_id text,user_id text,approved_terms jsonb,
      accepted_at timestamptz,expires_at timestamptz,revoked_at timestamptz);`);
  await q(await readFile(new URL('../n8n/sql/investment-performance-fee.sql',import.meta.url),'utf8'));
  const mandate=randomUUID(), agreement=sha('test-fee-agreement'),beneficiary=sha('test-admin-account');
  const terms={performance_fee_bps:1000,capital_source:'verified_settled_realized_profit_only',start_date:'2025-01-01',period:'DAY'};
  await q(`INSERT INTO public."User"(id,role,email) VALUES ('admin','ADMIN','admin@example.test'),('client','USER','client@example.test'),('other','ADMIN','other@example.test');
    INSERT INTO sharkai_broker.account VALUES('test-account','client','IBKR','fixture','EUR',now());`);
  await q("INSERT INTO sharkai_broker.owner_mandate VALUES($1,'test-account','client',$2,'2025-01-01','2025-12-31',null)",[mandate,terms]);
  await q("INSERT INTO sharkai_broker.fee_agreement VALUES('test-account','admin',$1,$2,'report','credit','2025-01-01','2025-01-01','2025-12-31',null)",[beneficiary,agreement]);
  const key={report:randomBytes(32).toString('hex'),credit:randomBytes(32).toString('hex')};
  const env={SHARKAI_FEE_EVIDENCE_ENABLED:'true',SHARKAI_FEE_COLLECTOR_KEYS:JSON.stringify(key)};
  const send=async(event:Record<string,unknown>,signer:'report'|'credit'='report',incorrect=false)=>{
    const time=String(Math.floor(Date.now()/1000)),raw=JSON.stringify(event);
    const signature=createHmac('sha256',Buffer.from(key[signer],'hex')).update('sharkai-performance-fee/v1\n'+signer+'\n'+time+'\n'+raw).digest('hex');
    const req=new Request('http://localhost/fee',{method:'POST',body:raw,headers:{'Content-Type':'application/json',
      'X-Shark-Fee-Collector':signer,'X-Shark-Fee-Time':time,'X-Shark-Fee-Signature':incorrect?'0'.repeat(64):signature}});
    let databaseError:unknown;
    const response=await acceptFeeStatement(req,env,async(id,body,digest)=>{
      try {return (await q('SELECT sharkai_broker.record_performance_fee($1,$2,$3) AS s',[id,body,digest])).rows[0].s;}
      catch(error){databaseError=error;throw error;}
    });
    if(databaseError) throw databaseError;
    return response;
  };
  const day=(n:number)=>'2025-01-'+String(n).padStart(2,'0');
  const period=(start:number,opens:number,closes:number,openLoss=0)=>({operation:'period',agreement_digest:agreement,currency:'EUR',
    period_start:day(start),period_end:day(start+1),mandate_id:mandate,report_ref:'statement-'+start,
    basis:'cumulative_settled_realized_after_all_costs_before_platform_fee_ex_flow',opening_net_minor:String(opens),
    closing_net_minor:String(closes),closing_unrealized_loss_minor:String(openLoss)});
  const first=period(1,100000,110000);
  assert.equal((await send(first,'report',true)).status,403);
  assert.equal((await send(first,'credit')).status,403);
  assert.equal((await send({...first,beneficiary_hash:beneficiary})).status,400);
  assert.equal((await send(period(2,110000,115000))).status,409);
  const attempts=await Promise.all([send(first),send(first)]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,201]);
  assert.equal((await send({...first,closing_net_minor:'120000'})).status,409);
  assert.equal((await send(period(2,110000,106000))).status,201);
  assert.equal((await send(period(3,106000,110000))).status,201);
  assert.equal((await send(period(4,110000,113000))).status,201);
  assert.equal((await send(period(5,113000,113009))).status,201);
  assert.equal((await send(period(6,113009,113010))).status,201);
  assert.equal((await send(period(7,113010,113510,500))).status,201);
  assert.equal((await send(period(8,113510,114010,500))).status,201);
  assert.deepEqual((await q('SELECT fee_minor FROM sharkai_broker.performance_fee_period ORDER BY ends_on')).rows.map((r:{fee_minor:string})=>r.fee_minor),
    ['1000','0','0','300','0','1','0','50']);
  const credit={operation:'credit',agreement_digest:agreement,currency:'EUR',period_end:day(2),amount_minor:'1000',beneficiary_hash:beneficiary,
    receipt_ref:'paired-provider-receipt',posted_at:'2025-01-10T12:00:00Z',
    posting:'provider_final_client_debit_and_beneficiary_credit',debited_account_hash:sha('IBKR/fixture')};
  assert.equal((await send({...credit,beneficiary_hash:sha('different destination')},'credit')).status,409);
  assert.equal((await send({...credit,amount_minor:'1001'},'credit')).status,409);
  assert.equal((await send(credit,'report')).status,403);
  assert.equal((await send(credit,'credit')).status,200);
  assert.equal((await send(credit,'credit')).status,200);
  let total=(await q("SELECT * FROM sharkai_broker.admin_fee_receipts('admin')")).rows[0];
  assert.deepEqual(total,{currency:'EUR',credited_minor:'1000',accrued_minor:'351'});
  assert.deepEqual((await q("SELECT * FROM sharkai_broker.admin_fee_receipts('other')")).rows,[]);
  assert.equal((await q("SELECT sharkai_broker.owner_performance_fee('other') AS fee")).rows[0].fee,null);
  const reversal={operation:'reversal',agreement_digest:agreement,currency:'EUR',period_end:day(2),amount_minor:'1000',
    beneficiary_hash:beneficiary,original_credit_ref:credit.receipt_ref,receipt_ref:'verified-reversal',
    posted_at:'2025-01-11T12:00:00Z',posting:'provider_final_full_fee_reversal'};
  assert.equal((await send(reversal,'credit')).status,200);
  total=(await q("SELECT * FROM sharkai_broker.admin_fee_receipts('admin')")).rows[0];
  assert.equal(total.credited_minor,'0');
  assert.equal((await q("SELECT sharkai_broker.performance_fee_hold('client','test-account','EUR',113510) AS hold")).rows[0].hold,null);
  assert.equal((await q("SELECT sharkai_broker.performance_fee_hold('other','test-account','EUR',113510) AS hold")).rows[0].hold,null);
  await q(await readFile(new URL('../n8n/sql/admin-investment-report.sql',import.meta.url),'utf8'));
  await q(`INSERT INTO public."User"(id,role,plan,email,"createdAt") VALUES
    ('new','USER','FREE','new@example.test','2025-03-29 22:00'),
    ('before','USER','FREE','before@example.test','2025-03-29 21:59:59.999'),
    ('after','USER','FREE','after@example.test','2025-03-30 21:00'),
    ('internal','USER','FREE','guest@sharkai.local','2025-03-30 13:00');
    UPDATE public."User" SET plan='PRO' WHERE id='new'`);
  const report=async(actor:string,from:string,to:string,page=1)=>(await q('SELECT sharkai_broker.admin_fee_dashboard($1,$2,$3,$4) AS r',[actor,from,to,page])).rows[0].r;
  const march=await report('admin','2025-03-30','2025-03-30');
  assert.equal(march.totalRegistrations,1);
  assert.deepEqual([march.members[0].id,march.members[0].plan,march.members[0].signupPlan],['new','PRO','FREE']);
  assert.equal(march.registrations.find((p:{plan:string})=>p.plan==='PRO').count,1);
  assert.equal((await report('admin',day(1),day(1))).members[0].signupPlan,null);
  assert.equal((await report('admin',day(10),day(10))).currencies[0].credited_minor,'1000');
  assert.equal((await report('admin',day(11),day(11))).currencies[0].net_received_minor,'-1000');
  assert.equal((await report('admin',day(4),day(4))).currencies[0].accrued_minor,'300');
  assert.deepEqual((await report('other',day(1),day(12))).currencies,[]);
  assert.equal(await report('client',day(1),day(12)),null);
  assert.equal(adminFeePeriod(new URLSearchParams('from=2025-03-30&to=2025-02-30')),null);
  assert.equal(adminFeePeriod(new URLSearchParams('from=2025-03-30&to=2025-03-30&page=0')),null);
  assert.equal(adminFeePeriod(new URLSearchParams('to=2099-01-01')),null);
  assert.deepEqual(adminFeePeriod(new URLSearchParams(),new Date('2025-03-31T21:30:00Z')),{from:'2025-04-01',to:'2025-04-01',page:1});
  await assert.rejects(q("UPDATE sharkai_broker.fee_agreement SET beneficiary_user_id='other'"));
  for (const [schema,start,end,valid] of [
    [{period:'WEEK',start_date:day(1)},day(1),day(8),true],[{period:'WEEK',start_date:day(1)},day(2),day(9),false],
    [{period:'CUSTOM_DAYS',days:3,start_date:day(1)},day(4),day(7),true],
    [{period:'MONTH',start_date:day(31)},'2025-02-28','2025-03-31',true],
  ]) assert.equal((await q('SELECT sharkai_broker.fee_period_matches($1,$2,$3) ok',[schema,start,end])).rows[0].ok,valid);
  console.log('Performance fee and admin checks passed: signed 10% billing, carryforward and protected funds, independent receipt/reversal, signup plans, Sofia DST/reporting windows and tenant isolation.');
} finally {
  if(pool) await pool.end();
  if(running) await engine.stop();
  if(!(await realpath(dir)).toLowerCase().startsWith((root+sep).toLowerCase())) throw Error('Unexpected test directory');
  await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
gracefulExit(0);
