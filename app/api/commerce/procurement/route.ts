import type {NextRequest} from 'next/server';
import {getSession} from '@/lib/auth';
import {requestHasSameOrigin} from '@/lib/request-origin';
import {walletJson} from '@/lib/wallet-investments-server';
import {readSmallShopBody} from '@/lib/commerce/owner-input';
import {readProcurement,submitProcurement} from '@/lib/commerce/procurement.server';
export const runtime='nodejs';
export async function GET(){
 const user=await getSession();if(!user)return walletJson({status:'unauthorized'},401);
 try{return walletJson(await readProcurement(user.id));}catch{return walletJson({status:'unavailable'},503);}
}
export async function POST(req:NextRequest){
 if(!requestHasSameOrigin(req))return walletJson({status:'forbidden'},403);
 const user=await getSession();if(!user)return walletJson({status:'unauthorized'},401);
 try {const output=await submitProcurement(user.id,await readSmallShopBody(req));return walletJson(output,output.status==='invalid'?400:200);}
 catch{return walletJson({status:'unavailable'},503);}
}
