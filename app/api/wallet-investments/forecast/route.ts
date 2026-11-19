import type {NextRequest} from 'next/server';
import {getSession} from '@/lib/auth';
import {requestHasSameOrigin} from '@/lib/request-origin';
import {walletJson} from '@/lib/wallet-investments-server';
import {readSmallShopBody} from '@/lib/commerce/owner-input';
import {forecastQuoteRequest,quoteInvestment} from '@/lib/investments/forecast-quote.server';
export const runtime='nodejs';
export async function POST(req:NextRequest){
  if(!requestHasSameOrigin(req))return walletJson({status:'forbidden'},403);
  try{
    const user=await getSession();
    if(!user)return walletJson({status:'unauthorized'},401);
    const parsed=forecastQuoteRequest.safeParse(await readSmallShopBody(req));
    if(!parsed.success)return walletJson({status:'invalid_request'},400);
    return walletJson(await quoteInvestment(user.id,parsed.data));
  }catch{return walletJson({status:'unavailable'},503);}
}
