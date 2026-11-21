import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

// This cookie selects a display currency. The binding and Wise user identity
// are independently verified by the server for every provider request.
export function walletCurrencyCookie(userId:string) {
  return 'shark_wallet_ccy_'+createHash('sha256').update(userId).digest('hex').slice(0,32);
}

export function walletCurrencyPreference(request:NextRequest, userId:string) {
  const value=request.cookies.get(walletCurrencyCookie(userId))?.value;
  return value && /^[A-Z]{3}$/.test(value) ? value : undefined;
}
