#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

const file=(name)=>readFileSync(resolve(process.cwd(),name),'utf8');

test('Wallet uses the supplied header and fonts in mobile and desktop layouts', () => {
  const css=file('app/wallet/wallet.css');
  assert.match(css, /@media\s*\(min-width:\s*1024px\)/);
  for (const name of ['original-font-1.ttf', 'original-font-2.ttf', 'reference-avatar.png']) {
    assert.ok(existsSync(resolve('public/wallet-original', name)), name);
  }
});

test('Floating chat uses its original portrait and scene on every page with the global launcher', () => {
  const css=file('app/quick-chat.css');
  const widget=file('app/quick-chat-widget.tsx');
  assert.match(css, /\/wallet-original\/image-09\.png/);
  assert.match(css + widget, /\/wallet-original\/image-22\.png/);
  assert.ok(widget.includes("import('./chat/chat-workspace')"));
});

test('full-size chat reuses the approved coastal art and glowing wave header',()=>{
  const css=file('app/sharkai-ultra.css');
  assert.match(css,/\.shark-chat-shell \.shark-chat-workspace::before/);
  assert.ok(css.includes('/sharkai/chat/approved-coast.webp'));
  assert.match(css,/\.shark-chat-shell \.shark-chat-topbar\s*\{/);
  assert.ok(css.includes('/sharkai/chat/approved-wave-header.webp'));
});
