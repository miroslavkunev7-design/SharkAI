#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
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

test('every registered section photo resolves to its own WebP asset', () => {
  const css = file('app/site-scenes.css');
  const directory = resolve('public/sharkai/scenes');
  const registered = new Set(['landscape']);
  for (const [, scene, asset] of css.matchAll(/\[data-scene="([\w-]+)"\]\s*\{\s*--scene-image:\s*url\('\/sharkai\/scenes\/([\w-]+)\.webp'\)/g)) {
    assert.equal(asset, scene);
    assert.ok(!registered.has(scene), scene);
    registered.add(scene);
  }
  const files = readdirSync(directory).filter(name => name.endsWith('.webp'));
  assert.deepEqual(files.sort(), [...registered].map(name => `${name}.webp`).sort());
  for (const name of files) {
    const bytes = readFileSync(resolve(directory, name));
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', name);
  }
});


test('Every premium module uses the same half-glacier and half-photo surface', () => {
  const css = file('app/site-scenes.css');
  const surface = css.split('/* ULTRA 50/50 scene surfaces */')[1];
  assert.ok(surface, 'The shared 50/50 surface system must exist');
  assert.match(surface, /--glacier-split:\s*50%/);
  assert.match(surface, /var\(--glacier-split\)/);
  assert.match(surface, /url\('\/sharkai\/ice-surface\.webp'\)/);
  assert.match(surface, /var\(--scene-image\)/);
  for (const section of [
    '.module-banner', '.module-panel', '.module-tile', '.module-metric',
    '.shark-launch-hero', '.shark-launch-summary > a',
    '.shark-entry-feature', '.shark-entry-plan', '.operator-panel',
    '.pf-home-hero', '.commerce-candidate', '.investment-idea',
  ]) assert.ok(surface.includes(section), 'Missing glacier artwork on '+ section);
  assert.match(surface, /\[data-scene-tone="light"\]/);
  assert.match(surface, /prefers-reduced-motion/);
});


test('The app shell repeats the midnight sapphire and violet header palette', () => {
  const css = file('app/site-scenes.css');
  const shell = css.split('/* ULTRA midnight shell and navigation */')[1];
  assert.ok(shell, 'A shared dark premium shell is required');
  assert.match(shell, /site-daylight::after/);
  assert.match(shell, /module-sidebar\.ice-section/);
  assert.match(shell, /module-topbar\[data-scene\]/);
  assert.match(shell, /shark-admin-topbar\[data-scene\]/);
  assert.match(shell, /#071739/);
});
