import {getSession} from '@/lib/auth';
import {readCommerceDashboard} from '@/lib/commerce/commerce.server';
import {commerceRange} from '@/lib/commerce/owner-input';
import {walletJson} from '@/lib/wallet-investments-server';

export async function GET(request:Request) {
  const owner=await getSession();
  if(!owner) return walletJson({status:'unauthorized'},401);
  const range=commerceRange(new URL(request.url).searchParams);
  if(!range) return walletJson({status:'invalid_request'},400);
  try {return walletJson(await readCommerceDashboard(owner.id,range));}
  catch{return walletJson({status:'unavailable'},503);}
}
