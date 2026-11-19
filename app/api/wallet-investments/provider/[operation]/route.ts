import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { readWalletDeposits, readWalletTransactions, walletKyc } from '@/lib/investments/wallet-operations.server';
import { getWalletSettings, walletJson } from '@/lib/wallet-investments-server';

export async function POST(request: NextRequest, { params }: { params: Promise<{ operation:string }> }) {
  if (!requestHasSameOrigin(request)) return walletJson({ status:'forbidden' },403);
  const { operation } = await params;
  if (!['deposits','transactions','review','onboarding'].includes(operation)) return walletJson({status:'unsupported'},404);
  const reviewRedirect = () => new Response(null,{ status:303, headers:{
<<<<<<< HEAD
    Location:'/dashboard?view=investments&panel=account&section=manage&wallet_review=unavailable', 'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer',
=======
    Location:'/wallet?wallet_review=unavailable', 'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer',
>>>>>>> 7d7cfed (Publish standalone Shark wallet and source-backed period forecasts)
  } });
  try {
    const account=await getSession();
    if (!account) return walletJson({status:'unauthorized'},401);
    const profile=await getWalletSettings(account.id);
    const owner={userId:account.id,currency:profile?.currency ?? null};
    if(operation==='transactions') return walletJson(await readWalletTransactions(owner));
    if (operation==='deposits') {
      const deposits=await readWalletDeposits(owner);
      return deposits ? walletJson({deposits}) : walletJson({status:'unavailable'},503);
    }
    const review=await walletKyc(owner,operation==='onboarding');
    if (!review) return operation==='onboarding' ? reviewRedirect() : walletJson({status:'unavailable'},503);
    if (operation==='onboarding') {
      if (!review.url) return reviewRedirect();
      return new Response(null,{ status:303, headers:{
        'Location':review.url,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer',
      } });
    }
    return walletJson({status:review.status});
  } catch { return operation==='onboarding' ? reviewRedirect() : walletJson({status:'unavailable'},503); }
}
