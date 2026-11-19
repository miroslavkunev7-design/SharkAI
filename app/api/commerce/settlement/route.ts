import type {NextRequest} from 'next/server';
import {getSession} from '@/lib/auth';
import {readSmallShopBody,supportedStoreCurrency} from '@/lib/commerce/owner-input';
import {allocateResaleProfit,profitAllocation,readResaleSettlement,setWeeklyTarget,weeklyTarget} from '@/lib/commerce/resale-settlement.server';
import {requestHasSameOrigin} from '@/lib/request-origin';
import {walletJson} from '@/lib/wallet-investments-server';

export async function GET(request:Request) {
  const owner=await getSession();
  if(!owner) return walletJson({status:'unauthorized'},401);
  const params=new URL(request.url).searchParams;
  const currency=supportedStoreCurrency.safeParse(params.get('currency')??'EUR');
  if(!currency.success||params.getAll('currency').length>1) return walletJson({status:'invalid_request'},400);
  try { return walletJson(await readResaleSettlement(owner.id,currency.data)); }
  catch { return walletJson({status:'unavailable'},503); }
}
async function change(request:NextRequest) {
  if(!requestHasSameOrigin(request)) return walletJson({status:'forbidden'},403);
  const owner=await getSession();
  if(!owner) return walletJson({status:'unauthorized'},401);
  const schema=request.method==='PUT'?weeklyTarget:profitAllocation;
  const input=schema.safeParse(await readSmallShopBody(request));
  if(!input.success) return walletJson({status:'invalid_request'},400);
  try {
    const saved=input.data.action==='target'?await setWeeklyTarget(owner.id,input.data):await allocateResaleProfit(owner.id,input.data);
    return saved?walletJson({status:'saved'}):walletJson({status:'blocked'},409);
  } catch {return walletJson({status:'unavailable'},503);}
}
export {change as PUT,change as POST};
