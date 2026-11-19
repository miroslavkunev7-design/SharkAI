import {isReferencePeriod,readEuroReference} from '@/lib/investments/ecb-euro-reference';

export async function GET(request:Request) {
  const params=new URL(request.url).searchParams;
  const value=params.get('period')??'';
  if(!isReferencePeriod(value)||params.size!==1) return Response.json({status:'invalid_request'},{status:400});
  const result=await readEuroReference(value);
  return Response.json(result,{headers:{'Cache-Control':result.status==='available'?'public, s-maxage=900':'no-store'}});
}
