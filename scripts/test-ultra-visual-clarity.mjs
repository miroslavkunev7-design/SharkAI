#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

const file=(name)=>readFileSync(resolve(process.cwd(),name),'utf8');

test('desktop header mascot resolves to already approved transparent asset',()=>{
  const component=file('app/wallet/wallet-home.tsx');
  assert.match(component,/className="sw-header-muscular-shark" src="\/sharkai\/chat\/shark-avatar\.webp"/);
  assert.ok(existsSync(resolve('public/sharkai/chat/shark-avatar.webp')),'Original mascot asset must exist');
});

test('mobile header hides textual wordmark nodes without hiding the accessible logo image',()=>{
  const css=file('app/wallet/wallet-premium-layout.css');
  assert.match(css,/@media\(max-width:699px\)[\s\S]*?\.sw-wordmark\s*\{[^}]*font-size\s*:\s*0(?:px|rem)?\s*!important/);
  assert.match(css,/\.sw-header-avatar\s*\{[^}]*display:block/);
});

test('full-size chat reuses the approved coastal art and glowing wave header',()=>{
  const css=file('app/sharkai-ultra.css');
  assert.match(css,/\.shark-chat-shell \.shark-chat-workspace::before/);
  assert.ok(css.includes('/sharkai/chat/approved-coast.webp'));
  assert.match(css,/\.shark-chat-shell \.shark-chat-topbar\s*\{/);
  assert.ok(css.includes('/sharkai/chat/approved-wave-header.webp'));
});
