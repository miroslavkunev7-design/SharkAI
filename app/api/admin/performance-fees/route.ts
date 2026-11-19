import {getSession} from '@/lib/auth';
import {adminFeePeriod,readAdministratorFeeReceipts} from '@/lib/investments/performance-fee.server';

export async function GET(request:Request) {
  const headers={'Cache-Control':'private, no-store'};
  const owner=await getSession();
  if(!owner || owner.role!=='ADMIN') return Response.json({status:'forbidden'},{status:403,headers});
  const range=adminFeePeriod(new URL(request.url).searchParams);
  if(!range) return Response.json({status:'invalid_period'},{status:400,headers});
  try {return Response.json(await readAdministratorFeeReceipts(owner.id,range),{headers});}
  catch {return Response.json({status:'unavailable'},{status:503,headers});}
}
