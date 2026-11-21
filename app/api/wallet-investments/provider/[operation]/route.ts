import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestHasSameOrigin } from '@/lib/request-origin';
import { readWalletDeposits, readWalletTransactions, walletKyc, wiseAccountHandoff } from '@/lib/investments/wallet-operations.server';
import { getWalletSettings, walletJson } from '@/lib/wallet-investments-server';
import { enrolledWalletCurrencies } from '@/lib/investments/wallet-status.server';
import { walletCurrencyCookie, walletCurrencyPreference } from '@/lib/investments/wallet-currency-cookie.server';

function redirectOwner(location: string) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ operation:string }> }) {
  if (!requestHasSameOrigin(request)) return walletJson({ status:'forbidden' },403);
  const { operation } = await params;
  if (!['currency','deposits','transactions','review','onboarding','transfer','withdrawal'].includes(operation)) return walletJson({status:'unsupported'},404);
  const handoff=operation==='transfer'||operation==='withdrawal';
  const handoffTab=operation==='withdrawal'?'withdraw':'transfer';
  const reviewUnavailable = '/wallet?wallet_review=unavailable';
  try {
    const account=await getSession();
    if (!account) {
      return handoff || operation==='onboarding'
        ? redirectOwner('/login?next='+encodeURIComponent('/wallet?tab='+(handoff?handoffTab:'wise-connection')))
        : walletJson({status:'unauthorized'},401);
    }
    if (operation==='currency') {
      const value=await request.json().catch(()=>null);
      if(typeof value?.currency!=='string'||!enrolledWalletCurrencies(account.id).includes(value.currency))
        return walletJson({status:'invalid_currency'},400);
      const result=walletJson({status:'selected'});
      result.cookies.set(walletCurrencyCookie(account.id),value.currency,{
        httpOnly:true, sameSite:'lax', secure:request.nextUrl.protocol==='https:', path:'/api/wallet-investments',
      });
      return result;
    }
    const profile=await getWalletSettings(account.id);
    const owner={userId:account.id,currency:walletCurrencyPreference(request,account.id) ?? profile?.currency ?? null};
    if (handoff) {
      // This opens Wise. The owner selects the actual account, reviews a quote
      // and confirms there. This endpoint has no payment execution authority.
      return redirectOwner(await wiseAccountHandoff(owner));
    }
    if(operation==='transactions') return walletJson(await readWalletTransactions(owner));
    if (operation==='deposits') {
      const deposits=await readWalletDeposits(owner);
      return deposits ? walletJson({deposits}) : walletJson({status:'unavailable'},503);
    }
    const review=await walletKyc(owner,operation==='onboarding');
    if (!review) return operation==='onboarding' ? redirectOwner(reviewUnavailable) : walletJson({status:'unavailable'},503);
    if (operation==='onboarding') {
      return redirectOwner(review.url ?? '/wallet?tab=wise-connection');
    }
    return walletJson({status:review.status});
  } catch {
    if (handoff) return redirectOwner('/wallet?tab='+handoffTab+'&wallet_transfer=unavailable');
    return operation==='onboarding' ? redirectOwner(reviewUnavailable) : walletJson({status:'unavailable'},503);
  }
}
