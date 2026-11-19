import type {NextRequest} from 'next/server';
import {getSession} from '@/lib/auth';
import {reviewCommerceFulfillment,confirmCommerceFulfillment} from '@/lib/commerce/commerce.server';
import {fulfillmentInput,readSmallShopBody} from '@/lib/commerce/owner-input';
import {requestHasSameOrigin} from '@/lib/request-origin';
import {walletJson} from '@/lib/wallet-investments-server';

export async function POST(request:NextRequest) {
  if(!requestHasSameOrigin(request)) return walletJson({status:'forbidden'},403);
  const owner=await getSession();
  if(!owner) return walletJson({status:'unauthorized'},401);
  const body=fulfillmentInput.safeParse(await readSmallShopBody(request));
  if(!body.success) return walletJson({status:'invalid_request'},400);
  try {
    const result=body.data.action==='confirm' ? await confirmCommerceFulfillment(owner.id,body.data.order_ref,body.data.review_id)
      : await reviewCommerceFulfillment(owner.id,body.data.order_ref);
    return walletJson(result);
  } catch{return walletJson({status:'unavailable'},503);}
}
