#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
const router = await import('../app/wallet/wallet-routes.ts');
const data = await import('../app/wallet/wallet-data.ts');
const {readWalletRoute, walletUrl, walletLogin, walletTitles} = router.default ?? router;
const {accountBalance} = data.default ?? data;

test('Payments, crypto, currencies and search have distinct, shareable destinations', () => {
  for (const tab of ['payments','crypto','currencies','search','transactions','cards','details','settings','forecast']) {
    const url = new URL(walletUrl(tab), 'https://shark.invalid');
    assert.equal(readWalletRoute(url.searchParams.get('tab')), tab);
    assert.equal(new URL(walletLogin(tab), url).searchParams.get('next'), url.pathname + url.search);
  }
  assert.equal(readWalletRoute('invest'), 'investments');
  for (const invalid of ['toString', '__proto__', ['payments','crypto'], null]) {
    assert.equal(readWalletRoute(invalid), 'overview');
  }
  assert.equal(Object.keys(walletTitles).filter(route => readWalletRoute(route) !== route).length, 0);
});

test('Only a provider-confirmed zero appears as a zero balance', () => {
  const owner = (status, balance_minor) => ({state:'ready',data:{wallet:{status,currency:'EUR',balance_minor}}});
  for (const state of ['loading','guest','unavailable']) assert.equal(accountBalance({state,data:null}), '—');
  for (const status of ['provider_unlinked','stale','unavailable']) assert.equal(accountBalance(owner(status, '12345')), '—');
  assert.equal(accountBalance(owner('verified',null)), '—');
  assert.match(accountBalance(owner('verified','0')), /^0[,.]00$/);
  assert.match(accountBalance(owner('verified','12345')), /^123[,.]45$/);
});
