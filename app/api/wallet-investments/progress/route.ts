import {getSession} from '@/lib/auth';
import {walletJson} from '@/lib/wallet-investments-server';
import {readInvestmentProgress} from '@/lib/investments/investment-progress.server';
import {z} from 'zod';
export const runtime='nodejs';
export async function GET(request:Request){
  const user=await getSession();
  if(!user)return walletJson({status:'unauthorized'},401);
  const params=new URL(request.url).searchParams,start=params.get('start');
  if([...params.keys()].some(k=>k!=='start')||params.getAll('start').length>1||(start!==null&&!z.string().date().safeParse(start).success)){
    return walletJson({status:'invalid_request'},400);
  }
  return walletJson(await readInvestmentProgress(user.id,start));
}
