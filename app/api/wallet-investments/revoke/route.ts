import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { revokeWalletAccess, walletJson, withBrokerOwnerActivity } from '@/lib/wallet-investments-server';
import { walletCurrencyPreference } from '@/lib/investments/wallet-currency-cookie.server';

export async function POST(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return walletJson({ status: 'forbidden' }, 403);
  try {
    const session = await getSession();
    if (!session) return walletJson({ status: 'unauthorized' }, 401);
    const currency=walletCurrencyPreference(request,session.id);
    const dashboard = await revokeWalletAccess(session,undefined,currency);
    return walletJson(await withBrokerOwnerActivity(dashboard, session.id,currency));
  } catch {
    return walletJson({ status: 'unavailable' }, 503);
  }
}
