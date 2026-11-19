import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { issueWalletStatusGrant } from '@/lib/wallet-investments-grants';
import { walletJson } from '@/lib/wallet-investments-server';

export async function POST(request: NextRequest) {
  if (!requestHasSameOrigin(request)) return walletJson({ status: 'forbidden' }, 403);
  try {
    const session = await getSession();
    if (!session) return walletJson({ status: 'unauthorized' }, 401);
    return await issueWalletStatusGrant(session.id);
  } catch {
    return walletJson({ status: 'unavailable' }, 503);
  }
}
