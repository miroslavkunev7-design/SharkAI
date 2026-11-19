import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { walletSettingsBody } from '@/lib/wallet-investments-contract';
import { getWalletSettings, updateWalletSettings, walletDashboard, walletJson, withBrokerOwnerActivity } from '@/lib/wallet-investments-server';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return walletJson({ status: 'unauthorized' }, 401);
    const dashboard = await walletDashboard(await getWalletSettings(session.id), session);
    return walletJson(await withBrokerOwnerActivity(dashboard, session.id));
  } catch {
    return walletJson({ status: 'unavailable' }, 503);
  }
}

export async function PUT(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return walletJson({ status: 'forbidden' }, 403);
  try {
    const session = await getSession();
    if (!session) return walletJson({ status: 'unauthorized' }, 401);
    const body = walletSettingsBody.safeParse(await request.json().catch(() => null));
    if (!body.success) return walletJson({ status: 'invalid_request' }, 400);
    const dashboard = await updateWalletSettings(session, body.data);
    return walletJson(await withBrokerOwnerActivity(dashboard, session.id));
  } catch {
    return walletJson({ status: 'unavailable' }, 503);
  }
}
