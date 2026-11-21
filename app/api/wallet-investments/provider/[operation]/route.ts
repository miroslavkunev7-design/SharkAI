import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { readWalletDeposits, readWalletTransactions, walletKyc } from '@/lib/investments/wallet-operations.server';
import { getWalletSettings, walletJson } from '@/lib/wallet-investments-server';

function redirectOwner(location: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ operation:string }> }) {
  if (!requestHasSameOrigin(request)) return walletJson({ status:'forbidden' },403);
  const { operation } = await params;
  if (!['deposits','transactions','review','onboarding','transfer'].includes(operation)) return walletJson({status:'unsupported'},404);
  const reviewUnavailable = '/wallet?wallet_review=unavailable';
  try {
    const account=await getSession();
    if (!account) {
      return operation === 'transfer' ? redirectOwner('/login?next=%2Fwallet') : walletJson({status:'unauthorized'},401);
    }
    // Wise collects the recipient, quotes the payment and confirms it with the account holder.
    if (operation === 'transfer') return redirectOwner('https://wise.com/home/');
    const profile=await getWalletSettings(account.id);
    const owner={userId:account.id,currency:profile?.currency ?? null};
    if(operation==='transactions') return walletJson(await readWalletTransactions(owner));
    if (operation==='deposits') {
      const deposits=await readWalletDeposits(owner);
      return deposits ? walletJson({deposits}) : walletJson({status:'unavailable'},503);
    }
    const review=await walletKyc(owner,operation==='onboarding');
    if (!review) return operation==='onboarding' ? redirectOwner(reviewUnavailable) : walletJson({status:'unavailable'},503);
    if (operation==='onboarding') {
      return redirectOwner(review.url ?? reviewUnavailable);
    }
    return walletJson({status:review.status});
  } catch {
    if (operation === 'transfer') return redirectOwner('/wallet?wallet_transfer=unavailable');
    return operation==='onboarding' ? redirectOwner(reviewUnavailable) : walletJson({status:'unavailable'},503);
  }
}
