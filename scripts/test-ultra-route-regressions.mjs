#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const wallet=readFileSync('app/wallet/wallet-home.tsx','utf8');
const page=readFileSync('app/wallet/page.tsx','utf8');

test('mobile Payments goes to its own safe Wise operations screen',()=>{
  assert.match(wallet,/section==='payments'/);
  assert.match(page,/tab==='payments'/);
  assert.match(wallet,/href=\{tabLink\('payments'\)\}/);
  assert.match(wallet,/Плащания чрез Wise/);
  assert.match(wallet,/Продължи в Wise/);
});
test('mobile Crypto does not masquerade as EUR/GBP currencies screen',()=>{
  assert.match(wallet,/section==='crypto'/);
  assert.match(page,/tab==='crypto'/);
  assert.match(wallet,/href=\{tabLink\('crypto'\)\}/);
  assert.match(wallet,/Крипто справка/);
});
test('Search opens a real filter for existing authorized transactions',()=>{
  assert.match(wallet,/type="search"/);
  assert.match(wallet,/Търси в движенията/);
  assert.match(wallet,/\.filter\(row=>/);
  assert.match(wallet,/Няма движения по зададеното търсене/);
});
