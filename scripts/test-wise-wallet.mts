import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { jsx } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { WiseWindowLink, WiseReviewForm } from '../app/wallet/wise-window';
import { resolveWalletStatus, walletOwnerCapabilities } from '../lib/investments/wallet-status.server';
import { projectWiseDeposits, projectWiseTransactions, readWalletDeposits, walletKyc, wiseAccountHandoff } from '../lib/investments/wallet-operations.server';
import type { WiseTransport } from '../lib/investments/wise-wallet.server';

const now = new Date('2026-11-19T11:00:00.000Z');
const owner = { userId: 'fixture-owner', currency: 'EUR' };
const fixtureToken = 'fixture.restricted.token';
const binding = {
  owner_id: owner.userId,
  provider_user_id: '101',
  profile_id: '202',
  balance_id: '303',
  currency: 'EUR',
  provider_read_approval_ref: 'fixture-only',
  token_sha256: createHash('sha256').update(fixtureToken).digest('hex'),
  token_expires_at: '2026-11-19T21:00:00.000Z',
};

const makeEnv = (changes: Partial<typeof binding> = {}): NodeJS.ProcessEnv => ({
  WALLET_PROVIDER: 'wise',
  WISE_WALLET_OWNER_BINDING: JSON.stringify({ ...binding, ...changes }),
  WISE_WALLET_OAUTH_ACCESS_TOKEN: fixtureToken,
  WISE_WALLET_SERVER_CA_PEM: 'fixture-ca-only',
  WISE_WALLET_CLIENT_CERT_PEM: 'fixture-cert-only',
  WISE_WALLET_CLIENT_KEY_PEM: 'fixture-key-only',
});

test('personal Wise access is a real isolated link; enrolled identity checks submit to the owner-only endpoint',()=>{
  const link=renderToStaticMarkup(jsx(WiseWindowLink,{className:'button',children:'Отвори моя Wise'}));
  assert.match(link,/href="https:\/\/wise\.com\/home\/"/);
  assert.match(link,/target="_blank"/);
  assert.match(link,/rel="noopener noreferrer"/);
  assert.match(link,/Отвори моя Wise/);
  const review=renderToStaticMarkup(jsx(WiseReviewForm,{className:'button',children:'Проверка в Wise'}));
  assert.match(review,/action="\/api\/wallet-investments\/provider\/onboarding"/);
  assert.match(review,/method="POST"/i);
});

test('statement credits are bound to the selected balance, currency and exact seven-day window', async()=>{
  const from=new Date(now.valueOf()-7*86_400_000);
  const row={type:'CREDIT',date:now.toISOString(),amount:{value:12.45,currency:'EUR'},
    details:{type:'MONEY_ADDED',senderName:'private'},referenceNumber:'ref-one'};
  const raw={query:{accountId:303,currency:'EUR',intervalStart:from.toISOString(),intervalEnd:now.toISOString()},
    endOfStatementBalance:{value:100,currency:'EUR'},transactions:[row,{...row,details:{type:'CONVERSION'},referenceNumber:'ref-two'}]};
  const result=projectWiseDeposits(raw,'303','EUR',2,from,now)!;
  assert.equal(result.count,1); assert.equal(result.latest!.amount_minor,'1245');
  assert(!JSON.stringify(result).includes('private')); assert(!JSON.stringify(result).includes('ref-one'));
  assert.equal(projectWiseDeposits(raw,'304','EUR',2,from,now),null);
  assert.equal(projectWiseDeposits(raw,'303','EUR',2,new Date(from.valueOf()-1),now),null);
  assert.equal(projectWiseDeposits({...raw,transactions:[row,row]},'303','EUR',2,from,now),null);
  assert.equal(projectWiseDeposits({...raw,transactions:[]},'303','EUR',2,from,now)?.count,0);
  const debit={...row,type:'DEBIT',amount:{value:-2.56,currency:'EUR'},details:{type:'CARD',merchant:'private'},referenceNumber:'ref-card'};
  const history=projectWiseTransactions({...raw,transactions:[row,debit]},'303','EUR',2,from,now);
  assert.deepEqual(history?.transactions.map(x=>[x.direction,x.amount_minor,x.category]),[['credit','1245','Захранване'],['debit','256','Плащане с карта']]);
  assert(!JSON.stringify(history).includes('private'));
  assert.equal(projectWiseTransactions({...raw,transactions:[debit,debit]},'303','EUR',2,from,now),null);
  const env={...makeEnv(),WISE_WALLET_OWNER_BINDING:JSON.stringify({...binding,statement_approval_ref:'fixture'})};
  const fixture=fixtureTransport({'/2026Q4/profiles/202/balance-statements/303/statement.json':raw});
  assert.equal((await readWalletDeposits(owner,now,env,fixture.transport))?.count,1);
  assert.equal(await readWalletDeposits(owner,now,makeEnv(),failIfCalled),null);
  assert.equal(await readWalletDeposits({...owner,userId:'other'},now,env,failIfCalled),null);
  assert.equal(await readWalletDeposits(owner,now,env,async()=>{throw new Error('SCA required')}),null);
});

test('KYC starts only for the owner with an active Wise review; only owner POST receives its short-lived link', async()=>{
  const id='12345678-aaaa-4aaa-aaaa-123456789012';
  const env={...makeEnv(),NEXT_PUBLIC_APP_URL:'https://example.invalid',
    WISE_WALLET_OWNER_BINDING:JSON.stringify({...binding,hosted_review:{id,approval_ref:'fixture'}})};
  const route='/2026Q4/profiles/202/kyc-reviews/'+id;
  const url='https://wise.com/embedded-flows/verification?token=synthetic';
  const base=fixtureTransport({[route]:{id,status:'WAITING_CUSTOMER_INPUT'}});
  const make=(link:string,expires:string): WiseTransport => async (actual,options)=>{
    if (options.method==='PATCH') {
      assert.equal(actual.pathname,route); assert.equal(JSON.parse(options.body!).redirectUrl,'https://example.invalid/wallet');
      return {id,status:'WAITING_CUSTOMER_INPUT',link:{value:link,expiresAt:expires}};
    }
    return base.transport(actual,options);
  };
  const expires=new Date(now.valueOf()+290000).toISOString();
  assert.deepEqual(await walletKyc(owner,false,now,env,make(url,expires)),{status:'WAITING_CUSTOMER_INPUT',url:null});
  assert.deepEqual(await walletKyc(owner,true,now,env,make(url,expires)),{status:'WAITING_CUSTOMER_INPUT',url});
  assert.equal(await walletKyc(owner,true,now,env,make('https://wise.com.evil.test/embedded-flows/verification?token=x',expires)),null);
  assert.equal(await walletKyc(owner,true,now,env,make(url,now.toISOString())),null);
  assert.equal(await walletKyc({...owner,userId:'wrong'},true,now,env,failIfCalled),null);
  assert.equal(await walletKyc(owner,true,now,makeEnv(),failIfCalled),null);
  assert.deepEqual(await walletKyc(owner,true,now,env,fixtureTransport({[route]:{id,status:'PASSED'}}).transport),{status:'PASSED',url:null});
});

const failIfCalled: WiseTransport = async () => {
  assert.fail('unexpected network read');
};

test('multiple enrolled owners select only their provider identity, balance, and credential',async()=>{
  const second={...binding,owner_id:'second',provider_user_id:'102',profile_id:'203',balance_id:'304'};
  const both=[{binding,token_secret_name:'WISE_WALLET_USER_TOKEN_FIRST'},{binding:second,token_secret_name:'WISE_WALLET_USER_TOKEN_SECOND'}];
  const env={...makeEnv(),WISE_WALLET_OWNER_BINDING:undefined,WISE_WALLET_ENROLLMENTS:JSON.stringify(both),
    WISE_WALLET_USER_TOKEN_FIRST:fixtureToken,WISE_WALLET_USER_TOKEN_SECOND:'revoked-token'};
  assert.equal((await resolveWalletStatus(owner,now,env,fixtureTransport().transport)).status,'verified');
  assert.equal((await resolveWalletStatus({userId:'second',currency:'EUR'},now,env,failIfCalled)).status,'provider_unconfigured');
  assert.equal((await resolveWalletStatus({userId:'stranger',currency:'EUR'},now,env,failIfCalled)).status,'provider_unlinked');
  const bothUseSameAccount=[both[0],{...both[1],binding:{...second,balance_id:binding.balance_id}}];
  assert.equal((await resolveWalletStatus(owner,now,{...env,WISE_WALLET_ENROLLMENTS:JSON.stringify(bothUseSameAccount)},failIfCalled)).status,'provider_unconfigured');
});

const suppliedBalance = {
  id: 303,
  type: 'STANDARD',
  investmentState: 'NOT_INVESTED',
  currency: 'EUR',
  visible: true,
  amount: { value: 39.15, currency: 'EUR' },
  reservedAmount: { value: 2, currency: 'EUR' },
  cashAmount: { value: 41.15, currency: 'EUR' },
  totalWorth: { value: 410, currency: 'EUR' },
  modificationTime: '2026-09-01T00:00:00.000Z',
  fees: { value: 199, currency: 'EUR' },
};

const fixedPaths = ['/2026Q4/me', '/2026Q4/profiles/202', '/2026Q4/profiles/202/balances/303'];

function fixtureTransport(changes: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const assertions: Array<Parameters<WiseTransport>[1]> = [];
  const bodies: Record<string, unknown> = {
    [fixedPaths[0]]: { id: 101, active: true, email: 'fixture@example.test', phoneNumber: 'fixture' },
    [fixedPaths[1]]: { id: 202, userId: 101, currentState: 'VISIBLE', address: 'fixture' },
    [fixedPaths[2]]: suppliedBalance,
    ...changes,
  };
  const transport: WiseTransport = async (url, options) => {
    calls.push(url.href);
    assertions.push(options);
    return bodies[url.pathname];
  };
  return { calls, assertions, transport };
}

test('disabled, unsupported or incomplete provider contracts make no reads', async () => {
  for (const env of [
    {},
    { ...makeEnv(), WALLET_PROVIDER: 'openpayd' },
    makeEnv({ provider_read_approval_ref: '' }),
    { ...makeEnv(), WISE_WALLET_SERVER_CA_PEM: '' },
    { ...makeEnv(), WISE_WALLET_OAUTH_ACCESS_TOKEN: 'different.token' },
    makeEnv({ token_expires_at: '2026-12-20T00:00:00.000Z' }),
    makeEnv({ balance_id: '../../wallet/other' }),
    makeEnv({ balance_id: '9007199254740992' }),
  ]) {
    const result = await resolveWalletStatus(owner, now, env, failIfCalled);
    assert.deepEqual(result, {
      status: 'provider_unconfigured', provider: null, balance_minor: null,
      currency: null, observed_at: null, source: null,
    });
  }
});

test('unlinked user or unapproved currency yields no amount and cannot reach Wise', async () => {
  for (const actor of [{ ...owner, userId: 'wrong-owner' }, { ...owner, currency: 'GBP' }]) {
    const result = await resolveWalletStatus(actor, now, makeEnv(), failIfCalled);
    assert.equal(result.status, 'provider_unlinked');
    assert.equal(result.balance_minor, null);
  }
  const env = { ...makeEnv(), WISE_WALLET_OWNER_BINDING: undefined };
  assert.equal((await resolveWalletStatus(owner, now, env, failIfCalled)).status, 'provider_unlinked');
});

test('a single approved owner currency resolves automatically; multiple currencies require an explicit choice',async()=>{
  const firstVisit={...owner,currency:null};
  const env=makeEnv();
  assert.equal((await resolveWalletStatus(firstVisit,now,env,fixtureTransport().transport)).currency,'EUR');
  assert.equal(await wiseAccountHandoff(firstVisit,now,env,fixtureTransport().transport),'https://wise.com/home/');
  assert.equal(await wiseAccountHandoff({...firstVisit,userId:'other'},now,env,failIfCalled),'/wallet?tab=wise-connection');
  const sterling={...binding,currency:'GBP',balance_id:'304',statement_approval_ref:'fixture-statements'};
  const multiple={...env,WISE_WALLET_OWNER_BINDING:undefined,WISE_WALLET_USER_TOKEN_ONLY:fixtureToken,
    WISE_WALLET_ENROLLMENTS:JSON.stringify([binding,sterling].map(row=>({binding:row,token_secret_name:'WISE_WALLET_USER_TOKEN_ONLY'})))};
  const options=walletOwnerCapabilities(firstVisit,now,multiple);
  assert.deepEqual(options,{currencies:['EUR','GBP'],selected_currency:null,deposit_statements:false,hosted_kyc:false});
  assert.equal((await resolveWalletStatus(firstVisit,now,multiple,failIfCalled)).status,'provider_unlinked');
  assert.equal(await wiseAccountHandoff(firstVisit,now,multiple,failIfCalled),'/wallet?tab=wise-connection');
  assert.deepEqual(walletOwnerCapabilities({...firstVisit,userId:'stranger'},now,multiple).currencies,[]);
  assert.equal(walletOwnerCapabilities({...firstVisit,currency:'GBP'},now,multiple).deposit_statements,true);
  assert.equal(walletOwnerCapabilities({...firstVisit,currency:'USD'},now,multiple).selected_currency,null);
  const read=fixtureTransport({'/2026Q4/profiles/202/balances/304':{...suppliedBalance,id:304,currency:'GBP',amount:{value:21,currency:'GBP'}}});
  const chosen=await resolveWalletStatus({...owner,currency:'GBP'},now,multiple,read.transport);
  assert.equal(chosen.currency,'GBP');
  assert.equal(chosen.balance_minor,'2100');
  assert.equal(read.calls.length,3);
});

test('expired production token does not contact provider', async () => {
  const expired = await resolveWalletStatus(owner, now, makeEnv({ token_expires_at: now.toISOString() }), failIfCalled);
  assert.equal(expired.status, 'stale');
  assert.equal(expired.balance_minor, null);
});

test('verified owner, OAuth subject, profile and balance produce an isolated status with provenance', async () => {
  const { transport, calls, assertions } = fixtureTransport();
  const result = await resolveWalletStatus(owner, now, makeEnv(), transport);
  assert.deepEqual(calls, fixedPaths.map((path) => 'https://api-mtls.transferwise.com' + path));
  assert.deepEqual(result, {
    status: 'verified', provider: 'wise', currency: 'EUR',
    balance_minor: '3915', observed_at: now.toISOString(), source: 'wise_balance_api',
  });
  assert.equal(assertions.length, 3);
  assert.equal(new Set(assertions.map(({ signal }) => signal)).size, 1);
  assert.equal(new Set(assertions.map(({ headers }) => headers['X-External-Correlation-Id'])).size, 3);
  assert.ok(assertions.every(({ headers }) => headers.Authorization === `Bearer ${fixtureToken}`));
});

test('a real provider zero stays zero even if other reported amounts or fees are positive', async () => {
  const { transport } = fixtureTransport({
    [fixedPaths[2]]: { ...suppliedBalance, amount: { value: 0, currency: 'EUR' } },
  });
  const result = await resolveWalletStatus(owner, now, makeEnv(), transport);
  assert.equal(result.status, 'verified');
  assert.equal(result.balance_minor, '0');
  assert.equal('fees' in result, false);
  assert.equal('totalWorth' in result, false);
});

test('mismatched provider subject or profile ownership stops before the amount read', async () => {
  for (const [path, response, expectedCount] of [
    [fixedPaths[0], { id: 102, active: true }, 1],
    [fixedPaths[0], { id: 101, active: false }, 1],
    [fixedPaths[1], { id: 202, userId: 222, currentState: 'VISIBLE' }, 2],
    [fixedPaths[1], { id: 999, userId: 101, currentState: 'VISIBLE' }, 2],
    [fixedPaths[1], { id: 202, userId: 101, currentState: 'DEACTIVATED' }, 2],
  ] as const) {
    const { transport, calls } = fixtureTransport({ [path]: response });
    assert.equal((await resolveWalletStatus(owner, now, makeEnv(), transport)).status, 'unavailable');
    assert.equal(calls.length, expectedCount);
  }
});

test('unrecognized balance identity, currency, funds type or malformed amount stays unavailable', async () => {
  for (const changes of [
    { id: 304 },
    { type: 'SAVINGS' },
    { investmentState: 'INVESTED' },
    { investmentState: 'UNKNOWN' },
    { visible: false },
    { currency: 'GBP' },
    { amount: { value: 0, currency: 'GBP' } },
    { amount: { value: -2, currency: 'EUR' } },
    { amount: { value: 0.001, currency: 'EUR' } },
    { amount: { value: 20_000_000_000_000.01, currency: 'EUR' } },
    { amount: { value: '0', currency: 'EUR' } },
  ]) {
    const { transport } = fixtureTransport({ [fixedPaths[2]]: { ...suppliedBalance, ...changes } });
    const result = await resolveWalletStatus(owner, now, makeEnv(), transport);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.balance_minor, null);
  }
});

test('provider deny, throttling or timeout yield the same redacted unavailable response', async () => {
  for (const failure of ['403 provider private body', '429 provider private body', 'timed out with token fixture']) {
    let calls = 0;
    const transport: WiseTransport = async () => {
      calls++;
      throw new Error(failure);
    };
    const result = await resolveWalletStatus(owner, now, makeEnv(), transport);
    assert.deepEqual(result, {
      status: 'unavailable', provider: 'wise', balance_minor: null,
      currency: null, observed_at: null, source: null,
    });
    assert.equal(calls, 1);
  }
});
