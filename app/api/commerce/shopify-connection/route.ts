import {getSession} from '@/lib/auth';
import {walletJson} from '@/lib/wallet-investments-server';
import {readShopifyConnection} from '@/lib/commerce/shopify-connection.server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(){
  const user=await getSession();
  if(!user)return walletJson({status:'unauthorized'},401);
  return walletJson(await readShopifyConnection(user.id));
}
