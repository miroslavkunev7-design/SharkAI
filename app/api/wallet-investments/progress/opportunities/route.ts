import {getSession} from '@/lib/auth';
import {walletJson} from '@/lib/wallet-investments-server';
import {currencyMinorDigits} from '@/lib/wallet-investments-contract';
import {readOpportunities} from '@/lib/investments/investment-progress-opportunities.server';
export const runtime='nodejs';
export async function GET(req:Request){
  const user=await getSession();
  if(!user)return walletJson({status:'unauthorized'},401);
  const params=new URL(req.url).searchParams,code=params.get('currency'),days=params.get('days')??'7';
  if([...params.keys()].some(k=>!['days','currency'].includes(k))||params.getAll('days').length>1||params.getAll('currency').length>1||
    !['1','7','14','21','28'].includes(days)||(code!==null&&currencyMinorDigits(code)===null))return walletJson({status:'invalid_request'},400);
  try{return walletJson(await readOpportunities(user.id,code??undefined,Number(days)));}
  catch{return walletJson({status:'unavailable'},503);}
}
