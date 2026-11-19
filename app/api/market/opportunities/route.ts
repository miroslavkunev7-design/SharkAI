import {readPublicOpportunities} from '@/lib/investments/market-opportunities.public';

export const runtime='nodejs';
export async function GET(request:Request){
  const params=new URL(request.url).searchParams,days=params.get('days')??'7';
  if([...params.keys()].some(k=>k!=='days')||params.getAll('days').length>1||!['1','7','14','21','28'].includes(days)){
    return Response.json({status:'invalid_request'},{status:400,headers:{'Cache-Control':'no-store'}});
  }
  const data=await readPublicOpportunities(Number(days));
  return Response.json(data,{headers:{'Cache-Control':data.briefs.length?'public, s-maxage=900':'no-store'}});
}
