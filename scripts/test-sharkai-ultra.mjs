#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=(file)=>readFileSync(join(root,file),'utf8');

test('The original global agent is mounted exactly once',()=>{
  const layout=read('app/layout.tsx');
  assert.equal((layout.match(/<QuickChatWidget\s*\/>/g)||[]).length,1);
  assert.match(layout,/import '.\/sharkai-ultra\.css';/);
});
test('Wallet keeps original Wise endpoints and authenticated data handling',()=>{
  const data = read('app/wallet/wallet-data.ts');
  assert.match(data, /fetch\('\/api\/wallet-investments'/);
  assert.match(data, /fetch\('\/api\/wallet-investments\/provider\/transactions'/);
  assert.match(data, /isWalletOwnerDashboard/);
  assert.match(data, /status\s*===\s*'verified'/);
  assert.match(data, /displayMinor\(wallet\.balance_minor,\s*wallet\.currency\)/);
});

test('Wallet loads archive artwork and styles within the wallet screen', () => {
  const page = read('app/wallet/page.tsx');
  const css = read('app/wallet/wallet.css');
  assert.ok(page.includes("import './wallet.css'"));
  assert.ok(css.includes('.zip-wallet .desktop-wallet-header'));
  for (const file of ['image-01.png', 'image-02.png', 'image-03.png']) {
    assert.ok(css.includes('/wallet-original/' + file), file);
  }
});

test('Global theme and locked assistant colors stay consistent',()=>{
  const css=read('app/sharkai-ultra.css');
  for(const color of ['#071c39','#073ca2','#6b29d2','#4317a2','#22dcff','#b9ff19']) assert.ok(css.includes(color),color);
  assert.match(css,/shark-chat-message-user/);
  assert.match(css,/shark-chat-message-assistant/);
  assert.match(css,/shark-quick-panel/);
  assert.match(css,/module-workspace\[data-ultra-view="studio"\]/);
});
test('Approved image files are required before production release',()=>{
  const required=[
    'public/sharkai/wallet/coast-day.webp',
    'public/sharkai/wallet/ice-fullbleed.webp',
    'public/sharkai/wallet/euro-cash.webp',
    'public/sharkai/wallet/transactions.webp',
    'public/sharkai/wallet/investments.webp',
    'public/sharkai/chat/shark-avatar.webp',
    'public/sharkai/chat/approved-coast.webp',
    'public/sharkai/chat/approved-wave-header.webp',
  ];
  const missing=required.filter(p=>!existsSync(join(root,p)));
  if(process.env.SHARKAI_REQUIRE_LOCKED_ASSETS==='1')
    assert.deepEqual(missing,[],'Missing original approved WebP images: '+missing.join(', '));
  else if(missing.length)
    console.warn('PRE-PRODUCTION: '+missing.length+' original assets must be installed from approved ZIP');
});