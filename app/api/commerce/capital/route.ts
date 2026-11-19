import type {NextRequest} from 'next/server';
import {getSession} from '@/lib/auth';
import {setCommerceCapital} from '@/lib/commerce/commerce.server';
import {capitalInput,readSmallShopBody} from '@/lib/commerce/owner-input';
import {requestHasSameOrigin} from '@/lib/request-origin';
import {walletJson} from '@/lib/wallet-investments-server';

export async function PUT(request:NextRequest) {
  if(!requestHasSameOrigin(request)) return walletJson({status:'forbidden'},403);
  const owner=await getSession();
  if(!owner) return walletJson({status:'unauthorized'},401);
  const input=capitalInput.safeParse(await readSmallShopBody(request));
  if(!input.success) return walletJson({status:'invalid_request'},400);
  try {
    return await setCommerceCapital(owner.id,input.data) ? walletJson({status:'saved'}) : walletJson({status:'blocked'},409);
  }
  catch{return walletJson({status:'unavailable'},503);}
}
