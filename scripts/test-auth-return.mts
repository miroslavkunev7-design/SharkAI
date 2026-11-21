import assert from 'node:assert/strict';
import { consumeQuickChat, rememberQuickChat, safeReturnPath } from '../lib/auth-return';

for (const target of ['/', '/wallet?tab=wise-connection', '/wallet?tab=asset&kind=invest&pair=AAPL#details',
  '/wallet?tab=account-new', '/chat?conversationId=own-thread', '/dashboard?view=studio', '/pricing', '/admin', '/download',
  '/tests', '/#features']) {
  const login = new URL('/login?next=' + encodeURIComponent(target) + '&quickChat=1', 'https://test.invalid');
  assert.equal(safeReturnPath(login.searchParams.get('next')), target);
}
for (const value of [null, '', '//example.com', 'https://example.com', '/\\example.com', '/api/auth/logout', '/login?next=/login',
  '/%2fexample.com', '/wallet\n', '/unknown']) {
  assert.equal(safeReturnPath(value), null);
}
const items = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => items.set(key, value),
  removeItem: (key: string) => items.delete(key),
} });
const destination = '/wallet?tab=payments#actions';
rememberQuickChat(destination);
assert.equal(consumeQuickChat('/chat'), false);
assert.equal(consumeQuickChat(destination), true);
assert.equal(consumeQuickChat(destination), false);
console.log('Safe login round trips and one-time compact chat return passed.');
